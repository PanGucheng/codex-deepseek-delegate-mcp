# Codex DeepSeek Delegate MCP

这是一个本地 Codex MCP 服务。它让 Codex 使用 `gpt-5.5` 作为 primary planner，再通过 OpenCode 风格的 Task/Subagent 工具把探索或实现任务委托给 Claude Agent SDK，并由 DeepSeek 的 Anthropic 兼容接口提供模型能力。

## 功能概览

- MCP 工具：`delegate_task`，兼容工具：`delegate_execute`
- 运行时：TypeScript + Node.js 18+
- 执行器：`@anthropic-ai/claude-agent-sdk`
- 模型供应商映射：`DEEPSEEK_API_KEY` 会映射到 `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`
- 任务交接：写入 `.delegate/sessions/<sessionId>/assignment.md`，DeepSeek child session 先读取本地任务文件再执行
- 会话日志：写入 `.delegate/sessions/<sessionId>/request.json`、`assignment.md`、`events.jsonl` 和 `result.json`
- 任务 registry：写入 `.delegate/tasks.json`，用 `taskId` 恢复同一个 DeepSeek child session
- 安全策略：限制 `cwd`、支持 `allowedPaths`、按 subagent 绑定权限、日志不会记录 API key

## 安装与构建

```bash
git clone https://github.com/PanGucheng/codex-deepseek-delegate-mcp.git
cd codex-deepseek-delegate-mcp
npm install
npm run build
npm test
```

常用脚本：

- `npm run dev`：直接用 `tsx` 启动源码版 MCP 服务
- `npm run build`：清理并编译到 `dist/`
- `npm run typecheck`：只做 TypeScript 类型检查
- `npm test`：运行单元测试和 MCP 集成测试

## Codex 配置

如果在本仓库内使用，项目已经包含 `.codex/config.toml`，用于让 Codex 加载本地 MCP 服务：

```toml
model = "gpt-5.5"

[mcp_servers.deepseek_delegate]
command = "node"
args = ["dist/index.js"]
cwd = "."
env_vars = ["DEEPSEEK_API_KEY"]
startup_timeout_sec = 20
tool_timeout_sec = 1800
default_tools_approval_mode = "prompt"
```

更推荐把它注册为用户级全局 MCP：把下面这段加入 `~/.codex/config.toml`，并把路径替换为你克隆本仓库的位置。`cwd` 可以保持为 MCP 的安装目录；真正的目标项目目录由每次 `delegate_task.cwd` 决定，或在调用方没有传 `cwd` 时由 MCP `roots/list` 自动推断。

```toml
[mcp_servers.deepseek_delegate]
command = "node"
args = ["D:/path/to/codex-deepseek-delegate-mcp/dist/index.js"]
cwd = "D:/path/to/codex-deepseek-delegate-mcp"
env_vars = ["DEEPSEEK_API_KEY"]
startup_timeout_sec = 20
tool_timeout_sec = 1800
default_tools_approval_mode = "prompt"
```

全局使用时不要把 `DEEPSEEK_DELEGATE_WORKSPACE_ROOT` 设置为 MCP 安装目录，否则目标项目会被安全策略挡在工作区外。只有当你想把所有任务限制在某个大目录下，例如 `D:/projects`，才把 `DEEPSEEK_DELEGATE_WORKSPACE_ROOT` 加入 `env_vars` 并在启动 Codex 前设置它。

启动 Codex 前先设置 DeepSeek API key：

```powershell
$env:DEEPSEEK_API_KEY = "..."
```

开发时如果不想发起真实模型调用，可以启用 mock runner：

```powershell
$env:DEEPSEEK_DELEGATE_MOCK = "1"
npm run dev
```

## MCP 工具输入

优先使用 `delegate_task`。它接收以下参数：

- `subagentType`：`repo-scout` 或 `implementer`
- `description`：简短任务名
- `prompt`：完整任务说明
- `cwd`：目标工作目录。全局安装时应传目标项目的绝对路径；如果未设置 `DEEPSEEK_DELEGATE_WORKSPACE_ROOT`，该 `cwd` 会作为本次任务的 workspace root
- `allowedPaths`：可选写入范围白名单，路径必须位于 `cwd` 下，支持简单 `/**` 后缀
- `contextFiles`：可选只读上下文文件，按 workspace root 解析，可用于 monorepo 的 `AGENTS.md`
- `approvedCommands`：可选；Codex 在派发任务前已经批准的精确灰区 Bash 命令。只做完全字符串匹配，不能覆盖硬危险命令
- `taskId`：可选；传入时恢复同一个 child session，不传时创建 fresh child task
- `maxTurns`：执行器最大轮次，默认 `12`
- `runVerification`：是否要求执行器运行安全的验证命令

调用后，服务会把完整任务写成本地任务单：

```text
.delegate/sessions/<sessionId>/assignment.md
```

DeepSeek worker 收到的 prompt 只包含任务单路径、`cwd`、subagent 类型和权限摘要；完整任务以文件为准，而不是作为大段聊天上下文直接塞给 worker。本轮任务单会明确覆盖旧任务指令，避免恢复同一 `taskId` 时误执行上一轮目标。

`delegate_execute` 仍可用，但只是兼容包装：它会把旧的 `task`、`plan`、`allowedFiles` 映射为 `delegate_task(subagentType="implementer")`。新集成应使用 `delegate_task`。

返回结果包含：

- `taskId`：child task 标识；返工时传回这个值以恢复同一 DeepSeek child session
- `subagentType`：实际使用的 subagent 类型
- `status`：`completed`、`blocked` 或 `failed`
- `summary`：执行摘要
- `changedFiles`：检测到变化的文件
- `tests`：识别到的测试/验证命令

MCP 返回给 Codex 的是精简公开结果，不包含 `commandsRun`、`sessionId` 或 `logPath`。这些信息只写入本地 `.delegate/sessions/<sessionId>/`，用于人工排查，不让 Codex 自动读取 worker 中间过程。

## 安全策略

权限跟 subagent 绑定：

- `repo-scout`：只允许 `Read`、`LS`、`Grep`、`Glob`，不能编辑文件，不能使用 Bash
- `implementer`：允许 `Read`、`Edit`、`MultiEdit`、`Write`、`LS`、`Grep`、`Glob`、`TodoWrite`，Bash 走策略网关
- 所有 subagent 都不能再调用 Task/subagent，v1 深度固定为 1

对 `implementer` 来说，文件写入是常规能力：`Edit`、`Write`、`MultiEdit` 会在授权范围内自动通过。Bash 工具也可用，策略分为三层：

1. 低危命令和可解析、路径受限的文件写入自动通过。
2. 硬危险命令本地拒绝，不能被审批覆盖。
3. 其他灰区命令优先通过 MCP `sampling/createMessage` 请求当前 Codex 客户端给出 allow/deny 决策；批准后 DeepSeek 在同一个 child session 里继续执行该命令。
4. 如果当前 Codex 客户端不支持 server-to-client sampling，可以在 `delegate_task.approvedCommands` 里传入 Codex 已经明确批准的精确命令作为降级方案。

默认允许：

- 只读命令，例如 `git status`、`git diff`、`rg`
- 常见测试和构建命令，例如 `npm test`、`npm run build`、`npm run typecheck`、`vitest`
- 针对测试文件的最小 Node 执行，例如 `node math.test.js`
- 原生文件写入工具：`Edit`、`Write`、`MultiEdit`
- 可解析的 Bash 写文件命令，例如 `echo ... > file`、`printf ... > file`、`Set-Content -LiteralPath file ...`、`node -e fs.writeFileSync("file", ...)`

需要 Codex 审批的灰区示例：

- 新增依赖，例如 `npm install <package>`
- 运行项目脚本以外的自定义命令
- 非测试入口的脚本执行

默认拒绝：

- `rm -rf`
- `Remove-Item -Recurse`
- `git reset`
- `git clean`
- `git push`
- 全局配置修改
- 下载脚本并立即执行的命令
- 写出 `cwd` 或 `allowedPaths` 范围
- 目标文件无法解析的复杂重定向
- 未在 allowlist 中的任意命令

如果灰区命令被 Codex/客户端拒绝，DeepSeek 会收到本次工具调用被拒绝的结果，并可以在同一个任务里选择更安全的替代方案。只有硬危险命令或最终无法继续的权限失败才会让任务返回 `blocked`；详细命令记录保存在本地会话日志。

审批请求只包含单条命令、`cwd`、`allowedPaths`、任务摘要和本地策略原因；MCP 服务本身不会持有或调用 OpenAI API，也不需要 OpenAI key。具体 allow/deny 判断由当前 Codex 客户端通过 MCP sampling 完成。

注意：当前部分 Codex 客户端不会向 MCP server 暴露 `sampling/createMessage`。这种情况下交互式灰区审批会返回明确的 `interactive command approval is unavailable`，而不会弹窗。需要提前允许某条命令时，让 Codex 把完整命令放入 `approvedCommands`，例如：

```json
{
  "approvedCommands": [
    "npm install left-pad --package-lock-only --ignore-scripts"
  ]
}
```

任务单文件和 `contextFiles` 是只读元数据例外：即使设置了 `allowedPaths`，worker 仍可读取它们，但不能编辑。

## Codex 侧预提示词

当前针对 Codex 的预提示词来自 MCP server 的 `instructions`、`delegate_task` 和兼容 `delegate_execute` 工具描述。它会告诉 Codex：

- 简单 Read、Grep、单命令检查不要启动 subagent
- 多文件、多步骤、需要独立探索或实现时才调用 `delegate_task`
- 先用 `repo-scout` 做只读探索，再用 `implementer` 做代码修改
- 在工具输入里传入完整任务包
- 服务端会把任务写入本地 `assignment.md`
- Codex 只审查最终工具结果和文件变化，不读取 worker 的中间执行 transcript
- 需要继续同一子任务返工时传回上次 `taskId`

DeepSeek worker 另有独立 prompt，只负责读取 `assignment.md` 并执行任务。

## 对话生命周期

当前策略是 OpenCode 风格 child session：

- 不传 `taskId`：创建 fresh child session
- 传入已有 `taskId`：通过 Claude Agent SDK `resume` 恢复同一个 child session
- 传入未知 `taskId`：返回 `blocked`

task registry 保存在：

```text
.delegate/tasks.json
```

每次调用都会创建新的本地审计 session 目录和新的 `assignment.md`。是否恢复 DeepSeek child session 只由 `taskId` 决定；不再按 `cwd + model` 自动复用，避免跨任务上下文污染。权限层会按当前 `allowedPaths` 重新校验，不信任旧对话里残留的写入范围。

## Codex 验收提示词

全局安装后，可以新开一个 Codex 对话并复制下面的提示词做真实验收。它只使用临时目录作为 `cwd`，不会修改当前项目文件。

```text
请测试我全局安装的 MCP server：deepseek_delegate。

目标：验证 delegate_task 的两个关键能力，不要修改当前项目文件。请全程使用临时目录作为 cwd。

步骤：
1. 创建一个临时 fixture 目录，包含：
   - package.json，内容为 {"type":"module"}
   - math.js，内容为错误实现：export function add(a, b) { return a - b; }
   - math.test.js，使用 node assert 验证 add(2,3)=5，并成功时输出 ok

2. 调用 deepseek_delegate.delegate_task：
   - subagentType: "implementer"
   - cwd: 临时 fixture 目录的绝对路径
   - allowedPaths: ["math.js"]
   - contextFiles: ["package.json"]
   - maxTurns: 1
   - runVerification: false
   - prompt: 让 DeepSeek 修复 math.js，但故意给很低 maxTurns，测试失败任务是否仍能 resume

3. 记录第一次返回：
   - status
   - taskId
   - changedFiles
   - 如果 status=failed，也继续下一步

4. 用同一个 taskId 再次调用 delegate_task：
   - subagentType: "implementer"
   - cwd: 同一个临时 fixture 目录
   - allowedPaths: ["math.js"]
   - contextFiles: ["package.json"]
   - maxTurns: 6
   - runVerification: false
   - prompt: 继续同一任务，修复 math.js，不要运行 shell 命令

5. 验证：
   - 第二次不应返回 “taskId was not found in .delegate/tasks.json”
   - math.js 应该被修复为加法
   - 在 Codex 侧运行 node math.test.js 验证通过

6. 再创建一个新的临时目录测试 approvedCommands：
   - package.json: {"type":"module"}
   - 调用 delegate_task：
     - subagentType: "implementer"
     - cwd: 临时目录
     - allowedPaths: ["package.json", "package-lock.json"]
     - approvedCommands: ["npm install left-pad --package-lock-only --ignore-scripts"]
     - maxTurns: 8
     - runVerification: true
     - prompt: 让 DeepSeek 只运行 npm install left-pad --package-lock-only --ignore-scripts，并报告 package-lock.json 是否存在

7. 验证：
   - package-lock.json 应该生成
   - 不应出现 sampling/createMessage -32601
   - 如果 Codex 客户端不支持交互 sampling，也应该通过 approvedCommands 预授权路径完成

请最后汇总：
- MCP 工具是否可见
- resume 是否成功
- approvedCommands 是否成功
- 临时目录路径
- 是否修改了当前项目文件
- 是否发现 API key 或敏感信息泄露
```

## 真实 DeepSeek Smoke Test

真实 DeepSeek 调用默认跳过。只读 smoke test 需要显式设置以下环境变量才会运行：

```powershell
$env:DEEPSEEK_API_KEY = "..."
$env:RUN_DEEPSEEK_SMOKE = "1"
npm test -- test/deepseek-smoke.test.ts
```

真实端到端 E2E 会创建临时 fixture，执行 `repo-scout -> implementer -> taskId resume`，并验证 DeepSeek 实际修改文件和测试通过：

```powershell
$env:DEEPSEEK_API_KEY = "..."
$env:RUN_DEEPSEEK_E2E = "1"
npm test -- test/deepseek-e2e.test.ts
```

## Git 使用

初始化仓库后，推荐首次提交前先确认构建与测试通过：

```bash
npm run typecheck
npm test
npm run build
git status --short
```

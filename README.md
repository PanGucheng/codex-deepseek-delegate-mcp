# DeepSeek Delegate MCP Server

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

项目内已经包含 `.codex/config.toml`，用于让 Codex 加载本地 MCP 服务：

```toml
model = "gpt-5.5"

[mcp_servers.deepseek_delegate]
command = "node"
args = ["E:/delegate_to_deepseek_worker/dist/index.js"]
cwd = "E:/delegate_to_deepseek_worker"
env_vars = ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_DELEGATE_COMMAND_REVIEWER", "OPENAI_COMMAND_REVIEW_MODEL"]
startup_timeout_sec = 20
tool_timeout_sec = 1800
default_tools_approval_mode = "prompt"
```

启动 Codex 前先设置 DeepSeek API key：

```powershell
$env:DEEPSEEK_API_KEY = "..."
```

如果希望灰区 Bash 命令由 GPT 做提权裁决，再设置：

```powershell
$env:OPENAI_API_KEY = "..."
$env:DEEPSEEK_DELEGATE_COMMAND_REVIEWER = "openai"
$env:OPENAI_COMMAND_REVIEW_MODEL = "gpt-5.5"
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
- `cwd`：目标工作目录，必须位于 `DEEPSEEK_DELEGATE_WORKSPACE_ROOT` 或 MCP 服务启动目录内
- `allowedPaths`：可选写入范围白名单，路径必须位于 `cwd` 下，支持简单 `/**` 后缀
- `contextFiles`：可选只读上下文文件，按 workspace root 解析，可用于 monorepo 的 `AGENTS.md`
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
2. 硬危险命令本地拒绝，GPT reviewer 不能覆盖。
3. 其他灰区命令在配置 `DEEPSEEK_DELEGATE_COMMAND_REVIEWER=openai` 后交给 GPT 裁决；未配置 reviewer 时失败关闭。

默认允许：

- 只读命令，例如 `git status`、`git diff`、`rg`
- 常见测试和构建命令，例如 `npm test`、`npm run build`、`npm run typecheck`、`vitest`
- 针对测试文件的最小 Node 执行，例如 `node math.test.js`
- 原生文件写入工具：`Edit`、`Write`、`MultiEdit`
- 可解析的 Bash 写文件命令，例如 `echo ... > file`、`printf ... > file`、`Set-Content -LiteralPath file ...`、`node -e fs.writeFileSync("file", ...)`

需要 GPT reviewer 的灰区示例：

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

如果命令或路径被策略拒绝，工具会返回 `blocked`，并在 `summary` 中给出原因；详细命令记录保存在本地会话日志。

GPT reviewer 只接收单条命令、`cwd`、`allowedPaths`、任务摘要和本地策略原因；API key 不会写入日志。

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

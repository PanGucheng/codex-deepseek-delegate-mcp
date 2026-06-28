# DeepSeek Delegate MCP Server

这是一个本地 Codex MCP 服务。它让 Codex 使用 `gpt-5.5` 负责规划和审查，再通过 MCP 工具把具体实现任务委托给 Claude Agent SDK，并由 DeepSeek 的 Anthropic 兼容接口提供模型能力。

## 功能概览

- MCP 工具：`delegate_execute`
- 运行时：TypeScript + Node.js 18+
- 执行器：`@anthropic-ai/claude-agent-sdk`
- 模型供应商映射：`DEEPSEEK_API_KEY` 会映射到 `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`
- 会话日志：写入 `.delegate/sessions/<sessionId>/request.json`、`events.jsonl` 和 `result.json`
- 安全策略：限制 `cwd`、支持 `allowedFiles`、对 Bash 命令做 allow/deny 策略、日志不会记录 API key

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
env_vars = ["DEEPSEEK_API_KEY"]
startup_timeout_sec = 20
tool_timeout_sec = 1800
default_tools_approval_mode = "prompt"
```

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

`delegate_execute` 接收以下参数：

- `task`：要执行的实现任务
- `plan`：Codex 生成的实施计划，可选但推荐传入
- `cwd`：目标工作目录，必须位于 `DEEPSEEK_DELEGATE_WORKSPACE_ROOT` 或 MCP 服务启动目录内
- `allowedFiles`：可选文件范围白名单，路径必须位于 `cwd` 下
- `maxTurns`：执行器最大轮次，默认 `12`
- `runVerification`：是否要求执行器运行安全的验证命令

返回结果包含：

- `status`：`completed`、`blocked` 或 `failed`
- `summary`：执行摘要
- `changedFiles`：检测到变化的文件
- `commandsRun`：执行器请求运行的命令及策略结果
- `tests`：识别到的测试/验证命令
- `sessionId`：本地会话 ID
- `logPath`：会话日志目录

## 安全策略

执行器可以通过 Claude Code 工具读取、搜索和编辑文件。Bash 工具可用，但不会无条件自动批准。

默认允许：

- 只读命令，例如 `git status`、`git diff`、`rg`
- 常见测试和构建命令，例如 `npm test`、`npm run build`、`npm run typecheck`、`vitest`
- 针对测试文件的最小 Node 执行，例如 `node math.test.js`

默认拒绝：

- `rm -rf`
- `Remove-Item -Recurse`
- `git reset`
- `git clean`
- `git push`
- 全局配置修改
- 下载脚本并立即执行的命令
- 未在 allowlist 中的任意命令

如果命令或路径被策略拒绝，工具会返回 `blocked`，并在 `summary` 或 `commandsRun` 中给出原因。

## 真实 DeepSeek Smoke Test

真实 DeepSeek 调用默认跳过。需要显式设置以下环境变量才会运行：

```powershell
$env:DEEPSEEK_API_KEY = "..."
$env:RUN_DEEPSEEK_SMOKE = "1"
npm test -- test/deepseek-smoke.test.ts
```

## Git 使用

初始化仓库后，推荐首次提交前先确认构建与测试通过：

```bash
npm run typecheck
npm test
npm run build
git status --short
```

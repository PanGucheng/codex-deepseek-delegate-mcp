# Next Phase Plan: Approval UX, Task Status, Reviewer Helper

本文档规划下一阶段三个目标：

- 5. 增强 `approvedCommands` 审批体验
- 8. 增加 `delegate_status` / `delegate_history` 工具
- 10. 补 `reviewer-helper` 只读审查 agent

## 背景

当前 MCP 已经跑通 OpenCode 风格的 `delegate_task`：

- Codex 作为 primary planner。
- DeepSeek worker 通过 Claude Agent SDK 作为 child session 执行。
- `repo-scout` 只读探索，`implementer` 可写实现。
- `taskId` 是恢复 child session 的唯一机制。
- 当前 Codex 客户端不支持 MCP server-to-client `sampling/createMessage`，因此灰区 Bash 命令不能在运行中弹窗审批。
- 已落地的可用降级方案是 `approvedCommands`：Codex 在派发任务前传入精确命令字符串，安全策略只对灰区命令放行，硬危险命令仍不可覆盖。

下一阶段的重点不是扩大权限，而是让 Codex 更容易做正确调度、更容易检查历史、更容易审查 DeepSeek 的修改。

## 总体目标

1. 让 Codex 在派发实现任务前能清晰地预审灰区命令，减少 DeepSeek 运行中被权限策略卡住。
2. 让 Codex 能查询 task/session 的公开状态，而不需要读取 worker transcript 或本地私密日志。
3. 增加只读 `reviewer-helper`，用于审查 diff、测试结果和风险，辅助 Codex 最终 review。

## 非目标

- 不重新引入运行中 GPT/OpenAI API 审批。
- 不依赖当前不可用的 MCP `sampling/createMessage` 作为主路径。
- 不让 DeepSeek worker 拥有 Task/subagent 递归调用能力。
- 不把 worker transcript 暴露给 Codex。
- 不让 `approvedCommands` 支持通配符、正则或宽泛包管理授权。

## 目标 5: 增强 approvedCommands 审批体验

### 问题

当前 `approvedCommands` 可用，但 Codex 需要自己知道何时添加它。实际使用中可能出现：

- Codex 没有提前批准 `npm install`，DeepSeek 执行时被策略拒绝。
- Codex 不知道 `npm install <pkg> --package-lock-only` 可能同时改 `package.json` 和 lockfile。
- DeepSeek 可能加 `cd "<cwd>" && ...` 前缀，导致命令字符串和预授权命令不完全一致。
- 用户难以判断某条命令应该放进 `approvedCommands` 还是改用低危 allowlist 命令。

### 设计原则

- 预授权必须是精确命令，不支持通配符。
- 预授权只覆盖灰区命令，不覆盖硬危险命令。
- Codex 应在任务派发前做命令意图判断，并把命令写入 `prompt` 与 `approvedCommands`。
- MCP 应在工具描述和错误信息中提示如何修正，而不是只返回 “approval unavailable”。

### 接口方案

保持 `delegate_task.approvedCommands: string[]` 不变，补充文档和工具 instructions：

```json
{
  "subagentType": "implementer",
  "description": "install left-pad lockfile only",
  "prompt": "Run exactly: npm install left-pad --package-lock-only --ignore-scripts. Then report package-lock.json existence.",
  "cwd": "C:/project",
  "allowedPaths": ["package.json", "package-lock.json"],
  "approvedCommands": [
    "npm install left-pad --package-lock-only --ignore-scripts"
  ],
  "runVerification": true
}
```

新增可选字段候选，先评估后实现：

```ts
approvalNotes?: string
```

用途：记录 Codex 为什么批准这些命令，并写入 `assignment.md` 和本地日志。v1 可以暂不加字段，先把理由写进 `prompt`。

### 实现任务

1. 更新 MCP instructions：
   - 当任务明确需要新增依赖、更新 lockfile 或运行灰区命令时，Codex 应提前设置 `approvedCommands`。
   - 如果命令会改多个文件，`allowedPaths` 必须覆盖这些预期文件。
   - 不要为了普通测试命令设置 `approvedCommands`，因为测试命令已在 allowlist 中。

2. 增强拒绝消息：
   - 当前 no-sampling 情况返回 “Pass approvedCommands...”。
   - 增加 command echo 和可复制 JSON 片段，帮助 Codex 立即重试同一 `taskId`。

3. 增强任务单：
   - `assignment.md` 中已有 `Pre-Approved Commands`。
   - 补充一条执行规则：只能执行列出的精确灰区命令；如需其他灰区命令，应停止并报告。

4. 扩展测试：
   - 预授权命令可带 `cd "<cwd>" &&` 前缀。
   - 不完全匹配的命令仍被拒绝。
   - 硬危险命令即使出现在 `approvedCommands` 也被拒绝。
   - `npm install ... --package-lock-only` 示例在真实 DeepSeek smoke 中保持可选跳过。

### 验收标准

- Codex 新对话能从 MCP instructions 知道何时传 `approvedCommands`。
- no-sampling 错误能指导 Codex 用同一 `taskId` 重试，而不是重开任务。
- 预授权不能放行 `rm -rf`、`git reset`、下载执行脚本等硬危险命令。

## 目标 8: delegate_status / delegate_history 工具

### 问题

当前公开返回足够简洁，但缺少后续查询入口：

- Codex 只有当次 tool result，无法方便查询某个 `taskId` 对应的最近状态。
- `.delegate/tasks.json` 和 `.delegate/sessions/*/result.json` 是本地文件，不希望 Codex 随意读取目录。
- 用户看到旧 `.delegate/` 时，难判断哪些记录属于哪个任务。

### 设计原则

- 状态工具只返回公开摘要，不返回 worker transcript。
- 默认以 `cwd` 为边界，不能读取 cwd 以外的 `.delegate`。
- `delegate_history` 默认只列最近 N 条，避免一次性暴露过多本地历史。
- 返回结构稳定，方便 Codex 消化。

### 新工具: delegate_status

输入：

```ts
{
  cwd?: string;
  taskId: string;
  includeLastResult?: boolean; // default true
}
```

输出：

```ts
{
  taskId: string;
  found: boolean;
  subagentType?: "repo-scout" | "implementer" | "reviewer-helper";
  cwd?: string;
  model?: string;
  sdkSessionKnown?: boolean;
  allowedPaths?: string[];
  lastDelegateSessionId?: string;
  createdAt?: string;
  updatedAt?: string;
  lastResult?: {
    status: "completed" | "blocked" | "failed";
    summary: string;
    changedFiles: string[];
    tests: Array<{ command: string; status: string }>;
    resumed: boolean;
  };
}
```

行为：

- 如果 registry 中没有 `taskId`，返回 `found=false`，不抛异常。
- 如果 `lastDelegateSessionId` 的 `result.json` 不存在，返回 registry 信息但不含 `lastResult`。
- 不返回 `commandsRun`、`sessionId`、`logPath`、`sdkSessionId`、worker transcript。

### 新工具: delegate_history

输入：

```ts
{
  cwd?: string;
  limit?: number; // default 10, max 50
  subagentType?: "repo-scout" | "implementer" | "reviewer-helper";
  status?: "completed" | "blocked" | "failed";
}
```

输出：

```ts
{
  cwd: string;
  tasks: Array<{
    taskId: string;
    subagentType: string;
    status?: string;
    summary?: string;
    changedFiles?: string[];
    tests?: Array<{ command: string; status: string }>;
    updatedAt: string;
    lastDelegateSessionId: string;
  }>;
}
```

行为：

- 从 `.delegate/tasks.json` 读取 registry。
- 按 `updatedAt` 倒序。
- 尽力读取每个 task 的最后 `result.json`。
- 不列出 sessions 中没有 registry 的孤儿记录，避免历史来源混乱。后续可加 `includeOrphanSessions`。

### 实现任务

1. 新增 schema：
   - `DelegateStatusInputSchema`
   - `DelegateHistoryInputSchema`

2. 新增服务层函数：
   - `getDelegateStatus(rawInput, options)`
   - `getDelegateHistory(rawInput, options)`

3. 新增公开投影函数：
   - `toPublicStatus`
   - `toPublicHistoryItem`

4. MCP server 注册工具：
   - `delegate_status`
   - `delegate_history`

5. 测试：
   - 找得到 task。
   - 找不到 task 返回 `found=false`。
   - last result 缺失时不失败。
   - history limit/max 生效。
   - 返回不含敏感字段。

### 验收标准

- Codex 可通过 `delegate_status` 查询刚才的 `taskId`。
- Codex 可通过 `delegate_history` 列出最近任务摘要。
- 两个工具均不返回 `sdkSessionId`、`logPath`、`commandsRun` 或 transcript。

## 目标 10: reviewer-helper 只读审查 agent

### 问题

Codex 最终应负责 review，但在大 diff 或多文件修改时，Codex 可能希望派一个只读 helper 做初步风险扫描。当前只有：

- `repo-scout`：面向实现前探索。
- `implementer`：面向写代码和验证。

缺少面向实现后审查的只读 subagent。

### 设计原则

- `reviewer-helper` 只能读文件和运行低危只读/测试命令，不能写文件。
- 输出是审查意见，不是最终裁决。
- Codex 必须最终审查 diff，并决定接受、返工或继续派发。
- 不读取 worker transcript，只基于当前工作区、公开 result、diff 和必要文件。

### 接口变更

扩展：

```ts
SubagentType = "repo-scout" | "implementer" | "reviewer-helper"
```

`delegate_task` 继续使用同一接口：

```json
{
  "subagentType": "reviewer-helper",
  "description": "Review auth redirect fix",
  "prompt": "Review the current diff. Focus on correctness, tests, regression risk, and missing edge cases. Do not edit files.",
  "cwd": "C:/project",
  "contextFiles": ["AGENTS.md"],
  "maxTurns": 8,
  "runVerification": true
}
```

### 权限 profile

`reviewer-helper`：

- Allow tools: `Read`, `LS`, `Grep`, `Glob`, `Bash`, `TodoWrite`
- Auto allowed tools: `Read`, `LS`, `Grep`, `Glob`, `TodoWrite`
- Bash policy:
  - 允许只读命令：`git status`, `git diff`, `git show`, `rg`, `ls`
  - 允许测试命令：沿用当前 verification allowlist
  - 禁止任何写文件命令，即使 parseable write 也拒绝
  - 灰区命令不走 `approvedCommands`，默认拒绝并要求报告
- Edit/Write/MultiEdit: deny
- Task/subagent recursion: deny

### Worker prompt

新增 reviewer prompt：

```text
You are a read-only reviewer helper called by Codex.
Read the assignment file, inspect the current diff and relevant files, and report findings.
Do not edit files. Do not run commands that mutate files or install dependencies.
Codex owns final review and decision-making.
Return: Findings, Tests Observed, Risks, Suggested Follow-up.
```

中文语义：

- 只列真实风险，不为了显得有用而编造问题。
- 如果没有发现问题，明确说未发现阻断性问题，并列出剩余风险。
- 输出要简短、可审查。

### 输出约定

`reviewer-helper` 仍返回现有公开字段：

```ts
{
  taskId,
  subagentType: "reviewer-helper",
  status,
  summary,
  changedFiles: [],
  tests
}
```

后续可考虑结构化 review schema，但 v1 先不改变 MCP 返回结构，降低复杂度。

### 实现任务

1. 扩展 `SubagentTypeSchema`。
2. 更新 `getTools` 和 `getAutoAllowedTools`。
3. 更新 `authorizeTool`：
   - reviewer-helper 可读。
   - reviewer-helper 不可写。
   - reviewer-helper Bash 只允许只读和验证命令。
4. 更新 `buildWorkerPrompt`。
5. 更新 assignment 格式说明。
6. 更新 MCP instructions：
   - implementer 完成后，Codex 可用 reviewer-helper 审查 diff。
   - reviewer-helper 不替代 Codex 最终 review。
7. 测试：
   - reviewer-helper 不能 Edit/Write/MultiEdit。
   - reviewer-helper 不能 parseable Bash 写文件。
   - reviewer-helper 可运行 `git diff` 和测试命令。
   - reviewer-helper 不能使用 `approvedCommands` 放行灰区命令。
   - MCP schema 接受 `reviewer-helper`。

### 验收标准

- Codex 可派发 `reviewer-helper` 审查当前 diff。
- reviewer-helper 不会修改文件。
- reviewer-helper 返回一条最终公开审查摘要。
- 如果 reviewer-helper 发现问题，Codex 可用同一 implementer `taskId` 返工。

## 推荐实施顺序

1. 先做目标 8：`delegate_status` / `delegate_history`
   - 风险最低，能立刻提升可观测性。
   - 后续 reviewer-helper 可复用公开 status/history。

2. 再做目标 5：审批体验增强
   - 不改变核心 runner。
   - 主要是 instructions、错误消息和测试补强。

3. 最后做目标 10：`reviewer-helper`
   - 涉及 agent profile、权限策略和真实模型行为。
   - 需要更多回归测试。

## 测试计划

基础检查：

```bash
npm run typecheck
npm test
npm run build
```

新增单元测试：

- schema 接受新工具和 `reviewer-helper`。
- status/history 返回公开字段。
- status/history 不泄漏敏感字段。
- reviewer-helper 权限 profile 正确。
- approvedCommands 无法覆盖硬拒绝。

新增 MCP 集成测试：

- `delegate_status` 查询 mock runner 完成的 task。
- `delegate_history` 列出最近 task。
- `delegate_task(subagentType="reviewer-helper")` 可调用。
- no-sampling 环境下，错误提示建议 `approvedCommands`。

真实 DeepSeek 可选测试：

- implementer 修改临时 fixture。
- reviewer-helper 审查 fixture diff。
- approvedCommands 安装 lockfile。
- status/history 查询临时目录记录。

## 风险与缓解

- 风险：status/history 让 Codex 过度读取历史。
  - 缓解：只返回公开摘要，默认 limit 10，最大 50。

- 风险：reviewer-helper 被模型诱导写文件。
  - 缓解：权限层硬拒绝写工具和 Bash 写命令。

- 风险：approvedCommands 被误用为宽权限。
  - 缓解：只做精确匹配，硬危险命令不可覆盖，文档强调 allowedPaths 必须覆盖预期副作用。

- 风险：reviewer-helper 增加 token 成本。
  - 缓解：MCP instructions 明确仅在大 diff、多文件变更或高风险任务后使用。

## 交付物

- 更新后的 MCP 工具：
  - `delegate_task`
  - `delegate_execute`
  - `delegate_status`
  - `delegate_history`

- 更新后的 subagent：
  - `repo-scout`
  - `implementer`
  - `reviewer-helper`

- 更新后的文档：
  - README 使用说明
  - 本计划文档
  - Codex 验收提示词新增 reviewer/status/history 检查

## Definition of Done

- 所有新增工具和 subagent 有测试覆盖。
- `npm run typecheck`、`npm test`、`npm run build` 全部通过。
- 真实 DeepSeek 可选 smoke 至少在本机临时目录通过一次。
- README 说明新工具、新 agent 和 recommended workflow。
- 敏感 key 扫描无命中。

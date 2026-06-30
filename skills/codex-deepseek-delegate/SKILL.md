---
name: codex-deepseek-delegate
description: Use when Codex should delegate complex codebase exploration, implementation, verification, task resume, task history lookup, or read-only review through the local deepseek_delegate MCP server. Trigger for requests mentioning DeepSeek delegate, delegate_task, repo-scout, implementer, reviewer-helper, approvedCommands, delegate_status, delegate_history, or using Codex as planner with a DeepSeek/Claude Agent SDK worker.
---

# Codex DeepSeek Delegate

Use the local `deepseek_delegate` MCP server as a Task/Subagent boundary: Codex plans, delegates a compact task package, then reviews only the public result and file changes. Do not read worker transcripts or local `.delegate/sessions/*` logs unless the user explicitly asks.

## Tool Availability

Before delegating, confirm the MCP tools are visible:

- `delegate_task`
- `delegate_status`
- `delegate_history`
- `delegate_execute` only for legacy compatibility

If the tools are unavailable, tell the user to install or enable the `deepseek_delegate` MCP server and avoid pretending delegation happened.

## Decision Tree

Use normal Codex tools for simple work:

- Single file read
- Small grep/search
- One local verification command
- Direct edits that Codex can safely make itself

Use `delegate_task` for:

- Multi-file or multi-step implementation
- Independent repo exploration before planning
- Long-running fixture or regression work
- Continuing an existing DeepSeek child session with `taskId`
- Read-only review of an implementer diff

Choose `subagentType`:

- `repo-scout`: read-only exploration before implementation. No edits, no Bash.
- `implementer`: code edits and verification. Use `allowedPaths` for write scope.
- `reviewer-helper`: read-only post-implementation review. No edits, no dependency installs, no grey-zone approvals.

## delegate_task Patterns

Always pass an absolute `cwd` for the target project, especially when this MCP is globally installed.

Implementation task:

```json
{
  "subagentType": "implementer",
  "description": "fix auth redirect",
  "prompt": "Fix the login redirect bug. Only edit src/auth/** and tests/auth/**. Run npm test -- auth if needed. Return summary, changed files, tests, and risks.",
  "cwd": "C:/path/to/project",
  "allowedPaths": ["src/auth/**", "tests/auth/**"],
  "contextFiles": ["AGENTS.md"],
  "maxTurns": 12,
  "runVerification": true
}
```

Resume the same child session by reusing `taskId`:

```json
{
  "subagentType": "implementer",
  "taskId": "task_previous",
  "description": "address review feedback",
  "prompt": "Continue the same task. Address the reviewer feedback. Keep the same write scope.",
  "cwd": "C:/path/to/project",
  "allowedPaths": ["src/auth/**", "tests/auth/**"],
  "maxTurns": 8,
  "runVerification": true
}
```

Review after implementation:

```json
{
  "subagentType": "reviewer-helper",
  "description": "review auth redirect fix",
  "prompt": "Review the current diff and test signals. Focus on correctness, regressions, missing edge cases, and risks. Do not edit files.",
  "cwd": "C:/path/to/project",
  "contextFiles": ["AGENTS.md"],
  "maxTurns": 8,
  "runVerification": true
}
```

## approvedCommands

Current Codex clients may not support MCP server-to-client `sampling/createMessage`; runtime approval popups may not appear. If a grey-zone command is known before delegation and Codex approves it, pass it as an exact string in `approvedCommands`.

Use `approvedCommands` only for precise grey-zone Bash commands, for example dependency or lockfile operations:

```json
{
  "allowedPaths": ["package.json", "package-lock.json"],
  "approvedCommands": [
    "npm install left-pad --package-lock-only --ignore-scripts"
  ]
}
```

Rules:

- Keep exact string matching; do not invent wildcards or regex approvals.
- Include all expected side-effect files in `allowedPaths`.
- Do not use `approvedCommands` for normal tests or read-only commands.
- Hard-dangerous commands remain denied even if listed.
- `reviewer-helper` cannot use `approvedCommands`.

If a delegated task returns an approval-unavailable message with a suggested JSON snippet, review the command yourself. If acceptable, retry the same `taskId` with that command in `approvedCommands`.

## Status And History

Use `delegate_status` to inspect one task:

```json
{
  "cwd": "C:/path/to/project",
  "taskId": "task_previous"
}
```

Use `delegate_history` to list recent public summaries:

```json
{
  "cwd": "C:/path/to/project",
  "limit": 10,
  "subagentType": "implementer"
}
```

Treat these tools as the normal way to inspect prior delegate work. They intentionally omit `commandsRun`, `sessionId`, `logPath`, `sdkSessionId`, and worker transcript.

## Review And Final Response

After any implementer task:

1. Read the public tool result.
2. Inspect the actual git diff or changed files with normal Codex tools.
3. Optionally run `reviewer-helper` for large or risky diffs.
4. Decide whether to accept, ask implementer to continue with the same `taskId`, or make a small direct fix yourself.
5. Report changed files, tests, and residual risks to the user.

Never treat the DeepSeek worker as the final authority. Codex owns final review.

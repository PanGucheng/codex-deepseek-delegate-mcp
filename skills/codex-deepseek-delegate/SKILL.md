---
name: codex-deepseek-delegate
description: Delegates complex Codex codebase exploration, implementation, verification, task resume, task history lookup, and read-only review through the local deepseek_delegate MCP server. Use for prompts mentioning DeepSeek delegate, delegate_task, repo-scout, implementer, reviewer-helper, approvedCommands, delegate_status, delegate_history, or a Codex planner with a DeepSeek worker.
---

# Codex DeepSeek Delegate

Use the local `deepseek_delegate` MCP server as a Task/Subagent boundary: Codex plans, delegates a compact execution package, then reviews only the public result and file changes. Codex is the planner; DeepSeek is the executor. Do not read worker transcripts or local `.delegate/sessions/*` logs unless the user explicitly asks.

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
- Independent factual repo exploration before planning
- Long-running fixture or regression work
- Continuing an existing DeepSeek child session with `taskId`
- Read-only review of an implementer diff

Choose `subagentType`:

- `repo-scout`: read-only factual exploration. It may use read-only Bash. No edits, no dependency installs, no implementation plan.
- `implementer`: code edits and verification. Codex must provide `executionPlan`; use `allowedPaths` for write scope.
- `reviewer-helper`: read-only post-implementation review. No edits, no dependency installs, no grey-zone approvals.

## delegate_task Patterns

Always pass an absolute `cwd` for the target project, especially when this MCP is globally installed.

Implementation task:

```json
{
  "subagentType": "implementer",
  "description": "fix auth redirect",
  "prompt": "Execute the Codex-authored plan exactly. Do not redesign the approach. If any step is invalid, stop and return a decision request.",
  "executionPlan": [
    "Open src/auth/redirect.ts and change post-login fallback logic to preserve nextUrl when it is present.",
    "Add regression coverage in tests/auth/redirect.test.ts for nextUrl preservation.",
    "Run npm test -- auth."
  ],
  "acceptanceCriteria": [
    "Login with nextUrl redirects to nextUrl.",
    "Existing fallback redirect remains /dashboard.",
    "Auth tests pass."
  ],
  "cwd": "C:/path/to/project",
  "allowedPaths": ["src/auth/**", "tests/auth/**"],
  "contextFiles": ["AGENTS.md"],
  "runVerification": true
}
```

Resume the same child session by reusing `taskId`:

```json
{
  "subagentType": "implementer",
  "taskId": "task_previous",
  "description": "address review feedback",
  "prompt": "Continue the same task. Execute these Codex review fixes only. If the requested fix conflicts with the existing implementation, stop and ask Codex.",
  "executionPlan": [
    "Update the regression test name to describe the nextUrl case.",
    "Keep the production change unchanged unless the test reveals a failure."
  ],
  "cwd": "C:/path/to/project",
  "allowedPaths": ["src/auth/**", "tests/auth/**"],
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
  "runVerification": true
}
```

Omit `maxTurns` for normal work. Pass it only when intentionally limiting a smoke test or budget.

## approvedCommands And Prefixes

Some Codex clients may not support MCP server-to-client `sampling/createMessage`; runtime approval popups may not appear. If a grey-zone command is known before delegation and Codex approves it, pass it as an exact string in `approvedCommands` or as a prefix in `approvedCommandPrefixes`.

Use `approvedCommands` for precise grey-zone Bash commands, and `approvedCommandPrefixes` when Codex intentionally approves a family of command variants:

```json
{
  "allowedPaths": ["package.json", "package-lock.json"],
  "approvedCommands": [
    "npm install left-pad --package-lock-only --ignore-scripts"
  ],
  "approvedCommandPrefixes": [
    "npm install left-pad"
  ]
}
```

Rules:

- Keep `approvedCommands` exact.
- Keep `approvedCommandPrefixes` narrow and literal; do not invent wildcards or regex approvals.
- Include all expected side-effect files in `allowedPaths`.
- Do not use `approvedCommands` for normal tests or read-only commands.
- Hard-dangerous commands remain denied even if listed or prefix-approved.
- `reviewer-helper` cannot use approvals.

If a delegated task returns an approval-unavailable message with a suggested JSON snippet, review the command yourself. If acceptable, retry the same `taskId` with that command in `approvedCommands`, or with a narrow prefix in `approvedCommandPrefixes`.

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

## Failure Handling

Use this table before starting a fresh task:

| Symptom | Response |
|---|---|
| MCP tools are not visible | Tell the user `deepseek_delegate` is not installed or enabled; do not simulate delegation. |
| `taskId was not found` | Treat it as a missing child session. Start fresh only if the user agrees or the task is safe to restart. |
| Approval unavailable for a grey-zone Bash command | Review the command. If acceptable, retry the same `taskId` with that exact command in `approvedCommands` or a narrow `approvedCommandPrefixes` entry. |
| `allowedPaths` blocks an expected file | Retry the same `taskId` with the minimal additional path; mention why the scope changed. |
| Implementer says the plan is invalid or incomplete | Codex decides the next step, then retries the same `taskId` with a corrected `executionPlan`. |
| Worker returns `failed` but has a `taskId` | Use `delegate_status`; if resumable, continue the same `taskId` instead of restarting. |
| Reviewer finds issues | Send a focused follow-up to the same implementer `taskId` when possible. |

## Review And Final Response

After any implementer task:

1. Read the public tool result.
2. Inspect the actual git diff or changed files with normal Codex tools.
3. Optionally run `reviewer-helper` for large or risky diffs.
4. Decide whether to accept, ask implementer to continue with the same `taskId`, or make a small direct fix yourself.
5. Report changed files, tests, and residual risks to the user.

Never treat the DeepSeek worker as the final authority. Codex owns final review.

## Validation Checklist

Before final response, verify:

- Public result was read from the MCP tool response, not worker transcript.
- Changed files or git diff were inspected directly by Codex.
- Tests or verification commands were run or clearly reported as not run.
- `delegate_status` or `delegate_history` was used when continuity or prior task state matters.
- Codex authored the `executionPlan` for implementer tasks.
- Any `approvedCommands` or `approvedCommandPrefixes` entry was necessary, narrow, and scoped by `allowedPaths`.

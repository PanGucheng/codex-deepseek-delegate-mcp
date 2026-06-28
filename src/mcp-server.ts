import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DelegateInputSchema, DelegateTaskInputSchema } from "./types.js";
import type { DelegateRunner, DelegateResult } from "./types.js";
import { executeDelegate, executeDelegateTask } from "./service.js";

const SERVER_INSTRUCTIONS =
  "Prefer delegate_task for complex multi-file or multi-step work. Do not launch a subagent for simple file reads, grep, or one command checks. delegate_task writes a local .delegate/sessions/<sessionId>/assignment.md file and launches a DeepSeek child session. New tasks are fresh by default; pass taskId only to continue the same child task. Use repo-scout for read-only exploration and implementer for code changes. Codex should review only the final public tool result and changed files, not worker transcripts or local logs.";

export function createDelegateServer(
  runner?: DelegateRunner,
  env?: NodeJS.ProcessEnv,
): McpServer {
  const server = new McpServer(
    {
      name: "deepseek-delegate",
      version: "0.1.0",
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.registerTool(
    "delegate_task",
    {
      title: "Delegate a task to a DeepSeek subagent",
      description:
        "Launches or resumes a DeepSeek child session for a complex task. Use repo-scout for read-only exploration, implementer for code changes, and pass taskId only when continuing the same child task.",
      inputSchema: DelegateTaskInputSchema,
    },
    async (input): Promise<CallToolResult> => {
      const result = await executeDelegateTask(input, { runner, env });
      return toToolResult(result);
    },
  );

  server.registerTool(
    "delegate_execute",
    {
      title: "Compatibility wrapper: delegate implementation to DeepSeek worker",
      description:
        "Compatibility wrapper around delegate_task with subagentType=implementer. Prefer delegate_task for new integrations.",
      inputSchema: DelegateInputSchema,
    },
    async (input): Promise<CallToolResult> => {
      const result = await executeDelegate(input, { runner, env });
      return toToolResult(result);
    },
  );

  return server;
}

function toToolResult(result: DelegateResult): CallToolResult {
  const publicResult = toPublicResult(result);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(publicResult, null, 2),
      },
    ],
    structuredContent: publicResult as unknown as Record<string, unknown>,
    isError: result.status === "failed",
  };
}

function toPublicResult(result: DelegateResult) {
  return {
    taskId: result.taskId,
    subagentType: result.subagentType,
    status: result.status,
    summary: result.summary,
    changedFiles: result.changedFiles,
    tests: result.tests,
  };
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DelegateInputSchema } from "./types.js";
import type { DelegateRunner, DelegateResult } from "./types.js";
import { executeDelegate } from "./service.js";

const SERVER_INSTRUCTIONS =
  "Use delegate_execute only after Codex has produced a concrete implementation plan. The tool runs a local Claude Agent SDK worker backed by DeepSeek, with policy-gated commands and session logs under .delegate/sessions.";

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
    "delegate_execute",
    {
      title: "Delegate implementation to DeepSeek worker",
      description:
        "Runs a bounded implementation task through Claude Agent SDK using DeepSeek's Anthropic-compatible endpoint.",
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
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
    structuredContent: result as unknown as Record<string, unknown>,
    isError: result.status === "failed",
  };
}

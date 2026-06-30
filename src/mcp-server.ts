import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import {
  CreateMessageResultSchema,
  ListRootsResultSchema,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";
import {
  DelegateHistoryInputSchema,
  DelegateInputSchema,
  DelegateStatusInputSchema,
  DelegateTaskInputSchema,
} from "./types.js";
import type {
  CommandApprovalDecision,
  CommandApprovalHandler,
  CommandApprovalRequest,
  DelegateRunner,
  DelegateResult,
} from "./types.js";
import {
  executeDelegate,
  executeDelegateTask,
  getDelegateHistory,
  getDelegateStatus,
} from "./service.js";

const SERVER_INSTRUCTIONS =
  "Prefer delegate_task for complex multi-file or multi-step work. Do not launch a subagent for simple file reads, grep, or one command checks. Codex is the primary planner: before calling implementer, create a concrete executionPlan and acceptanceCriteria. Implementer executes the Codex-authored plan and should return blocked/decision-needed if the plan is missing, contradictory, outside allowedPaths, or requires an architectural choice. Implementer should write a curated handoffFile and optional evidenceFiles with selected verification evidence, risks, and unverified items; do not ask Codex to read worker transcripts or raw logs. When this MCP server is installed globally, always pass the absolute target project cwd. If cwd is omitted, the server will try to use the client's first MCP root. delegate_task writes a local .delegate/sessions/<sessionId>/assignment.md file and launches a DeepSeek child session. New tasks are fresh by default; pass taskId only to continue the same child task. Use repo-scout for read-only factual exploration and implementer for planned code changes. Do not call reviewer-helper by default after implementation; use it only for large, risky, security-sensitive, confusing, or user-requested second reviews. If maxTurns is omitted, the MCP sets it to 100 to avoid Claude Code's lower internal default; pass a smaller value only when Codex intentionally wants a tight turn cap. Implementer defaults to balanced Bash policy for normal project build/test/lint/typecheck/script commands. Approval-required Bash commands are surfaced to Codex via MCP sampling/createMessage when the client supports sampling. If sampling is unavailable or the command is known before delegation, Codex can pass approvedCommands for exact grey-zone commands or approvedCommandPrefixes for command-prefix approvals it has already approved for this task. Use delegate_status and delegate_history for public task summaries; do not read worker transcripts or local logs unless the user explicitly asks.";

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

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
        "Launches or resumes a DeepSeek child session for a complex task. Use repo-scout for read-only exploration and implementer for planned code changes. Implementer may return curated handoffFile/evidenceFiles. Pass taskId only when continuing the same child task.",
      inputSchema: DelegateTaskInputSchema,
    },
    async (input, extra): Promise<CallToolResult> => {
      const result = await executeDelegateTask(input, {
        runner,
        env: await getToolEnv(input, env, extra),
        commandApprovalHandler: createCodexCommandApprovalHandler(
          extra,
          () => server.server.getClientCapabilities(),
        ),
      });
      return toToolResult(result);
    },
  );

  server.registerTool(
    "delegate_status",
    {
      title: "Get public status for a DeepSeek delegate task",
      description:
        "Returns a public summary for one taskId from .delegate/tasks.json and the last result.json, including curated handoff/evidence file references when available. Does not return worker transcripts, commandsRun, logPath, sessionId, or sdkSessionId.",
      inputSchema: DelegateStatusInputSchema,
    },
    async (input, extra): Promise<CallToolResult> => {
      const result = await getDelegateStatus(input, {
        env: await getToolEnv(input, env, extra),
      });
      return toJsonToolResult(result, false);
    },
  );

  server.registerTool(
    "delegate_history",
    {
      title: "List public history for DeepSeek delegate tasks",
      description:
        "Lists recent public task summaries from .delegate/tasks.json, including curated handoff/evidence file references when available. Does not return worker transcripts, commandsRun, logPath, sessionId, or sdkSessionId.",
      inputSchema: DelegateHistoryInputSchema,
    },
    async (input, extra): Promise<CallToolResult> => {
      const result = await getDelegateHistory(input, {
        env: await getToolEnv(input, env, extra),
      });
      return toJsonToolResult(result, false);
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
    async (input, extra): Promise<CallToolResult> => {
      const result = await executeDelegate(input, {
        runner,
        env: await getToolEnv(input, env, extra),
        commandApprovalHandler: createCodexCommandApprovalHandler(
          extra,
          () => server.server.getClientCapabilities(),
        ),
      });
      return toToolResult(result);
    },
  );

  return server;
}

function createCodexCommandApprovalHandler(
  extra: ToolExtra,
  getClientCapabilities: () => ClientCapabilities | undefined,
): CommandApprovalHandler {
  return async (request): Promise<CommandApprovalDecision> => {
    const capabilities = getClientCapabilities();
    if (!capabilities?.sampling) {
      return {
        allowed: false,
        reason: [
          "Codex MCP client does not advertise sampling/createMessage; interactive command approval is unavailable.",
          "Retry the same taskId with this exact command in delegate_task.approvedCommands, or with an intentional prefix in approvedCommandPrefixes, if Codex approves it:",
          JSON.stringify({ approvedCommands: [request.command] }),
        ].join(" "),
      };
    }

    const result = await extra.sendRequest(
      {
        method: "sampling/createMessage",
        params: {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: formatCommandApprovalMessage(request),
              },
            },
          ],
          systemPrompt:
            'You are Codex reviewing a DeepSeek delegate Bash command. Return only compact JSON: {"allowed":boolean,"reason":"short reason"}.',
          includeContext: "none",
          temperature: 0,
          maxTokens: 180,
          metadata: {
            source: "deepseek-delegate-command-approval",
          },
        },
      },
      CreateMessageResultSchema,
    );

    return parseCodexApprovalText(
      result.content.type === "text" ? result.content.text : "",
    );
  };
}

function formatCommandApprovalMessage(request: CommandApprovalRequest): string {
  const allowedPaths = request.allowedPaths?.length
    ? request.allowedPaths.map((entry) => `- ${entry}`).join("\n")
    : "- Any file under cwd, unless blocked by local policy";

  return [
    "DeepSeek worker is requesting permission to run a Bash command that is outside the deterministic allowlist.",
    "Decide whether Codex should allow this single command to run now. Respond with JSON only, for example:",
    '{"allowed":false,"reason":"command is not scoped to the task"}',
    "",
    `Task ID: ${request.taskId}`,
    `Subagent: ${request.subagentType}`,
    `Description: ${request.description}`,
    `cwd: ${request.cwd}`,
    "",
    "Command:",
    "```sh",
    request.command,
    "```",
    "",
    "Allowed write paths:",
    allowedPaths,
    "",
    `Local policy reason: ${request.policyReason}`,
    "",
    "Approve only if this command is necessary for the current task and scoped to the target project. Deny destructive commands, global config changes, credential access, git history rewrites, and download-and-execute flows.",
  ].join("\n");
}

function parseCodexApprovalText(text: string): CommandApprovalDecision {
  const fallback: CommandApprovalDecision = {
    allowed: false,
    reason: "Codex sampling response did not include valid approval JSON",
  };

  const trimmed = text.trim();
  if (!trimmed) {
    return fallback;
  }

  const jsonText = extractJsonObject(trimmed);
  if (!jsonText) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(jsonText) as {
      allowed?: unknown;
      approve?: unknown;
      reason?: unknown;
    };
    const allowed =
      typeof parsed.allowed === "boolean"
        ? parsed.allowed
        : typeof parsed.approve === "boolean"
          ? parsed.approve
          : undefined;
    if (allowed === undefined) {
      return fallback;
    }
    const reason =
      typeof parsed.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim()
        : allowed
          ? "approved by Codex"
          : "denied by Codex";
    return { allowed, reason };
  } catch {
    return fallback;
  }
}

function extractJsonObject(text: string): string | undefined {
  if (text.startsWith("{") && text.endsWith("}")) {
    return text;
  }
  const match = text.match(/\{[\s\S]*\}/);
  return match?.[0];
}

async function getToolEnv(
  input: { cwd?: string },
  configuredEnv: NodeJS.ProcessEnv | undefined,
  extra: ToolExtra,
): Promise<NodeJS.ProcessEnv | undefined> {
  const baseEnv = configuredEnv || process.env;

  if (baseEnv.DEEPSEEK_DELEGATE_WORKSPACE_ROOT || input.cwd) {
    return configuredEnv;
  }

  const clientRoot = await getFirstClientRoot(extra);
  if (!clientRoot) {
    return configuredEnv;
  }

  return {
    ...baseEnv,
    DEEPSEEK_DELEGATE_WORKSPACE_ROOT: clientRoot,
  };
}

async function getFirstClientRoot(extra: ToolExtra): Promise<string | undefined> {
  try {
    const result = await extra.sendRequest(
      { method: "roots/list" },
      ListRootsResultSchema,
    );
    const root = result.roots.find((entry) => entry.uri.startsWith("file://"));
    return root ? fileURLToPath(root.uri) : undefined;
  } catch {
    return undefined;
  }
}

function toToolResult(result: DelegateResult): CallToolResult {
  const publicResult = toPublicResult(result);

  return toJsonToolResult(publicResult, result.status === "failed");
}

function toJsonToolResult(publicResult: unknown, isError: boolean): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(publicResult, null, 2),
      },
    ],
    structuredContent: publicResult as Record<string, unknown>,
    isError,
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
    handoffFile: result.handoffFile,
    evidenceFiles: result.evidenceFiles,
  };
}

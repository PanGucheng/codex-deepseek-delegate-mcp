import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { buildDeepSeekEnv, type ProcessEnv } from "./config.js";
import { createCanUseTool } from "./security.js";
import type {
  DelegateResult,
  DelegateRunner,
  NormalizedDelegateInput,
  RunnerContext,
} from "./types.js";

const IMPLEMENTER_TOOLS = ["Read", "Edit", "MultiEdit", "Write", "LS", "Grep", "Glob", "Bash", "TodoWrite"];
const IMPLEMENTER_AUTO_ALLOWED_TOOLS = ["Read", "Edit", "MultiEdit", "Write", "LS", "Grep", "Glob", "TodoWrite"];
const IMPLEMENTER_NO_BASH_TOOLS = ["Read", "Edit", "MultiEdit", "Write", "LS", "Grep", "Glob", "TodoWrite"];
const SCOUT_TOOLS = ["Read", "LS", "Grep", "Glob", "Bash"];
const SCOUT_AUTO_ALLOWED_TOOLS = ["Read", "LS", "Grep", "Glob"];
const REVIEWER_TOOLS = ["Read", "LS", "Grep", "Glob", "Bash", "TodoWrite"];
const REVIEWER_AUTO_ALLOWED_TOOLS = ["Read", "LS", "Grep", "Glob", "TodoWrite"];

export class ClaudeRunner implements DelegateRunner {
  constructor(private readonly env: ProcessEnv = process.env) {}

  async run(input: NormalizedDelegateInput, context: RunnerContext): Promise<DelegateResult> {
    const deepSeek = buildDeepSeekEnv(this.env);
    const model = deepSeek.env.ANTHROPIC_MODEL || "";
    const prompt = buildWorkerPrompt(input);
    let finalSummary = "";
    let status: DelegateResult["status"] = "failed";
    let sdkSessionId = input.resumeSdkSessionId;
    const tools = getTools(input);
    const allowedTools = getAutoAllowedTools(input);
    context.sdkSessionId = sdkSessionId;
    context.sdkModel = model;

    await contextLog(context, "task_session", {
      taskId: input.taskId,
      subagentType: input.subagentType,
      resumed: input.resumed,
      resumeSdkSessionId: input.resumeSdkSessionId,
      persistSession: true,
    });

    const options = {
      cwd: input.cwd,
      env: deepSeek.env,
      model,
      ...(input.maxTurns ? { maxTurns: input.maxTurns } : {}),
      permissionMode: input.subagentType === "implementer" ? "acceptEdits" : "default",
      tools,
      allowedTools,
      canUseTool: createCanUseTool(input, context.commandsRun, context.tests, {
        commandApprovalHandler: context.commandApprovalHandler,
      }),
      persistSession: true,
      enableFileCheckpointing: true,
      includePartialMessages: false,
      ...(input.resumeSdkSessionId ? { resume: input.resumeSdkSessionId } : {}),
    } as const;

    const iterator = query({
      prompt,
      options,
    });

    for await (const message of iterator) {
      const messageSessionId = getMessageSessionId(message);
      sdkSessionId = messageSessionId || sdkSessionId;
      if (messageSessionId) {
        context.sdkSessionId = messageSessionId;
        context.sdkModel = model;
      }
      await contextLog(context, "sdk_message", summarizeMessage(message));

      const observedCommands = extractBashCommands(message);
      for (const command of observedCommands) {
        if (!context.commandsRun.some((record) => record.command === command)) {
          context.commandsRun.push({ command, status: "observed" });
        }
      }

      if (message.type === "assistant") {
        const text = extractAssistantText(message);
        if (text) {
          finalSummary = text;
        }
      }

      if (message.type === "result") {
        if (message.subtype === "success") {
          status = "completed";
          finalSummary = message.result || finalSummary || "Delegate completed.";
        } else {
          status = context.commandsRun.some((command) => command.status === "denied")
            ? "blocked"
            : "failed";
          finalSummary =
            message.errors?.join("\n") ||
            finalSummary ||
            `Delegate failed with result subtype ${message.subtype}.`;
        }
      }
    }

    if (status !== "completed" && context.commandsRun.some((command) => command.status === "denied")) {
      status = "blocked";
      const denied = context.commandsRun.find((command) => command.status === "denied");
      finalSummary = denied?.reason || finalSummary || "Delegate was blocked by the safety policy.";
    }

    return {
      taskId: input.taskId,
      subagentType: input.subagentType,
      status,
      summary: finalSummary || "Delegate finished without a final summary.",
      changedFiles: [],
      commandsRun: context.commandsRun,
      tests: context.tests,
      sessionId: context.sessionId,
      logPath: context.logPath,
      sdkSessionId,
      sdkModel: model,
      resumed: input.resumed,
    };
  }
}

function buildWorkerPrompt(input: NormalizedDelegateInput): string {
  const assignmentFile = input.assignmentFilePath || "(assignment file was not provided)";

  return [
    "You are a delegated implementation worker called by Codex.",
    `Subagent type: ${input.subagentType}`,
    "",
    "Codex owns planning and final review. Your full assignment is stored in a local file, not in this chat prompt.",
    "Read the assignment file before making changes, then follow the Codex-authored execution plan exactly.",
    "This assignment file supersedes any previous assignment or file-scope instruction in this conversation.",
    `Assignment file: ${assignmentFile}`,
    "",
    roleInstruction(input),
    "Do not call other subagents or task tools. Subagent depth is fixed at 1.",
    "Keep changes tightly scoped, do not modify global configuration, do not push commits, and do not run destructive commands.",
    "If the Codex-authored plan is missing, contradictory, points to nonexistent files, exceeds allowed paths, or needs architectural choices, stop and return a decision request to Codex instead of inventing a new plan.",
    "Use only the tools made available by the host.",
    "",
    `cwd: ${input.cwd}`,
    finalReportInstruction(input),
  ].join("\n");
}

function finalReportInstruction(input: NormalizedDelegateInput): string {
  if (input.subagentType === "repo-scout") {
    return "Finish with a compact factual report containing Relevant files, Symbols or line ranges, Test entry points, and Rationale. Do not write handoff files.";
  }

  if (input.subagentType === "reviewer-helper") {
    return "Finish with a compact report containing Findings, Tests Observed, Risks, and Suggested Follow-up.";
  }

  return "Before finishing, write the curated Codex handoff requested in the assignment. Then finish with a compact report containing Summary, Changed files, Commands run, Tests, Risks, and the handoff file path.";
}

function roleInstruction(input: NormalizedDelegateInput): string {
  if (input.subagentType === "repo-scout") {
    return "You are read-only. Identify relevant files, symbols, line ranges, tests, and concise factual rationale. You may use read-only Bash for inspection, but do not edit files, install dependencies, or propose a detailed implementation plan.";
  }

  if (input.subagentType === "reviewer-helper") {
    return "You are a read-only reviewer helper. Inspect the current diff, relevant files, and test signals. Do not edit files. Do not run commands that mutate files or install dependencies. Report only real findings; if none are found, say so and list residual risks.";
  }

  return input.runVerification
    ? "Execute the Codex-authored plan in the assignment. Use Edit, MultiEdit, or Write for planned file modifications. You may make small local adaptations required by actual symbol names, imports, or formatting, but do not redesign the approach. If the plan is wrong or incomplete in a way that changes the approach, stop and ask Codex for a decision. Bash uses the assignment's policy mode and may be used for project-local build, test, lint, typecheck, and code generation commands."
    : "Execute the Codex-authored plan in the assignment. Bash is not available for this task because verification was not requested. Use Edit, MultiEdit, or Write for planned file modifications. If the plan is wrong or incomplete in a way that changes the approach, stop and ask Codex for a decision.";
}

function getTools(input: NormalizedDelegateInput): string[] {
  if (input.subagentType === "repo-scout") {
    return SCOUT_TOOLS;
  }
  if (input.subagentType === "reviewer-helper") {
    return input.runVerification ? REVIEWER_TOOLS : SCOUT_TOOLS;
  }

  return input.runVerification ? IMPLEMENTER_TOOLS : IMPLEMENTER_NO_BASH_TOOLS;
}

function getAutoAllowedTools(input: NormalizedDelegateInput): string[] {
  if (input.subagentType === "repo-scout") {
    return SCOUT_AUTO_ALLOWED_TOOLS;
  }
  if (input.subagentType === "reviewer-helper") {
    return REVIEWER_AUTO_ALLOWED_TOOLS;
  }

  return IMPLEMENTER_AUTO_ALLOWED_TOOLS;
}

function getMessageSessionId(message: SDKMessage): string | undefined {
  return "session_id" in message && typeof message.session_id === "string"
    ? message.session_id
    : undefined;
}

function extractAssistantText(message: Extract<SDKMessage, { type: "assistant" }>): string {
  const content = message.message.content;
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (typeof block === "object" && block && "type" in block && block.type === "text") {
        return "text" in block && typeof block.text === "string" ? block.text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractBashCommands(message: SDKMessage): string[] {
  if (message.type !== "assistant") {
    return [];
  }

  const content = message.message.content;
  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .map((block) => {
      if (
        typeof block === "object" &&
        block &&
        "type" in block &&
        block.type === "tool_use" &&
        "name" in block &&
        block.name === "Bash" &&
        "input" in block &&
        typeof block.input === "object" &&
        block.input &&
        "command" in block.input &&
        typeof block.input.command === "string"
      ) {
        return block.input.command;
      }
      return undefined;
    })
    .filter((command): command is string => Boolean(command));
}

function summarizeMessage(message: SDKMessage): Record<string, unknown> {
  if (message.type === "assistant") {
    return {
      type: message.type,
      session_id: message.session_id,
      has_error: Boolean(message.error),
      text: truncate(extractAssistantText(message)),
    };
  }

  if (message.type === "result") {
    return {
      type: message.type,
      subtype: message.subtype,
      is_error: message.is_error,
      num_turns: message.num_turns,
      session_id: message.session_id,
    };
  }

  if (message.type === "system") {
    return {
      type: message.type,
      subtype: "subtype" in message ? message.subtype : undefined,
      session_id: "session_id" in message ? message.session_id : undefined,
    };
  }

  return { type: message.type };
}

async function contextLog(
  context: RunnerContext,
  event: string,
  payload: unknown,
): Promise<void> {
  await import("node:fs/promises").then((fs) =>
    fs.appendFile(
      `${context.logPath}/events.jsonl`,
      `${JSON.stringify({ ts: new Date().toISOString(), event, payload })}\n`,
      "utf8",
    ),
  );
}

function truncate(value: string, max = 4000): string {
  return value.length > max ? `${value.slice(0, max)}\n<truncated>` : value;
}

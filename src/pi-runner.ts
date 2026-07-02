import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  AuthStorage,
  createAgentSession,
  defineTool,
  ModelRegistry,
  SessionManager,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ConfigError, type ProcessEnv } from "./config.js";
import { isAllowedFilePath, isSubpath, toRelativeDisplay } from "./paths.js";
import { authorizeTool } from "./security.js";
import type {
  CommandRecord,
  DelegateResult,
  DelegateRunner,
  NormalizedDelegateInput,
  RunnerContext,
  TestRecord,
} from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_PI_MODEL = "deepseek-v4-pro";
const OUTPUT_LIMIT = 16_000;

export class PiRunner implements DelegateRunner {
  constructor(private readonly env: ProcessEnv = process.env) {}

  async run(input: NormalizedDelegateInput, context: RunnerContext): Promise<DelegateResult> {
    if (!this.env.DEEPSEEK_API_KEY) {
      throw new ConfigError(
        "DEEPSEEK_API_KEY is required for the Pi runner. Set it before starting the MCP server.",
      );
    }

    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    const modelId = this.env.DEEPSEEK_DELEGATE_PI_MODEL || DEFAULT_PI_MODEL;
    const model = modelRegistry.find("deepseek", modelId);
    if (!model) {
      throw new ConfigError(`Pi DeepSeek model was not found: deepseek/${modelId}`);
    }

    const sessionDirectory = path.join(input.cwd, ".delegate", "pi-sessions");
    await fs.mkdir(sessionDirectory, { recursive: true });

    const customTools = createDelegateTools(input, context);
    const toolNames = customTools.map((tool) => tool.name);
    const sessionManager = input.resumeSdkSessionId
      ? SessionManager.open(input.resumeSdkSessionId)
      : SessionManager.create(input.cwd, sessionDirectory);

    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: input.cwd,
      model,
      thinkingLevel: "medium",
      authStorage,
      modelRegistry,
      noTools: "builtin",
      tools: toolNames,
      customTools,
      sessionManager,
    });

    context.sdkSessionId = session.sessionFile || session.sessionId;
    context.sdkModel = `deepseek/${model.id}`;
    let status: DelegateResult["status"] = "failed";
    let finalSummary = modelFallbackMessage || "";
    let turnCount = 0;

    const unsubscribe = session.subscribe((event) => {
      observeEvent(event, input, context, {
        onText: (text) => {
          finalSummary = text;
        },
        onTurn: () => {
          turnCount += 1;
        },
      });
    });

    try {
      await session.prompt(buildWorkerPrompt(input), { expandPromptTemplates: false, source: "rpc" });
      status = context.commandsRun.some((command) => command.status === "denied") ? "blocked" : "completed";
    } catch (error) {
      status = context.commandsRun.some((command) => command.status === "denied") ? "blocked" : "failed";
      finalSummary = error instanceof Error ? error.message : String(error);
    } finally {
      unsubscribe();
      context.sdkSessionId = session.sessionFile || session.sessionId;
      session.dispose();
    }

    if (turnCount > input.maxTurns!) {
      status = "failed";
      finalSummary = `Pi runner exceeded maxTurns=${input.maxTurns}.`;
    }

    const denied = context.commandsRun.find((command) => command.status === "denied");
    if (denied) {
      status = "blocked";
      finalSummary = denied.reason || finalSummary || "Delegate was blocked by the safety policy.";
    }

    return {
      taskId: input.taskId,
      subagentType: input.subagentType,
      status,
      summary: finalSummary || "Pi delegate completed.",
      changedFiles: [],
      commandsRun: context.commandsRun,
      tests: context.tests,
      sessionId: context.sessionId,
      logPath: context.logPath,
      sdkSessionId: context.sdkSessionId,
      sdkModel: context.sdkModel,
      resumed: input.resumed,
    };
  }
}

function createDelegateTools(input: NormalizedDelegateInput, context: RunnerContext): ToolDefinition[] {
  const readTool = defineTool({
    name: "read",
    label: "Read",
    description: "Read a UTF-8 text file inside the delegated cwd.",
    parameters: Type.Object({
      path: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      const decision = authorizePiFileTool("Read", { path: params.path }, input);
      if (!decision.allowed) {
        throw new Error(decision.reason);
      }
      const filePath = path.resolve(input.cwd, params.path);
      const text = await fs.readFile(filePath, "utf8");
      return textResult(truncate(text));
    },
  });

  const lsTool = defineTool({
    name: "ls",
    label: "List",
    description: "List files in a directory inside the delegated cwd.",
    parameters: Type.Object({
      path: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      const relativePath = params.path || ".";
      const decision = authorizePiFileTool("LS", { path: relativePath }, input);
      if (!decision.allowed) {
        throw new Error(decision.reason);
      }
      const directory = path.resolve(input.cwd, relativePath);
      const entries = await fs.readdir(directory, { withFileTypes: true });
      return textResult(
        entries
          .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`)
          .sort()
          .join("\n"),
      );
    },
  });

  const findTool = defineTool({
    name: "find",
    label: "Find",
    description: "Find files by substring under a directory inside the delegated cwd.",
    parameters: Type.Object({
      pattern: Type.String(),
      path: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      const root = path.resolve(input.cwd, params.path || ".");
      if (!isSubpath(input.cwd, root)) {
        throw new Error(`tool path escapes cwd: ${params.path || "."}`);
      }
      const results: string[] = [];
      await collectMatchingFiles(input.cwd, root, params.pattern, results);
      return textResult(truncate(results.join("\n")));
    },
  });

  const grepTool = defineTool({
    name: "grep",
    label: "Grep",
    description: "Search text with ripgrep under the delegated cwd.",
    parameters: Type.Object({
      pattern: Type.String(),
      path: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      const searchPath = params.path || ".";
      if (!isAllowedFilePath(searchPath, input.cwd)) {
        throw new Error(`tool path escapes cwd: ${searchPath}`);
      }
      const { stdout, stderr } = await execFileAsync("rg", ["-n", params.pattern, searchPath], {
        cwd: input.cwd,
        maxBuffer: OUTPUT_LIMIT,
      }).catch((error: unknown) => {
        const value = error as { stdout?: string; stderr?: string; code?: number };
        if (value.code === 1) {
          return { stdout: "", stderr: "" };
        }
        throw error;
      });
      return textResult(truncate(stdout || stderr || ""));
    },
  });

  const writeTool = defineTool({
    name: "write",
    label: "Write",
    description: "Write a UTF-8 text file. The MCP permission policy controls writable paths.",
    parameters: Type.Object({
      path: Type.String(),
      content: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      const decision = authorizePiFileTool("Write", { path: params.path }, input);
      if (!decision.allowed) {
        throw new Error(decision.reason);
      }
      const filePath = path.resolve(input.cwd, params.path);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, params.content, "utf8");
      return textResult(`Wrote ${toRelativeDisplay(input.cwd, filePath)}`);
    },
  });

  const editTool = defineTool({
    name: "edit",
    label: "Edit",
    description: "Replace exact text in a UTF-8 file. The MCP permission policy controls writable paths.",
    parameters: Type.Object({
      path: Type.String(),
      oldText: Type.String(),
      newText: Type.String(),
      replaceAll: Type.Optional(Type.Boolean()),
    }),
    execute: async (_toolCallId, params) => {
      const decision = authorizePiFileTool("Edit", { path: params.path }, input);
      if (!decision.allowed) {
        throw new Error(decision.reason);
      }
      const filePath = path.resolve(input.cwd, params.path);
      const before = await fs.readFile(filePath, "utf8");
      if (!before.includes(params.oldText)) {
        throw new Error(`oldText was not found in ${params.path}`);
      }
      const after = params.replaceAll
        ? before.split(params.oldText).join(params.newText)
        : before.replace(params.oldText, params.newText);
      await fs.writeFile(filePath, after, "utf8");
      return textResult(`Edited ${toRelativeDisplay(input.cwd, filePath)}`);
    },
  });

  const bashTool = defineTool({
    name: "bash",
    label: "Bash",
    description: "Run a shell command in cwd after MCP permission checks.",
    parameters: Type.Object({
      command: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      const decision = await authorizePiBash(params.command, input, context);
      context.commandsRun.push({
        command: params.command,
        status: commandStatus(decision),
        reason: decision.reason,
      });

      if (!decision.allowed) {
        throw new Error(decision.reason);
      }

      if (isLikelyVerification(params.command)) {
        context.tests.push({ command: params.command, status: "unknown" });
      }

      const result = await runShell(params.command, input.cwd);
      if (isLikelyVerification(params.command)) {
        updateTestStatus(context.tests, params.command, result.exitCode === 0 ? "passed" : "failed", result.output);
      }
      return textResult(truncate(result.output));
    },
  });

  if (input.subagentType === "repo-scout") {
    return [readTool, lsTool, findTool, grepTool, bashTool];
  }
  if (input.subagentType === "reviewer-helper") {
    return [readTool, lsTool, findTool, grepTool, bashTool];
  }
  return [readTool, lsTool, findTool, grepTool, writeTool, editTool, bashTool];
}

function authorizePiFileTool(
  toolName: "Read" | "LS" | "Write" | "Edit",
  toolInput: Record<string, unknown>,
  input: NormalizedDelegateInput,
) {
  return authorizeTool(toolName, toolInput, input);
}

async function authorizePiBash(command: string, input: NormalizedDelegateInput, context: RunnerContext) {
  const decision = authorizeTool("Bash", { command }, input);
  if (decision.allowed || !decision.requiresApproval || !decision.command) {
    return decision;
  }

  const approved = input.approvedCommands?.some((approvedCommand) => approvedCommand.trim() === command.trim());
  const prefixApproved = input.approvedCommandPrefixes?.some((prefix) => command.trim().startsWith(prefix.trim()));
  if (approved || prefixApproved) {
    return {
      ...decision,
      allowed: true,
      approvedByCodex: true,
      reason: `Codex pre-approved ${approved ? "exact command" : "command prefix"} in delegate_task input`,
    };
  }

  if (!context.commandApprovalHandler) {
    return {
      ...decision,
      allowed: false,
      reason: `${decision.reason}; Codex command approval is not available`,
    };
  }

  const approval = await context.commandApprovalHandler({
    command,
    cwd: input.cwd,
    allowedPaths: input.allowedPaths,
    taskId: input.taskId,
    subagentType: input.subagentType,
    description: input.description,
    prompt: input.prompt,
    policyReason: decision.reason,
  });

  return approval.allowed
    ? {
        ...decision,
        allowed: true,
        approvedByCodex: true,
        reason: `Codex approved command: ${approval.reason}`,
      }
    : {
        ...decision,
        allowed: false,
        reason: `Codex denied command approval: ${approval.reason}`,
      };
}

function commandStatus(decision: { allowed: boolean; writesFiles?: boolean; approvedByCodex?: boolean }): CommandRecord["status"] {
  if (!decision.allowed) {
    return "denied";
  }
  if (decision.writesFiles) {
    return "allowed-write";
  }
  if (decision.approvedByCodex) {
    return "approved";
  }
  return "allowed";
}

async function runShell(command: string, cwd: string): Promise<{ exitCode: number; output: string }> {
  const shell = process.platform === "win32" ? "powershell.exe" : "sh";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-Command", command]
    : ["-lc", command];

  try {
    const { stdout, stderr } = await execFileAsync(shell, args, {
      cwd,
      maxBuffer: OUTPUT_LIMIT,
      env: process.env,
    });
    return { exitCode: 0, output: [stdout, stderr].filter(Boolean).join("\n") };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number };
    return {
      exitCode: typeof failed.code === "number" ? failed.code : 1,
      output: [failed.stdout, failed.stderr].filter(Boolean).join("\n"),
    };
  }
}

async function collectMatchingFiles(cwd: string, current: string, pattern: string, results: string[]): Promise<void> {
  const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".delegate") {
      continue;
    }
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await collectMatchingFiles(cwd, fullPath, pattern, results);
    } else if (entry.isFile() && entry.name.includes(pattern)) {
      results.push(toRelativeDisplay(cwd, fullPath));
    }
  }
}

function observeEvent(
  event: AgentSessionEvent,
  input: NormalizedDelegateInput,
  context: RunnerContext,
  callbacks: { onText: (text: string) => void; onTurn: () => void },
): void {
  void input;
  void context;
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    callbacks.onText(event.assistantMessageEvent.delta);
  }
  if (event.type === "turn_end") {
    callbacks.onTurn();
    callbacks.onText(extractMessageText(event.message) || "");
  }
  if (event.type === "agent_end") {
    const lastText = [...event.messages].reverse().map(extractMessageText).find(Boolean);
    if (lastText) {
      callbacks.onText(lastText);
    }
  }
}

function extractMessageText(message: unknown): string {
  const candidate = message as { role?: string; content?: unknown; text?: unknown };
  if (typeof candidate.text === "string") {
    return candidate.text;
  }
  if (typeof candidate.content === "string") {
    return candidate.content;
  }
  if (Array.isArray(candidate.content)) {
    return candidate.content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
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
    "Use only the available Pi tools. File writes and Bash commands are checked by the MCP permission policy.",
    "If the Codex-authored plan is missing, contradictory, points to nonexistent files, exceeds allowed paths, or needs architectural choices, stop and return a decision request to Codex instead of inventing a new plan.",
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
    ? "Execute the Codex-authored plan in the assignment. Use edit or write for planned file modifications. You may make small local adaptations required by actual symbol names, imports, or formatting, but do not redesign the approach. Bash may be used for project-local build, test, lint, typecheck, and code generation commands."
    : "Execute the Codex-authored plan in the assignment. Use edit or write for planned file modifications. If the plan is wrong or incomplete in a way that changes the approach, stop and ask Codex for a decision.";
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
  };
}

function truncate(value: string): string {
  return value.length > OUTPUT_LIMIT ? `${value.slice(0, OUTPUT_LIMIT)}\n<truncated>` : value;
}

function isLikelyVerification(command: string): boolean {
  return /\b(test|vitest|jest|pytest|typecheck|lint|build|tsc)\b/i.test(command);
}

function updateTestStatus(
  tests: TestRecord[],
  command: string,
  status: TestRecord["status"],
  output: string,
): void {
  const existing = [...tests].reverse().find((test) => test.command === command);
  if (existing) {
    existing.status = status;
    existing.output = truncate(output);
    return;
  }
  tests.push({ command, status, output: truncate(output) });
}

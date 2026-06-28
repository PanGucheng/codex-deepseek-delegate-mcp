import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import type { CommandRecord, NormalizedDelegateInput, TestRecord } from "./types.js";
import { extractToolPaths, isAllowedFilePath, isSubpath } from "./paths.js";

export type CommandDecision = {
  allowed: boolean;
  reason: string;
  command?: string;
  writesFiles?: boolean;
  reviewable?: boolean;
};

type CommandPolicyContext = {
  cwd?: string;
  allowedPaths?: string[];
};

export type CommandReviewRequest = {
  command: string;
  cwd: string;
  allowedPaths?: string[];
  task: string;
  plan?: string;
  policyReason: string;
};

export type CommandReviewDecision = {
  allowed: boolean;
  reason: string;
  model?: string;
};

export type CommandReviewer = (request: CommandReviewRequest) => Promise<CommandReviewDecision>;

type CanUseToolOptions = {
  commandReviewer?: CommandReviewer;
};

const SAFE_READ_ONLY_COMMANDS = [
  /^pwd$/i,
  /^ls(\s|$)/i,
  /^dir(\s|$)/i,
  /^cat\s+/i,
  /^type\s+/i,
  /^get-content\s+/i,
  /^rg(\s|$)/i,
  /^grep(\s|$)/i,
  /^find\s+/i,
  /^node\s+--version$/i,
  /^git\s+(status|diff|log|show|rev-parse|ls-files|branch\s+--show-current)(\s|$)/i,
];

const SAFE_VERIFICATION_COMMANDS = [
  /^npm\s+(test|run\s+(test|build|typecheck|lint|check))(\s|$)/i,
  /^pnpm\s+(test|run\s+(test|build|typecheck|lint|check))(\s|$)/i,
  /^yarn\s+(test|run\s+(test|build|typecheck|lint|check))(\s|$)/i,
  /^bun\s+(test|run\s+(test|build|typecheck|lint|check))(\s|$)/i,
  /^(npx\s+)?(tsc|vitest|jest|eslint)(\s|$)/i,
  /^node\s+[\w./\\-]*(?:^|[./\\-])[\w.-]*test\.[cm]?js(\s|$)/i,
  /^python\s+-m\s+(pytest|unittest|ruff)(\s|$)/i,
  /^pytest(\s|$)/i,
  /^go\s+test(\s|$)/i,
  /^cargo\s+test(\s|$)/i,
  /^mvn\s+test(\s|$)/i,
  /^gradle\s+test(\s|$)/i,
  /^dotnet\s+test(\s|$)/i,
];

const DENIED_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+-(?:[^\s]*r|[^\s]*f|[^\s]*rf|[^\s]*fr)\b/i, "recursive or forced rm is denied"],
  [/\bremove-item\b[\s\S]*\s-(recurse|r)\b/i, "recursive Remove-Item is denied"],
  [/\brmdir\s+\/s\b/i, "recursive rmdir is denied"],
  [/\bdel\s+\/s\b/i, "recursive del is denied"],
  [/\bgit\s+reset\b/i, "git reset is denied"],
  [/\bgit\s+clean\b/i, "git clean is denied"],
  [/\bgit\s+push\b/i, "git push is denied"],
  [/\bgit\s+config\s+--global\b/i, "global git config changes are denied"],
  [/\bnpm\s+config\b/i, "npm config changes are denied"],
  [/\b(?:curl|wget|iwr|invoke-webrequest)\b[\s\S]*(?:\|\s*(?:sh|bash|pwsh|powershell)|\biex\b|\binvoke-expression\b)/i, "download-and-execute commands are denied"],
  [/\b(?:setx|reg\s+(?:add|delete)|chmod\s+777)\b/i, "global or broad permission changes are denied"],
];

export function classifyCommand(
  command: string,
  context: CommandPolicyContext = {},
): CommandDecision {
  const trimmed = command.trim();
  if (!trimmed) {
    return { allowed: false, reason: "empty command", command };
  }

  for (const [pattern, reason] of DENIED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { allowed: false, reason, command: trimmed };
    }
  }

  const normalized = normalizeCommandCwd(trimmed, context);
  if (!normalized.allowed) {
    return normalized;
  }

  const normalizedCommand = normalized.command || trimmed;
  const safeWrite = parseSafeWriteCommand(normalizedCommand);
  if (safeWrite) {
    if (!context.cwd) {
      return {
        allowed: false,
        reason: "file write command requires cwd policy context",
        command: trimmed,
      };
    }

    const deniedPath = safeWrite.targetPaths.find(
      (targetPath) =>
        !isWriteTargetAllowed(targetPath, normalized.cwd || context.cwd!, context.cwd!, context.allowedPaths),
    );

    if (deniedPath) {
      return {
        allowed: false,
        reason: `file write target escapes cwd or allowedPaths: ${deniedPath}`,
        command: trimmed,
      };
    }

    return {
      allowed: true,
      reason: `file write command is allowed for ${safeWrite.targetPaths.join(", ")}`,
      command: trimmed,
      writesFiles: true,
    };
  }

  if (hasShellRedirection(normalizedCommand)) {
    return {
      allowed: false,
      reason: "shell redirection is allowed only for simple, parseable file writes",
      command: trimmed,
    };
  }

  const parts = splitCommand(normalizedCommand);
  if (parts.length === 0) {
    return { allowed: false, reason: "empty command", command: trimmed };
  }

  for (const part of parts) {
    if (!isSafeSubcommand(part)) {
      return {
        allowed: false,
        reason: `command is not in the default allowlist: ${part}`,
        command: trimmed,
        reviewable: true,
      };
    }
  }

  return { allowed: true, reason: "command is allowed by the default policy", command: trimmed };
}

function splitCommand(command: string): string[] {
  return command
    .split(/\s*(?:&&|\|\||;)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function isSafeSubcommand(command: string): boolean {
  return [...SAFE_READ_ONLY_COMMANDS, ...SAFE_VERIFICATION_COMMANDS].some((pattern) =>
    pattern.test(command),
  );
}

export function isVerificationCommand(command: string): boolean {
  const normalized = stripLeadingCd(command.trim());
  return SAFE_VERIFICATION_COMMANDS.some((pattern) => pattern.test(normalized));
}

export function createCanUseTool(
  input: NormalizedDelegateInput,
  commandsRun: CommandRecord[],
  tests: TestRecord[],
  options: CanUseToolOptions = {},
): CanUseTool {
  return async (toolName, toolInput, toolOptions): Promise<PermissionResult> => {
    const decision = await reviewIfNeeded(
      authorizeTool(toolName, toolInput, input),
      input,
      options.commandReviewer,
    );

    if (decision.command) {
      commandsRun.push({
        command: decision.command,
        status: commandStatus(decision),
        reason: decision.reason,
      });

      if (decision.allowed && isVerificationCommand(decision.command)) {
        tests.push({ command: decision.command, status: "unknown" });
      }
    }

    if (!decision.allowed) {
      return {
        behavior: "deny",
        message: decision.reason,
        interrupt: true,
      };
    }

    return {
      behavior: "allow",
      updatedInput: toolInput,
      toolUseID: toolOptions.toolUseID,
    };
  };
}

export function authorizeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  input: NormalizedDelegateInput,
): CommandDecision {
  if (toolName === "Bash") {
    const command = String(toolInput.command || "");
    if (input.subagentType === "repo-scout") {
      return {
        allowed: false,
        reason: "repo-scout is read-only and cannot use Bash",
        command,
      };
    }
    return classifyCommand(command, {
      cwd: input.cwd,
      allowedPaths: input.allowedPaths,
    });
  }

  const allowedToolNames =
    input.subagentType === "repo-scout"
      ? new Set(["Read", "LS", "Grep", "Glob"])
      : new Set(["Read", "Edit", "MultiEdit", "Write", "LS", "Grep", "Glob", "TodoWrite"]);
  if (!allowedToolNames.has(toolName)) {
    return {
      allowed: false,
      reason: `tool is not available to ${input.subagentType}: ${toolName}`,
    };
  }

  for (const candidate of extractToolPaths(toolName, toolInput)) {
    if (toolName === "Read" && isReadOnlyMetadataPath(candidate, input)) {
      continue;
    }

    const allowed = isWriteTool(toolName)
      ? isAllowedFilePath(candidate, input.cwd, input.allowedPaths)
      : isAllowedFilePath(candidate, input.cwd);
    if (!allowed) {
      return {
        allowed: false,
        reason: isWriteTool(toolName)
          ? `tool path escapes cwd or allowedPaths: ${candidate}`
          : `tool path escapes cwd: ${candidate}`,
      };
    }
  }

  return { allowed: true, reason: "tool is allowed by the default policy" };
}

function isWriteTool(toolName: string): boolean {
  return toolName === "Edit" || toolName === "MultiEdit" || toolName === "Write";
}

function isReadOnlyMetadataPath(candidate: string, input: NormalizedDelegateInput): boolean {
  const resolved = path.resolve(input.cwd, candidate);
  if (input.assignmentFilePath && resolved === path.resolve(input.assignmentFilePath)) {
    return true;
  }

  return Boolean(input.contextFiles?.some((file) => resolved === path.resolve(file)));
}

async function reviewIfNeeded(
  decision: CommandDecision,
  input: NormalizedDelegateInput,
  commandReviewer?: CommandReviewer,
): Promise<CommandDecision> {
  if (decision.allowed || !decision.reviewable || !decision.command) {
    return decision;
  }

  if (!commandReviewer) {
    return {
      ...decision,
      allowed: false,
      reason: `${decision.reason}; GPT command reviewer is not configured`,
    };
  }

  try {
    const review = await commandReviewer({
      command: decision.command,
      cwd: input.cwd,
      allowedPaths: input.allowedPaths,
      task: input.prompt,
      plan: input.description,
      policyReason: decision.reason,
    });

    if (!review.allowed) {
      return {
        ...decision,
        allowed: false,
        reason: `GPT command reviewer denied: ${review.reason}`,
      };
    }

    const modelSuffix = review.model ? ` (${review.model})` : "";
    return {
      ...decision,
      allowed: true,
      writesFiles: false,
      reason: `GPT command reviewer allowed${modelSuffix}: ${review.reason}`,
      reviewable: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...decision,
      allowed: false,
      reason: `GPT command reviewer failed closed: ${message}`,
    };
  }
}

function commandStatus(decision: CommandDecision): CommandRecord["status"] {
  if (!decision.allowed) {
    return "denied";
  }

  if (decision.writesFiles) {
    return "allowed-write";
  }

  if (decision.reviewable) {
    return "allowed-review";
  }

  return "allowed";
}

function normalizeCommandCwd(
  command: string,
  context: CommandPolicyContext,
): CommandDecision & { cwd?: string } {
  const cdPrefix = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s&;]+))\s*&&\s*([\s\S]+)$/i.exec(command);
  if (!cdPrefix) {
    return {
      allowed: true,
      reason: "command cwd did not change",
      command,
      cwd: context.cwd,
    };
  }

  if (!context.cwd) {
    return {
      allowed: false,
      reason: "cd command requires cwd policy context",
      command,
    };
  }

  const requestedCwd = cdPrefix[1] || cdPrefix[2] || cdPrefix[3];
  const nextCommand = cdPrefix[4].trim();
  const resolvedCwd = path.resolve(context.cwd, requestedCwd);

  if (!isSubpath(context.cwd, resolvedCwd)) {
    return {
      allowed: false,
      reason: `cd target escapes cwd: ${requestedCwd}`,
      command,
    };
  }

  return {
    allowed: true,
    reason: "command cwd is allowed",
    command: nextCommand,
    cwd: resolvedCwd,
  };
}

function stripLeadingCd(command: string): string {
  const cdPrefix = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s&;]+))\s*&&\s*([\s\S]+)$/i.exec(command);
  return cdPrefix ? cdPrefix[4].trim() : command;
}

function parseSafeWriteCommand(command: string): { targetPaths: string[] } | undefined {
  const redirectionTarget = parseSimpleRedirectionWrite(command);
  if (redirectionTarget) {
    return { targetPaths: [redirectionTarget] };
  }

  const powershellTarget = parsePowerShellWrite(command);
  if (powershellTarget) {
    return { targetPaths: [powershellTarget] };
  }

  const sedTarget = parseSedInPlaceWrite(command);
  if (sedTarget) {
    return { targetPaths: [sedTarget] };
  }

  const nodeTargets = parseNodeWrite(command);
  if (nodeTargets.length > 0) {
    return { targetPaths: nodeTargets };
  }

  const pythonTargets = parsePythonWrite(command);
  if (pythonTargets.length > 0) {
    return { targetPaths: pythonTargets };
  }

  return undefined;
}

function parseSimpleRedirectionWrite(command: string): string | undefined {
  const echoLike = /^\s*(?:echo|printf)\b[\s\S]+?\s>{1,2}\s*(?:"([^"]+)"|'([^']+)'|([^\s&|;<>]+))\s*$/i.exec(command);
  if (echoLike) {
    return echoLike[1] || echoLike[2] || echoLike[3];
  }

  const heredoc = /^\s*cat\s+>{1,2}\s*(?:"([^"]+)"|'([^']+)'|([^\s&|;<>]+))\s+<<\w+/i.exec(command);
  if (heredoc) {
    return heredoc[1] || heredoc[2] || heredoc[3];
  }

  return undefined;
}

function parsePowerShellWrite(command: string): string | undefined {
  const match = /\b(?:set-content|out-file)\b[\s\S]*?-(?:literalpath|filepath|path)\s+(?:"([^"]+)"|'([^']+)'|([^\s|;]+))/i.exec(command);
  return match ? match[1] || match[2] || match[3] : undefined;
}

function parseSedInPlaceWrite(command: string): string | undefined {
  const match = /^\s*sed\s+-i\s+(?:"s(.).+\1.*\1[gp]*"|'s(.).+\2.*\2[gp]*')\s+(?:"([^"]+)"|'([^']+)'|([^\s&|;<>]+))\s*$/i.exec(command);
  return match ? match[3] || match[4] || match[5] : undefined;
}

function parseNodeWrite(command: string): string[] {
  const script = parseInlineScript(command, "node");
  if (!script) {
    return [];
  }

  return collectMatches(
    script,
    /(?:writeFileSync|writeFile)\s*\(\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/gi,
  );
}

function parsePythonWrite(command: string): string[] {
  const script = parseInlineScript(command, "python");
  if (!script) {
    return [];
  }

  return [
    ...collectMatches(script, /\bopen\s*\(\s*(?:"([^"]+)"|'([^']+)')\s*,\s*(?:"[wa]"|'[wa]')/gi),
    ...collectMatches(script, /Path\s*\(\s*(?:"([^"]+)"|'([^']+)')\s*\)\.write_(?:text|bytes)\s*\(/gi),
  ];
}

function parseInlineScript(command: string, executable: "node" | "python"): string | undefined {
  const match = new RegExp(`^\\s*${executable}\\s+-[ec]\\s+(?:"([\\s\\S]*)"|'([\\s\\S]*)')\\s*$`, "i").exec(command);
  return match ? match[1] || match[2] : undefined;
}

function collectMatches(source: string, pattern: RegExp): string[] {
  const result: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const value = match[1] || match[2] || match[3];
    if (value) {
      result.push(value);
    }
  }
  return result;
}

function hasShellRedirection(command: string): boolean {
  return /(?:^|\s)(?:>{1,2}|<)(?:\s|\S)/.test(command);
}

function isWriteTargetAllowed(
  targetPath: string,
  commandCwd: string,
  rootCwd: string,
  allowedPaths?: string[],
): boolean {
  const resolved = resolveWriteTarget(commandCwd, targetPath);

  if (!isSubpath(rootCwd, resolved)) {
    return false;
  }

  if (!allowedPaths || allowedPaths.length === 0) {
    return true;
  }

  return allowedPaths.some((allowed) => isSubpath(allowed, resolved));
}

function resolveWriteTarget(commandCwd: string, targetPath: string): string {
  const msysPath = /^\/([a-zA-Z])\/(.+)$/.exec(targetPath);
  if (msysPath && process.platform === "win32") {
    return path.resolve(`${msysPath[1].toUpperCase()}:/${msysPath[2]}`);
  }

  return path.resolve(commandCwd, targetPath);
}

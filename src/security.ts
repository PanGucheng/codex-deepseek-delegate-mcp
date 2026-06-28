import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { CommandRecord, NormalizedDelegateInput, TestRecord } from "./types.js";
import { extractToolPaths, isAllowedFilePath } from "./paths.js";

type CommandDecision = {
  allowed: boolean;
  reason: string;
  command?: string;
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
  [/[<>]\s*\S+/, "shell redirection is denied by the default policy"],
];

export function classifyCommand(command: string): CommandDecision {
  const trimmed = command.trim();
  if (!trimmed) {
    return { allowed: false, reason: "empty command", command };
  }

  for (const [pattern, reason] of DENIED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { allowed: false, reason, command: trimmed };
    }
  }

  const parts = splitCommand(trimmed);
  if (parts.length === 0) {
    return { allowed: false, reason: "empty command", command: trimmed };
  }

  for (const part of parts) {
    if (!isSafeSubcommand(part)) {
      return {
        allowed: false,
        reason: `command is not in the default allowlist: ${part}`,
        command: trimmed,
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
  return SAFE_VERIFICATION_COMMANDS.some((pattern) => pattern.test(command.trim()));
}

export function createCanUseTool(
  input: NormalizedDelegateInput,
  commandsRun: CommandRecord[],
  tests: TestRecord[],
): CanUseTool {
  return async (toolName, toolInput): Promise<PermissionResult> => {
    const decision = authorizeTool(toolName, toolInput, input);

    if (decision.command) {
      commandsRun.push({
        command: decision.command,
        status: decision.allowed ? "allowed" : "denied",
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

    return { behavior: "allow" };
  };
}

export function authorizeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  input: NormalizedDelegateInput,
): CommandDecision {
  if (toolName === "Bash") {
    const command = String(toolInput.command || "");
    return classifyCommand(command);
  }

  const allowedToolNames = new Set(["Read", "Edit", "MultiEdit", "Write", "LS", "Grep", "Glob", "TodoWrite"]);
  if (!allowedToolNames.has(toolName)) {
    return {
      allowed: false,
      reason: `tool is not available to the delegated worker: ${toolName}`,
    };
  }

  for (const candidate of extractToolPaths(toolName, toolInput)) {
    if (!isAllowedFilePath(candidate, input.cwd, input.allowedFiles)) {
      return {
        allowed: false,
        reason: `tool path escapes cwd or allowedFiles: ${candidate}`,
      };
    }
  }

  return { allowed: true, reason: "tool is allowed by the default policy" };
}

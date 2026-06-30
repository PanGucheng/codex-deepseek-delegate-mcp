import { promises as fs } from "node:fs";
import path from "node:path";
import type { DelegateResult, NormalizedDelegateInput } from "./types.js";

export type SessionLog = {
  sessionId: string;
  directory: string;
  eventsPath: string;
  assignmentPath: string;
  append(event: string, payload: unknown): Promise<void>;
  writeAssignment(input: NormalizedDelegateInput): Promise<string>;
  writeResult(result: DelegateResult): Promise<void>;
};

export async function createSessionLog(cwd: string, request: unknown): Promise<SessionLog> {
  const sessionId = createSessionId();
  const directory = path.join(cwd, ".delegate", "sessions", sessionId);
  const eventsPath = path.join(directory, "events.jsonl");
  const assignmentPath = path.join(directory, "assignment.md");

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "request.json"),
    `${JSON.stringify(sanitizeRequest(request), null, 2)}\n`,
    "utf8",
  );

  return {
    sessionId,
    directory,
    eventsPath,
    assignmentPath,
    async append(event, payload) {
      await fs.appendFile(
        eventsPath,
        `${JSON.stringify({ ts: new Date().toISOString(), event, payload })}\n`,
        "utf8",
      );
    },
    async writeAssignment(input) {
      await fs.writeFile(
        assignmentPath,
        await formatAssignment(sessionId, input),
        "utf8",
      );
      return assignmentPath;
    },
    async writeResult(result) {
      await fs.writeFile(
        path.join(directory, "result.json"),
        `${JSON.stringify(result, null, 2)}\n`,
        "utf8",
      );
    },
  };
}

async function formatAssignment(
  sessionId: string,
  input: NormalizedDelegateInput,
): Promise<string> {
  const allowedPaths = input.allowedPaths?.length
    ? input.allowedPaths.map((file) => `- ${file}`).join("\n")
    : "- Any file under cwd, unless blocked by tool policy";
  const contextFiles = input.contextFiles?.length
    ? input.contextFiles.map((file) => `- ${file}`).join("\n")
    : "- None";
  const approvedCommands = input.approvedCommands?.length
    ? input.approvedCommands.map((command) => `- \`${command}\``).join("\n")
    : "- None";
  const approvedCommandPrefixes = input.approvedCommandPrefixes?.length
    ? input.approvedCommandPrefixes.map((command) => `- \`${command}\``).join("\n")
    : "- None";
  const executionPlan = input.executionPlan?.length
    ? input.executionPlan.map((step, index) => `${index + 1}. ${step}`).join("\n")
    : "- No structured execution plan was provided. If this is an implementer task, ask Codex for a plan before making non-trivial changes.";
  const acceptanceCriteria = input.acceptanceCriteria?.length
    ? input.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")
    : "- None provided";
  const contextFileContents = await formatContextFileContents(input.contextFiles || []);

  return [
    "# DeepSeek Delegate Assignment",
    "",
    `Delegate session: ${sessionId}`,
    `Task ID: ${input.taskId}`,
    `Subagent type: ${input.subagentType}`,
    `Description: ${input.description}`,
    `cwd: ${input.cwd}`,
    `workspaceRoot: ${input.workspaceRoot}`,
    `maxTurns: ${input.maxTurns ?? "unlimited"}`,
    `runVerification: ${input.runVerification ? "true" : "false"}`,
    `bashPolicy: ${input.bashPolicy || "strict"}`,
    `fallbackPolicy: ${input.fallbackPolicy}`,
    `resumed: ${input.resumed ? "true" : "false"}`,
    "",
    "## Prompt",
    "",
    input.prompt,
    "",
    "## Codex Execution Plan",
    "",
    executionPlan,
    "",
    "## Acceptance Criteria",
    "",
    acceptanceCriteria,
    "",
    "## Allowed Write Scope",
    "",
    allowedPaths,
    "",
    "## Context Files",
    "",
    contextFiles,
    "",
    "## Pre-Approved Commands",
    "",
    approvedCommands,
    "",
    "## Pre-Approved Command Prefixes",
    "",
    approvedCommandPrefixes,
    "",
    "## Context File Contents",
    "",
    contextFileContents,
    "",
    "## Execution Rules",
    "",
    "- This assignment supersedes any previous task goal, path scope, or verification instruction in the resumed worker conversation.",
    "- Codex owns planning and final review. The worker executes the Codex Execution Plan; it must not invent a different implementation strategy.",
    "- If the plan is missing, contradictory, points to nonexistent files, requires edits outside allowedPaths, or needs an architectural decision, stop and return a decision request to Codex.",
    "- Small local adaptations are allowed only when they preserve the plan, such as actual symbol names, imports, formatting, and nearby test names.",
    "- Implement or investigate only inside cwd and the allowed scope for this task.",
    "- Context files are read-only references, even when they are outside cwd or allowedPaths.",
    "- Do not modify global configuration, push commits, or run destructive commands.",
    "- Do not call other subagents or task tools. Subagent depth is fixed at 1.",
    "- Exact Pre-Approved Commands and Pre-Approved Command Prefixes may be used only for this task. They do not override hard-dangerous command denials.",
    "- Bash policy modes: strict allows known read-only and verification commands; balanced allows normal project-local build, test, lint, typecheck, script, and generation commands; trusted allows most project-local commands except hard-denied operations.",
    input.subagentType === "reviewer-helper"
      ? "- You are read-only: do not edit files, do not install dependencies, and do not use Bash to write files."
      : "",
    "- Finish with a compact report containing Summary, Changed files, Commands run, Tests, and Risks.",
    "",
  ].filter((line) => line !== "").join("\n");
}

async function formatContextFileContents(contextFiles: string[]): Promise<string> {
  if (contextFiles.length === 0) {
    return "(No context files provided.)";
  }

  const sections = await Promise.all(
    contextFiles.map(async (file) => {
      try {
        const text = await fs.readFile(file, "utf8");
        return [`### ${file}`, "", "```text", truncate(text, 20_000), "```"].join("\n");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return [`### ${file}`, "", `Unable to read context file: ${message}`].join("\n");
      }
    }),
  );

  return sections.join("\n\n");
}

function sanitizeRequest(request: unknown): unknown {
  return redactSecrets(truncateStrings(request));
}

function truncateStrings(value: unknown, max = 50_000): unknown {
  if (typeof value === "string") {
    return truncate(value, max);
  }

  if (Array.isArray(value)) {
    return value.map((item) => truncateStrings(item, max));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, truncateStrings(item, max)]),
    );
  }

  return value;
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /(key|token|secret|password)/i.test(key) ? "<redacted>" : redactSecrets(item),
      ]),
    );
  }

  return value;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n<truncated>` : value;
}

function createSessionId(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${suffix}`;
}

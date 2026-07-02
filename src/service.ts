import { promises as fs } from "node:fs";
import path from "node:path";
import { ConfigError, getWorkspaceRoot } from "./config.js";
import {
  createFileSnapshot,
  diffSnapshots,
  getGitChangedFiles,
  isSubpath,
  normalizeInput,
} from "./paths.js";
import { createRunnerFromEnv } from "./runner.js";
import { createSessionLog } from "./session-log.js";
import {
  createTaskId,
  readTaskSessionRegistry,
  rememberTaskSession,
  resolveResumeTask,
  type TaskSessionRecord,
} from "./task-session-store.js";
import {
  DelegateError,
  DelegateHistoryInputSchema,
  DelegateInputSchema,
  DelegateStatusInputSchema,
  DelegateTaskInputSchema,
  type DelegateInput,
  type DelegateResult,
  type CommandApprovalHandler,
  type DelegateRunner,
  type DelegateTaskInput,
  type NormalizedDelegateInput,
  type RunnerContext,
  type SubagentType,
} from "./types.js";

export type ExecuteDelegateOptions = {
  runner?: DelegateRunner;
  env?: NodeJS.ProcessEnv;
  commandApprovalHandler?: CommandApprovalHandler;
};

export async function executeDelegateTask(
  rawInput: unknown,
  options: ExecuteDelegateOptions = {},
): Promise<DelegateResult> {
  const env = options.env || process.env;
  const workspaceRoot = path.resolve(getWorkspaceRoot(env, getRequestedCwd(rawInput)));
  const parsed = DelegateTaskInputSchema.safeParse(rawInput);

  if (!parsed.success) {
    return createBlockedResult(workspaceRoot, {
      taskId: "task_invalid",
      subagentType: "implementer",
      request: rawInput,
      summary: parsed.error.message,
    });
  }

  let input: NormalizedDelegateInput;
  try {
    input = await prepareTaskInput(parsed.data, workspaceRoot);
  } catch (error) {
    return createBlockedResult(workspaceRoot, {
      taskId: parsed.data.taskId || "task_blocked",
      subagentType: parsed.data.subagentType,
      request: parsed.data,
      summary: errorToSummary(error),
    });
  }

  return runDelegateTask(input, parsed.data, options);
}

export async function executeDelegate(
  rawInput: unknown,
  options: ExecuteDelegateOptions = {},
): Promise<DelegateResult> {
  const env = options.env || process.env;
  const workspaceRoot = path.resolve(getWorkspaceRoot(env, getRequestedCwd(rawInput)));
  const parsed = DelegateInputSchema.safeParse(rawInput);

  if (!parsed.success) {
    return createBlockedResult(workspaceRoot, {
      taskId: "task_invalid",
      subagentType: "implementer",
      request: rawInput,
      summary: parsed.error.message,
    });
  }

  return executeDelegateTask(legacyToTaskInput(parsed.data), options);
}

export async function getDelegateStatus(
  rawInput: unknown,
  options: ExecuteDelegateOptions = {},
): Promise<Record<string, unknown>> {
  const env = options.env || process.env;
  const workspaceRoot = path.resolve(getWorkspaceRoot(env, getRequestedCwd(rawInput)));
  const parsed = DelegateStatusInputSchema.safeParse(rawInput);

  if (!parsed.success) {
    return {
      found: false,
      taskId: "task_invalid",
      summary: parsed.error.message,
    };
  }

  let cwd: string;
  try {
    cwd = resolveCwdInsideWorkspace(parsed.data.cwd, workspaceRoot);
  } catch (error) {
    return {
      found: false,
      taskId: parsed.data.taskId,
      summary: errorToSummary(error),
    };
  }

  const registry = await readTaskSessionRegistry(cwd);
  const record = registry.tasks[parsed.data.taskId];
  if (!record) {
    return {
      found: false,
      taskId: parsed.data.taskId,
    };
  }

  return toPublicStatus(record, parsed.data.includeLastResult);
}

export async function getDelegateHistory(
  rawInput: unknown,
  options: ExecuteDelegateOptions = {},
): Promise<Record<string, unknown>> {
  const env = options.env || process.env;
  const workspaceRoot = path.resolve(getWorkspaceRoot(env, getRequestedCwd(rawInput)));
  const parsed = DelegateHistoryInputSchema.safeParse(rawInput);

  if (!parsed.success) {
    return {
      cwd: workspaceRoot,
      tasks: [],
      summary: parsed.error.message,
    };
  }

  let cwd: string;
  try {
    cwd = resolveCwdInsideWorkspace(parsed.data.cwd, workspaceRoot);
  } catch (error) {
    return {
      cwd: workspaceRoot,
      tasks: [],
      summary: errorToSummary(error),
    };
  }

  const registry = await readTaskSessionRegistry(cwd);
  const records = Object.values(registry.tasks)
    .filter((record) => !parsed.data.subagentType || record.subagentType === parsed.data.subagentType)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const tasks = [];
  for (const record of records) {
    const result = await readLastResult(record);
    if (parsed.data.status && result?.status !== parsed.data.status) {
      continue;
    }
    tasks.push(toPublicHistoryItem(record, result));
    if (tasks.length >= parsed.data.limit) {
      break;
    }
  }

  return {
    cwd,
    tasks,
  };
}

async function prepareTaskInput(
  input: DelegateTaskInput,
  workspaceRoot: string,
): Promise<NormalizedDelegateInput> {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedCwd = path.resolve(input.cwd || resolvedRoot);

  if (!isSubpath(resolvedRoot, resolvedCwd)) {
    throw new DelegateError(
      `cwd must stay inside workspace root. workspaceRoot=${resolvedRoot} cwd=${resolvedCwd}`,
      "blocked",
    );
  }

  const task = await resolveResumeTask({
    cwd: resolvedCwd,
    taskId: input.taskId,
    subagentType: input.subagentType,
  });

  return normalizeInput(
    {
      ...input,
      taskId: task.taskId,
      resumeSdkSessionId: task.record?.sdkSessionId,
      resumed: task.resumed,
    },
    resolvedRoot,
  );
}

function resolveCwdInsideWorkspace(cwd: string | undefined, workspaceRoot: string): string {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedCwd = path.resolve(cwd || resolvedRoot);

  if (!isSubpath(resolvedRoot, resolvedCwd)) {
    throw new DelegateError(
      `cwd must stay inside workspace root. workspaceRoot=${resolvedRoot} cwd=${resolvedCwd}`,
      "blocked",
    );
  }

  return resolvedCwd;
}

async function runDelegateTask(
  input: NormalizedDelegateInput,
  request: DelegateTaskInput,
  options: ExecuteDelegateOptions,
): Promise<DelegateResult> {
  const log = await createSessionLog(input.cwd, request);
  input = {
    ...input,
    handoffFilePath: log.handoffPath,
    handoffDirectory: log.handoffDirectory,
  };
  const assignmentFilePath = await log.writeAssignment(input);
  input = {
    ...input,
    assignmentFilePath,
  };

  const commandsRun: DelegateResult["commandsRun"] = [];
  const tests: DelegateResult["tests"] = [];
  const runner = options.runner || createRunnerFromEnv(options.env || process.env);
  const runnerContext: RunnerContext = {
    sessionId: log.sessionId,
    logPath: log.directory,
    commandsRun,
    tests,
    commandApprovalHandler: options.commandApprovalHandler,
  };

  await log.append("start", {
    taskId: input.taskId,
    subagentType: input.subagentType,
    cwd: input.cwd,
    workspaceRoot: input.workspaceRoot,
    allowedPaths: input.allowedPaths,
    contextFiles: input.contextFiles,
    approvedCommandPrefixes: input.approvedCommandPrefixes,
    executionPlan: input.executionPlan,
    acceptanceCriteria: input.acceptanceCriteria,
    fallbackPolicy: input.fallbackPolicy,
    bashPolicy: input.bashPolicy,
    maxTurns: input.maxTurns,
    assignmentFilePath: input.assignmentFilePath,
    resumed: input.resumed,
    resumeSdkSessionId: input.resumeSdkSessionId,
  });

  const before = await createFileSnapshot(input.cwd);
  let result: DelegateResult;

  try {
    result = await runner.run(input, runnerContext);
  } catch (error) {
    const denied = commandsRun.find((command) => command.status === "denied");
    const status =
      denied || error instanceof ConfigError || isBlockedDelegateError(error) ? "blocked" : "failed";
    result = {
      taskId: input.taskId,
      subagentType: input.subagentType,
      status,
      summary: denied?.reason || errorToSummary(error),
      changedFiles: [],
      artifactFiles: [],
      commandsRun,
      tests,
      sessionId: log.sessionId,
      logPath: log.directory,
      handoffFile: toRelativeDelegatePath(input.cwd, log.handoffPath),
      evidenceFiles: [],
      sdkSessionId: runnerContext.sdkSessionId,
      sdkModel: runnerContext.sdkModel,
      resumed: input.resumed,
    };
  }

  const after = await createFileSnapshot(input.cwd);
  const snapshotChangedFiles = diffSnapshots(before, after);
  const gitChangedFiles = await getGitChangedFiles(input.cwd);
  const classifiedFiles = classifyChangedFiles([
    ...result.changedFiles,
    ...(gitChangedFiles ?? snapshotChangedFiles),
  ]);
  const evidenceFiles = await listEvidenceFiles(input.cwd, log.handoffDirectory);
  const handoffFile = (await fileExists(log.handoffPath))
    ? toRelativeDelegatePath(input.cwd, log.handoffPath)
    : undefined;

  const finalResult: DelegateResult = {
    ...result,
    taskId: input.taskId,
    subagentType: input.subagentType,
    changedFiles: classifiedFiles.changedFiles,
    artifactFiles: classifiedFiles.artifactFiles,
    commandsRun: uniqueCommands(result.commandsRun),
    tests: result.tests,
    sessionId: log.sessionId,
    logPath: log.directory,
    handoffFile,
    evidenceFiles,
    sdkSessionId: result.sdkSessionId || runnerContext.sdkSessionId,
    sdkModel: result.sdkModel || runnerContext.sdkModel,
    resumed: input.resumed,
  };

  if (finalResult.sdkSessionId && finalResult.sdkModel) {
    await rememberTaskSession({
      cwd: input.cwd,
      taskId: input.taskId,
      sdkSessionId: finalResult.sdkSessionId,
      subagentType: input.subagentType,
      model: finalResult.sdkModel,
      allowedPaths: input.allowedPaths,
      delegateSessionId: log.sessionId,
    });
  }

  await log.writeResult(finalResult);
  await log.append("finish", {
    taskId: finalResult.taskId,
    subagentType: finalResult.subagentType,
    status: finalResult.status,
    changedFiles: finalResult.changedFiles,
    artifactFiles: finalResult.artifactFiles,
    commandsRun: finalResult.commandsRun,
    tests: finalResult.tests,
    sdkSessionId: finalResult.sdkSessionId,
    handoffFile: finalResult.handoffFile,
    evidenceFiles: finalResult.evidenceFiles,
  });

  return finalResult;
}

function legacyToTaskInput(input: DelegateInput): DelegateTaskInput {
  return {
    subagentType: "implementer",
    description: firstLine(input.task),
    prompt: [
      input.task,
      "",
      "Plan from Codex:",
      input.plan || "(No separate plan provided. Infer the smallest safe implementation.)",
    ].join("\n"),
    cwd: input.cwd,
    allowedPaths: input.allowedFiles,
    taskId: input.taskId,
    maxTurns: input.maxTurns,
    runVerification: input.runVerification,
  };
}

async function createBlockedResult(
  workspaceRoot: string,
  {
    taskId,
    subagentType,
    request,
    summary,
  }: {
    taskId: string;
    subagentType: SubagentType;
    request: unknown;
    summary: string;
  },
): Promise<DelegateResult> {
  const log = await createSessionLog(workspaceRoot, request);
  const result: DelegateResult = {
    taskId: taskId === "task_blocked" ? createTaskId() : taskId,
    subagentType,
    status: "blocked",
    summary,
    changedFiles: [],
    artifactFiles: [],
    commandsRun: [],
    tests: [],
    sessionId: log.sessionId,
    logPath: log.directory,
    handoffFile: undefined,
    evidenceFiles: [],
    resumed: false,
  };
  await log.writeResult(result);
  return result;
}

function errorToSummary(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isBlockedDelegateError(error: unknown): boolean {
  return error instanceof DelegateError && error.status === "blocked";
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function classifyChangedFiles(values: string[]): { changedFiles: string[]; artifactFiles: string[] } {
  const changedFiles: string[] = [];
  const artifactFiles: string[] = [];

  for (const value of uniqueSorted(values.map(normalizeRelativePath))) {
    if (!value || isDelegateMetadataPath(value)) {
      continue;
    }

    if (isVerificationArtifactPath(value)) {
      artifactFiles.push(value);
      continue;
    }

    changedFiles.push(value);
  }

  return {
    changedFiles,
    artifactFiles,
  };
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isDelegateMetadataPath(value: string): boolean {
  return value === ".delegate" || value.startsWith(".delegate/");
}

function isVerificationArtifactPath(value: string): boolean {
  return (
    value.startsWith("dist/") ||
    value.startsWith("build/") ||
    value.startsWith("coverage/") ||
    value.startsWith(".cache/") ||
    value.startsWith(".turbo/") ||
    value.startsWith(".vite/") ||
    value.endsWith(".tsbuildinfo")
  );
}

function uniqueCommands(commands: DelegateResult["commandsRun"]): DelegateResult["commandsRun"] {
  const seen = new Set<string>();
  const result: DelegateResult["commandsRun"] = [];
  for (const command of commands) {
    const key = `${command.command}\0${command.status}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(command);
  }
  return result;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() || "Delegated implementation task";
}

function getRequestedCwd(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== "object") {
    return undefined;
  }

  const cwd = (rawInput as { cwd?: unknown }).cwd;
  return typeof cwd === "string" && cwd.trim().length > 0 ? cwd : undefined;
}

async function readLastResult(record: TaskSessionRecord): Promise<DelegateResult | undefined> {
  try {
    const resultPath = path.join(record.cwd, ".delegate", "sessions", record.lastDelegateSessionId, "result.json");
    const text = await fs.readFile(resultPath, "utf8");
    return JSON.parse(text) as DelegateResult;
  } catch {
    return undefined;
  }
}

async function toPublicStatus(record: TaskSessionRecord, includeLastResult: boolean) {
  const lastResult = includeLastResult ? await readLastResult(record) : undefined;
  return {
    taskId: record.taskId,
    found: true,
    subagentType: record.subagentType,
    cwd: record.cwd,
    model: record.model,
    sdkSessionKnown: Boolean(record.sdkSessionId),
    allowedPaths: record.allowedPaths,
    lastDelegateSessionId: record.lastDelegateSessionId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(lastResult ? { lastResult: toPublicLastResult(lastResult) } : {}),
  };
}

function toPublicHistoryItem(record: TaskSessionRecord, result: DelegateResult | undefined) {
  return {
    taskId: record.taskId,
    subagentType: record.subagentType,
    updatedAt: record.updatedAt,
    lastDelegateSessionId: record.lastDelegateSessionId,
    ...(result
      ? {
          status: result.status,
          summary: result.summary,
          changedFiles: result.changedFiles,
          artifactFiles: result.artifactFiles,
          tests: result.tests.map(({ command, status }) => ({ command, status })),
          handoffFile: result.handoffFile,
          evidenceFiles: result.evidenceFiles,
        }
      : {}),
  };
}

function toPublicLastResult(result: DelegateResult) {
  return {
    status: result.status,
    summary: result.summary,
    changedFiles: result.changedFiles,
    artifactFiles: result.artifactFiles,
    tests: result.tests.map(({ command, status }) => ({ command, status })),
    handoffFile: result.handoffFile,
    evidenceFiles: result.evidenceFiles,
    resumed: result.resumed,
  };
}

async function listEvidenceFiles(cwd: string, handoffDirectory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(handoffDirectory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => toRelativeDelegatePath(cwd, path.join(handoffDirectory, entry.name)))
      .sort();
  } catch {
    return [];
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function toRelativeDelegatePath(cwd: string, filePath: string): string {
  return path.relative(cwd, filePath).split(path.sep).join("/");
}

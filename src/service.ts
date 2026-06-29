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
  rememberTaskSession,
  resolveResumeTask,
} from "./task-session-store.js";
import {
  DelegateError,
  DelegateInputSchema,
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

async function runDelegateTask(
  input: NormalizedDelegateInput,
  request: DelegateTaskInput,
  options: ExecuteDelegateOptions,
): Promise<DelegateResult> {
  const log = await createSessionLog(input.cwd, request);
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
      commandsRun,
      tests,
      sessionId: log.sessionId,
      logPath: log.directory,
      sdkSessionId: runnerContext.sdkSessionId,
      sdkModel: runnerContext.sdkModel,
      resumed: input.resumed,
    };
  }

  const after = await createFileSnapshot(input.cwd);
  const snapshotChangedFiles = diffSnapshots(before, after);
  const gitChangedFiles = await getGitChangedFiles(input.cwd);
  const changedFiles = uniqueSorted([
    ...result.changedFiles,
    ...(gitChangedFiles ?? snapshotChangedFiles),
  ]);

  const finalResult: DelegateResult = {
    ...result,
    taskId: input.taskId,
    subagentType: input.subagentType,
    changedFiles,
    commandsRun: uniqueCommands(result.commandsRun),
    tests: result.tests,
    sessionId: log.sessionId,
    logPath: log.directory,
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
    commandsRun: finalResult.commandsRun,
    tests: finalResult.tests,
    sdkSessionId: finalResult.sdkSessionId,
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
    commandsRun: [],
    tests: [],
    sessionId: log.sessionId,
    logPath: log.directory,
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

import path from "node:path";
import { ConfigError } from "./config.js";
import { getWorkspaceRoot } from "./config.js";
import {
  createFileSnapshot,
  diffSnapshots,
  getGitChangedFiles,
  normalizeInput,
} from "./paths.js";
import { createRunnerFromEnv } from "./runner.js";
import { createSessionLog } from "./session-log.js";
import {
  DelegateError,
  DelegateInputSchema,
  type DelegateInput,
  type DelegateResult,
  type DelegateRunner,
} from "./types.js";

export type ExecuteDelegateOptions = {
  runner?: DelegateRunner;
  env?: NodeJS.ProcessEnv;
};

export async function executeDelegate(
  rawInput: unknown,
  options: ExecuteDelegateOptions = {},
): Promise<DelegateResult> {
  const env = options.env || process.env;
  const workspaceRoot = path.resolve(getWorkspaceRoot(env));
  const parsed = DelegateInputSchema.safeParse(rawInput);

  if (!parsed.success) {
    return createBlockedResult(workspaceRoot, {
      task: "<invalid>",
      maxTurns: 1,
      runVerification: false,
    }, parsed.error.message);
  }

  let input;
  try {
    input = normalizeInput(parsed.data, workspaceRoot);
  } catch (error) {
    return createBlockedResult(workspaceRoot, parsed.data, errorToSummary(error));
  }

  const log = await createSessionLog(input.cwd, parsed.data);
  const commandsRun: DelegateResult["commandsRun"] = [];
  const tests: DelegateResult["tests"] = [];
  const runner = options.runner || createRunnerFromEnv(env);

  await log.append("start", {
    cwd: input.cwd,
    workspaceRoot: input.workspaceRoot,
    allowedFiles: input.allowedFiles,
    maxTurns: input.maxTurns,
  });

  const before = await createFileSnapshot(input.cwd);
  let result: DelegateResult;

  try {
    result = await runner.run(input, {
      sessionId: log.sessionId,
      logPath: log.directory,
      commandsRun,
      tests,
    });
  } catch (error) {
    const denied = commandsRun.find((command) => command.status === "denied");
    const status =
      denied || error instanceof ConfigError || isBlockedDelegateError(error) ? "blocked" : "failed";
    result = {
      status,
      summary: denied?.reason || errorToSummary(error),
      changedFiles: [],
      commandsRun,
      tests,
      sessionId: log.sessionId,
      logPath: log.directory,
    };
  }

  const after = await createFileSnapshot(input.cwd);
  const snapshotChangedFiles = diffSnapshots(before, after);
  const gitChangedFiles = await getGitChangedFiles(input.cwd);
  const changedFiles = uniqueSorted([
    ...result.changedFiles,
    ...(gitChangedFiles ?? snapshotChangedFiles),
  ]);

  const finalResult = {
    ...result,
    changedFiles,
    commandsRun: uniqueCommands(result.commandsRun),
    tests: result.tests,
    sessionId: log.sessionId,
    logPath: log.directory,
  };

  await log.writeResult(finalResult);
  await log.append("finish", {
    status: finalResult.status,
    changedFiles: finalResult.changedFiles,
    commandsRun: finalResult.commandsRun,
    tests: finalResult.tests,
  });

  return finalResult;
}

async function createBlockedResult(
  workspaceRoot: string,
  input: DelegateInput,
  summary: string,
): Promise<DelegateResult> {
  const log = await createSessionLog(workspaceRoot, input);
  const result: DelegateResult = {
    status: "blocked",
    summary,
    changedFiles: [],
    commandsRun: [],
    tests: [],
    sessionId: log.sessionId,
    logPath: log.directory,
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

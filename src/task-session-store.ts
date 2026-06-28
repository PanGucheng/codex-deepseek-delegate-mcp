import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { DelegateError, type SubagentType } from "./types.js";

const REGISTRY_VERSION = 1;

export type TaskSessionRecord = {
  taskId: string;
  sdkSessionId: string;
  subagentType: SubagentType;
  cwd: string;
  model: string;
  allowedPaths?: string[];
  lastDelegateSessionId: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskSessionRegistry = {
  version: number;
  tasks: Record<string, TaskSessionRecord>;
};

export function createTaskId(): string {
  return `task_${crypto.randomUUID()}`;
}

export function getTaskSessionRegistryPath(cwd: string): string {
  return path.join(cwd, ".delegate", "tasks.json");
}

export async function resolveResumeTask({
  cwd,
  taskId,
  subagentType,
}: {
  cwd: string;
  taskId?: string;
  subagentType: SubagentType;
}): Promise<{ taskId: string; record?: TaskSessionRecord; resumed: boolean }> {
  if (!taskId) {
    return {
      taskId: createTaskId(),
      resumed: false,
    };
  }

  const registry = await readTaskSessionRegistry(cwd);
  const record = registry.tasks[taskId];
  if (!record) {
    throw new DelegateError(`taskId was not found in .delegate/tasks.json: ${taskId}`, "blocked");
  }

  if (record.subagentType !== subagentType) {
    throw new DelegateError(
      `taskId ${taskId} belongs to ${record.subagentType}, not ${subagentType}`,
      "blocked",
    );
  }

  return {
    taskId,
    record,
    resumed: true,
  };
}

export async function rememberTaskSession({
  cwd,
  taskId,
  sdkSessionId,
  subagentType,
  model,
  allowedPaths,
  delegateSessionId,
}: {
  cwd: string;
  taskId: string;
  sdkSessionId: string;
  subagentType: SubagentType;
  model: string;
  allowedPaths?: string[];
  delegateSessionId: string;
}): Promise<void> {
  const registry = await readTaskSessionRegistry(cwd);
  const existing = registry.tasks[taskId];
  const now = new Date().toISOString();

  registry.tasks[taskId] = {
    taskId,
    sdkSessionId,
    subagentType,
    cwd: path.resolve(cwd),
    model,
    allowedPaths,
    lastDelegateSessionId: delegateSessionId,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  await writeTaskSessionRegistry(cwd, registry);
}

export async function readTaskSessionRegistry(cwd: string): Promise<TaskSessionRegistry> {
  try {
    const text = await fs.readFile(getTaskSessionRegistryPath(cwd), "utf8");
    const parsed = JSON.parse(text) as TaskSessionRegistry;
    if (!parsed || parsed.version !== REGISTRY_VERSION || !parsed.tasks) {
      return emptyRegistry();
    }
    return parsed;
  } catch {
    return emptyRegistry();
  }
}

async function writeTaskSessionRegistry(cwd: string, registry: TaskSessionRegistry): Promise<void> {
  const registryPath = getTaskSessionRegistryPath(cwd);
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

function emptyRegistry(): TaskSessionRegistry {
  return {
    version: REGISTRY_VERSION,
    tasks: {},
  };
}

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTaskId,
  getTaskSessionRegistryPath,
  readTaskSessionRegistry,
  rememberTaskSession,
  resolveResumeTask,
} from "../src/task-session-store.js";

describe("task session store", () => {
  it("creates fresh task ids without auto-resuming by cwd", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "delegate-task-session-"));

    const first = await resolveResumeTask({ cwd, subagentType: "implementer" });
    const second = await resolveResumeTask({ cwd, subagentType: "implementer" });

    expect(first.taskId).toMatch(/^task_/);
    expect(second.taskId).toMatch(/^task_/);
    expect(first.taskId).not.toBe(second.taskId);
    expect(first.resumed).toBe(false);
    expect(second.resumed).toBe(false);
  });

  it("remembers and resolves a taskId to an SDK session", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "delegate-task-session-"));
    const taskId = createTaskId();

    await rememberTaskSession({
      cwd,
      taskId,
      sdkSessionId: "11111111-1111-4111-8111-111111111111",
      subagentType: "implementer",
      model: "deepseek-test",
      allowedPaths: [path.join(cwd, "src")],
      delegateSessionId: "delegate-1",
    });

    const resolved = await resolveResumeTask({ cwd, taskId, subagentType: "implementer" });

    expect(resolved.resumed).toBe(true);
    expect(resolved.record?.sdkSessionId).toBe("11111111-1111-4111-8111-111111111111");
    await expect(fs.stat(getTaskSessionRegistryPath(cwd))).resolves.toBeTruthy();
  });

  it("blocks unknown task ids and subagent type mismatches", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "delegate-task-session-"));
    await expect(
      resolveResumeTask({ cwd, taskId: "task_missing", subagentType: "implementer" }),
    ).rejects.toThrow(/taskId was not found/);

    const taskId = createTaskId();
    await rememberTaskSession({
      cwd,
      taskId,
      sdkSessionId: "11111111-1111-4111-8111-111111111111",
      subagentType: "repo-scout",
      model: "deepseek-test",
      delegateSessionId: "delegate-1",
    });

    await expect(
      resolveResumeTask({ cwd, taskId, subagentType: "implementer" }),
    ).rejects.toThrow(/belongs to repo-scout/);

    const registry = await readTaskSessionRegistry(cwd);
    expect(registry.tasks[taskId]?.subagentType).toBe("repo-scout");
  });
});

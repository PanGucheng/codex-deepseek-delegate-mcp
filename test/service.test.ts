import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeDelegate, executeDelegateTask } from "../src/service.js";
import { readTaskSessionRegistry } from "../src/task-session-store.js";
import type { DelegateResult, DelegateRunner, NormalizedDelegateInput, RunnerContext } from "../src/types.js";

class FileWritingRunner implements DelegateRunner {
  lastInput?: NormalizedDelegateInput;

  async run(input: NormalizedDelegateInput, context: RunnerContext): Promise<DelegateResult> {
    this.lastInput = input;
    await fs.writeFile(path.join(input.cwd, "worker-output.txt"), "done", "utf8");
    return {
      taskId: input.taskId,
      subagentType: input.subagentType,
      status: "completed",
      summary: "wrote worker-output.txt",
      changedFiles: [],
      commandsRun: context.commandsRun,
      tests: context.tests,
      sessionId: context.sessionId,
      logPath: context.logPath,
      sdkSessionId: "11111111-1111-4111-8111-111111111111",
      sdkModel: "deepseek-test",
      resumed: input.resumed,
    };
  }
}

describe("executeDelegate", () => {
  it("keeps the legacy delegate_execute wrapper working", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "delegate-service-"));
    const runner = new FileWritingRunner();
    const result = await executeDelegate(
      {
        task: "write a file",
        plan: "create worker-output.txt",
        cwd,
        maxTurns: 1,
        runVerification: false,
      },
      {
        runner,
        env: { DEEPSEEK_DELEGATE_WORKSPACE_ROOT: cwd },
      },
    );

    expect(result.taskId).toMatch(/^task_/);
    expect(result.subagentType).toBe("implementer");
    expect(result.status).toBe("completed");
    expect(result.changedFiles).toContain("worker-output.txt");
    await expect(fs.stat(path.join(result.logPath, "result.json"))).resolves.toBeTruthy();
    expect(runner.lastInput?.assignmentFilePath).toBe(path.join(result.logPath, "assignment.md"));

    const assignment = await fs.readFile(runner.lastInput!.assignmentFilePath!, "utf8");
    expect(assignment).toContain("Subagent type: implementer");
    expect(assignment).toContain("## Prompt");
    expect(assignment).toContain("write a file");
    expect(assignment).toContain("create worker-output.txt");
  });

  it("creates a fresh task registry record for delegate_task", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "delegate-task-service-"));
    const runner = new FileWritingRunner();
    const result = await executeDelegateTask(
      {
        subagentType: "implementer",
        description: "write worker output",
        prompt: "write a file",
        cwd,
        allowedPaths: ["src/**"],
        contextFiles: [],
        maxTurns: 1,
        runVerification: false,
      },
      {
        runner,
        env: { DEEPSEEK_DELEGATE_WORKSPACE_ROOT: cwd },
      },
    );

    expect(result.status).toBe("completed");
    expect(result.taskId).toMatch(/^task_/);
    expect(runner.lastInput?.resumed).toBe(false);
    expect(runner.lastInput?.allowedPaths?.[0]).toBe(path.join(cwd, "src"));

    const registry = await readTaskSessionRegistry(cwd);
    expect(registry.tasks[result.taskId]).toMatchObject({
      taskId: result.taskId,
      sdkSessionId: "11111111-1111-4111-8111-111111111111",
      subagentType: "implementer",
      model: "deepseek-test",
    });
  });

  it("uses the requested cwd as workspace root when installed globally", async () => {
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "delegate-install-"));
    const targetProject = await fs.mkdtemp(path.join(os.tmpdir(), "delegate-target-"));
    const previousCwd = process.cwd();
    const runner = new FileWritingRunner();

    try {
      process.chdir(installDir);
      const result = await executeDelegateTask(
        {
          subagentType: "implementer",
          description: "write from global install",
          prompt: "write a file",
          cwd: targetProject,
          allowedPaths: ["worker-output.txt"],
          maxTurns: 1,
          runVerification: false,
        },
        {
          runner,
          env: {},
        },
      );

      expect(result.status).toBe("completed");
      expect(result.changedFiles).toContain("worker-output.txt");
      expect(runner.lastInput?.workspaceRoot).toBe(path.resolve(targetProject));
      await expect(fs.stat(path.join(targetProject, ".delegate", "tasks.json"))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(installDir, ".delegate"))).rejects.toThrow();
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("blocks an unknown taskId before invoking the runner", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "delegate-task-service-"));
    const runner = new FileWritingRunner();
    const result = await executeDelegateTask(
      {
        subagentType: "implementer",
        description: "resume missing task",
        prompt: "continue",
        taskId: "task_missing",
        cwd,
        maxTurns: 1,
        runVerification: false,
      },
      {
        runner,
        env: { DEEPSEEK_DELEGATE_WORKSPACE_ROOT: cwd },
      },
    );

    expect(result.status).toBe("blocked");
    expect(result.taskId).toBe("task_missing");
    expect(result.summary).toMatch(/taskId was not found/);
    expect(runner.lastInput).toBeUndefined();
  });

  it("blocks invalid cwd before invoking a runner", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "delegate-root-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "delegate-outside-"));

    const result = await executeDelegate(
      {
        task: "escape",
        cwd: outside,
        maxTurns: 1,
        runVerification: false,
      },
      {
        runner: new FileWritingRunner(),
        env: { DEEPSEEK_DELEGATE_WORKSPACE_ROOT: root },
      },
    );

    expect(result.status).toBe("blocked");
    expect(result.summary).toMatch(/cwd must stay inside workspace root/);
  });
});

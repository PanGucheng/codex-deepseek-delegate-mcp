import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  executeDelegate,
  executeDelegateTask,
  getDelegateHistory,
  getDelegateStatus,
} from "../src/service.js";
import { readTaskSessionRegistry } from "../src/task-session-store.js";
import type { DelegateResult, DelegateRunner, NormalizedDelegateInput, RunnerContext } from "../src/types.js";

class FileWritingRunner implements DelegateRunner {
  lastInput?: NormalizedDelegateInput;

  async run(input: NormalizedDelegateInput, context: RunnerContext): Promise<DelegateResult> {
    this.lastInput = input;
    await fs.writeFile(path.join(input.cwd, "worker-output.txt"), "done", "utf8");
    if (input.handoffFilePath && input.handoffDirectory) {
      await fs.writeFile(
        input.handoffFilePath,
        [
          "# Codex Handoff",
          "",
          "Summary: wrote worker-output.txt.",
          "Verification: mock runner did not run commands.",
          "Risks: none in fixture.",
        ].join("\n"),
        "utf8",
      );
      await fs.writeFile(path.join(input.handoffDirectory, "verification.txt"), "mock evidence", "utf8");
    }
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
      handoffFile: input.handoffFilePath
        ? path.relative(input.cwd, input.handoffFilePath).split(path.sep).join("/")
        : undefined,
      evidenceFiles: input.handoffDirectory
        ? [path.relative(input.cwd, path.join(input.handoffDirectory, "verification.txt")).split(path.sep).join("/")]
        : [],
      sdkSessionId: "11111111-1111-4111-8111-111111111111",
      sdkModel: "deepseek-test",
      resumed: input.resumed,
    };
  }
}

class FailingSessionRunner implements DelegateRunner {
  lastInput?: NormalizedDelegateInput;

  async run(input: NormalizedDelegateInput, context: RunnerContext): Promise<DelegateResult> {
    this.lastInput = input;
    await fs.writeFile(path.join(input.cwd, "partial-output.txt"), "partial", "utf8");
    return {
      taskId: input.taskId,
      subagentType: input.subagentType,
      status: "failed",
      summary: "stopped before final answer",
      changedFiles: [],
      commandsRun: context.commandsRun,
      tests: context.tests,
      sessionId: context.sessionId,
      logPath: context.logPath,
      sdkSessionId: "33333333-3333-4333-8333-333333333333",
      sdkModel: "deepseek-test",
      resumed: input.resumed,
    };
  }
}

class ThrowingObservedSessionRunner implements DelegateRunner {
  lastInput?: NormalizedDelegateInput;

  async run(input: NormalizedDelegateInput, context: RunnerContext): Promise<DelegateResult> {
    this.lastInput = input;
    context.sdkSessionId = "44444444-4444-4444-8444-444444444444";
    context.sdkModel = "deepseek-test";
    await fs.writeFile(path.join(input.cwd, "partial-before-throw.txt"), "partial", "utf8");
    throw new Error("Delegate worker returned an error result: Reached maximum number of turns (4)");
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
        executionPlan: ["Create worker-output.txt in the target project."],
        acceptanceCriteria: ["worker-output.txt exists."],
        approvedCommandPrefixes: ["npm run build"],
        runVerification: false,
      },
      {
        runner,
        env: { DEEPSEEK_DELEGATE_WORKSPACE_ROOT: cwd },
      },
    );

    expect(result.status).toBe("completed");
    expect(result.taskId).toMatch(/^task_/);
    expect(result.handoffFile).toMatch(/^\.delegate\/sessions\/.+\/handoff\.md$/);
    expect(result.evidenceFiles).toEqual([
      expect.stringMatching(/^\.delegate\/sessions\/.+\/handoff\/verification\.txt$/),
    ]);
    expect(runner.lastInput?.resumed).toBe(false);
    expect(runner.lastInput?.allowedPaths?.[0]).toBe(path.join(cwd, "src"));
    expect(runner.lastInput?.maxTurns).toBe(100);
    expect(runner.lastInput?.bashPolicy).toBe("balanced");

    const registry = await readTaskSessionRegistry(cwd);
    expect(registry.tasks[result.taskId]).toMatchObject({
      taskId: result.taskId,
      sdkSessionId: "11111111-1111-4111-8111-111111111111",
      subagentType: "implementer",
      model: "deepseek-test",
    });

    const assignment = await fs.readFile(runner.lastInput!.assignmentFilePath!, "utf8");
    expect(assignment).toContain("maxTurns: 100");
    expect(assignment).toContain("handoffFile:");
    expect(assignment).toContain("handoffDirectory:");
    expect(assignment).toContain("curated Codex handoff");
    expect(assignment).toContain("bashPolicy: balanced");
    expect(assignment).toContain("## Codex Execution Plan");
    expect(assignment).toContain("Create worker-output.txt");
    expect(assignment).toContain("## Acceptance Criteria");
    expect(assignment).toContain("worker-output.txt exists");
    expect(assignment).toContain("## Pre-Approved Command Prefixes");
    expect(assignment).toContain("npm run build");
    await expect(fs.readFile(path.join(cwd, result.handoffFile!), "utf8")).resolves.toContain("Codex Handoff");
  });

  it("returns public delegate status and history without private fields", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "delegate-task-query-"));
    const runner = new FileWritingRunner();
    const result = await executeDelegateTask(
      {
        subagentType: "implementer",
        description: "write worker output",
        prompt: "write a file",
        cwd,
        maxTurns: 1,
        runVerification: false,
      },
      {
        runner,
        env: { DEEPSEEK_DELEGATE_WORKSPACE_ROOT: cwd },
      },
    );

    const status = await getDelegateStatus(
      {
        cwd,
        taskId: result.taskId,
      },
      {
        env: { DEEPSEEK_DELEGATE_WORKSPACE_ROOT: cwd },
      },
    );

    expect(status).toMatchObject({
      taskId: result.taskId,
      found: true,
      subagentType: "implementer",
      sdkSessionKnown: true,
    });
    expect(status).toHaveProperty("lastResult");
    expect(JSON.stringify(status)).toContain("handoff.md");
    expect(status).not.toHaveProperty("sdkSessionId");
    expect(status).not.toHaveProperty("logPath");
    expect(status).not.toHaveProperty("commandsRun");
    expect(JSON.stringify(status)).not.toContain("11111111-1111-4111-8111-111111111111");

    const history = await getDelegateHistory(
      {
        cwd,
        limit: 5,
      },
      {
        env: { DEEPSEEK_DELEGATE_WORKSPACE_ROOT: cwd },
      },
    );

    const tasks = history.tasks as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      taskId: result.taskId,
      subagentType: "implementer",
      status: "completed",
    });
    expect(JSON.stringify(history)).not.toContain("commandsRun");
    expect(JSON.stringify(history)).not.toContain("sdkSessionId");
    expect(JSON.stringify(history)).not.toContain("logPath");
    expect(JSON.stringify(history)).toContain("handoff.md");

    const missing = await getDelegateStatus(
      {
        cwd,
        taskId: "task_missing",
      },
      {
        env: { DEEPSEEK_DELEGATE_WORKSPACE_ROOT: cwd },
      },
    );
    expect(missing).toEqual({ found: false, taskId: "task_missing" });
  });

  it("remembers failed child sessions when the SDK session id is available", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "delegate-task-failed-"));
    const failingRunner = new FailingSessionRunner();
    const failed = await executeDelegateTask(
      {
        subagentType: "implementer",
        description: "partial write before turn limit",
        prompt: "write a partial file",
        cwd,
        maxTurns: 1,
        runVerification: false,
      },
      {
        runner: failingRunner,
        env: { DEEPSEEK_DELEGATE_WORKSPACE_ROOT: cwd },
      },
    );

    expect(failed.status).toBe("failed");
    expect(failed.changedFiles).toContain("partial-output.txt");

    const registry = await readTaskSessionRegistry(cwd);
    expect(registry.tasks[failed.taskId]).toMatchObject({
      taskId: failed.taskId,
      sdkSessionId: "33333333-3333-4333-8333-333333333333",
      subagentType: "implementer",
      model: "deepseek-test",
    });

    const resumedRunner = new FileWritingRunner();
    const resumed = await executeDelegateTask(
      {
        subagentType: "implementer",
        description: "continue partial task",
        prompt: "finish the partial file task",
        taskId: failed.taskId,
        cwd,
        maxTurns: 1,
        runVerification: false,
      },
      {
        runner: resumedRunner,
        env: { DEEPSEEK_DELEGATE_WORKSPACE_ROOT: cwd },
      },
    );

    expect(resumed.status).toBe("completed");
    expect(resumedRunner.lastInput?.resumed).toBe(true);
    expect(resumedRunner.lastInput?.resumeSdkSessionId).toBe(
      "33333333-3333-4333-8333-333333333333",
    );
  });

  it("remembers observed SDK sessions when the runner throws after maxTurns", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "delegate-task-thrown-"));
    const throwingRunner = new ThrowingObservedSessionRunner();
    const failed = await executeDelegateTask(
      {
        subagentType: "implementer",
        description: "partial write before SDK throws",
        prompt: "write a partial file then hit max turns",
        cwd,
        maxTurns: 4,
        runVerification: false,
      },
      {
        runner: throwingRunner,
        env: { DEEPSEEK_DELEGATE_WORKSPACE_ROOT: cwd },
      },
    );

    expect(failed.status).toBe("failed");
    expect(failed.summary).toContain("Reached maximum number of turns");
    expect(failed.changedFiles).toContain("partial-before-throw.txt");

    const registry = await readTaskSessionRegistry(cwd);
    expect(registry.tasks[failed.taskId]).toMatchObject({
      taskId: failed.taskId,
      sdkSessionId: "44444444-4444-4444-8444-444444444444",
      subagentType: "implementer",
      model: "deepseek-test",
    });

    const resumedRunner = new FileWritingRunner();
    const resumed = await executeDelegateTask(
      {
        subagentType: "implementer",
        description: "resume thrown SDK task",
        prompt: "finish after max turns",
        taskId: failed.taskId,
        cwd,
        maxTurns: 1,
        runVerification: false,
      },
      {
        runner: resumedRunner,
        env: { DEEPSEEK_DELEGATE_WORKSPACE_ROOT: cwd },
      },
    );

    expect(resumed.status).toBe("completed");
    expect(resumedRunner.lastInput?.resumed).toBe(true);
    expect(resumedRunner.lastInput?.resumeSdkSessionId).toBe(
      "44444444-4444-4444-8444-444444444444",
    );
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

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeDelegate } from "../src/service.js";
import type { DelegateResult, DelegateRunner, NormalizedDelegateInput, RunnerContext } from "../src/types.js";

class FileWritingRunner implements DelegateRunner {
  async run(input: NormalizedDelegateInput, context: RunnerContext): Promise<DelegateResult> {
    await fs.writeFile(path.join(input.cwd, "worker-output.txt"), "done", "utf8");
    return {
      status: "completed",
      summary: "wrote worker-output.txt",
      changedFiles: [],
      commandsRun: context.commandsRun,
      tests: context.tests,
      sessionId: context.sessionId,
      logPath: context.logPath,
    };
  }
}

describe("executeDelegate", () => {
  it("returns changed files and writes a result log", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "delegate-service-"));
    const result = await executeDelegate(
      {
        task: "write a file",
        cwd,
        maxTurns: 1,
        runVerification: false,
      },
      {
        runner: new FileWritingRunner(),
        env: { DEEPSEEK_DELEGATE_WORKSPACE_ROOT: cwd },
      },
    );

    expect(result.status).toBe("completed");
    expect(result.changedFiles).toContain("worker-output.txt");
    await expect(fs.stat(path.join(result.logPath, "result.json"))).resolves.toBeTruthy();
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

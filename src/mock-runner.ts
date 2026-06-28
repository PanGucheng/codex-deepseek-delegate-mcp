import type { DelegateResult, DelegateRunner, NormalizedDelegateInput, RunnerContext } from "./types.js";

export class MockRunner implements DelegateRunner {
  async run(input: NormalizedDelegateInput, context: RunnerContext): Promise<DelegateResult> {
    await Promise.resolve();

    if (input.task.toLowerCase().includes("block")) {
      return {
        status: "blocked",
        summary: "Mock runner blocked the task by request.",
        changedFiles: [],
        commandsRun: context.commandsRun,
        tests: context.tests,
        sessionId: context.sessionId,
        logPath: context.logPath,
      };
    }

    return {
      status: "completed",
      summary: "Mock runner completed without changing files.",
      changedFiles: [],
      commandsRun: context.commandsRun,
      tests: context.tests,
      sessionId: context.sessionId,
      logPath: context.logPath,
    };
  }
}

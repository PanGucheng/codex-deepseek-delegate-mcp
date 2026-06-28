import type { DelegateResult, DelegateRunner, NormalizedDelegateInput, RunnerContext } from "./types.js";

export class MockRunner implements DelegateRunner {
  async run(input: NormalizedDelegateInput, context: RunnerContext): Promise<DelegateResult> {
    await Promise.resolve();

    if (input.prompt.toLowerCase().includes("block")) {
      return {
        taskId: input.taskId,
        subagentType: input.subagentType,
        status: "blocked",
        summary: "Mock runner blocked the task by request.",
        changedFiles: [],
        commandsRun: context.commandsRun,
        tests: context.tests,
        sessionId: context.sessionId,
        logPath: context.logPath,
        resumed: input.resumed,
      };
    }

    return {
      taskId: input.taskId,
      subagentType: input.subagentType,
      status: "completed",
      summary: "Mock runner completed without changing files.",
      changedFiles: [],
      commandsRun: context.commandsRun,
      tests: context.tests,
      sessionId: context.sessionId,
      logPath: context.logPath,
      sdkSessionId: "00000000-0000-4000-8000-000000000000",
      sdkModel: "mock-model",
      resumed: input.resumed,
    };
  }
}

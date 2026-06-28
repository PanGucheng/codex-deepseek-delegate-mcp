import type { DelegateRunner } from "./types.js";
import { ClaudeRunner } from "./claude-runner.js";
import { MockRunner } from "./mock-runner.js";

export function createRunnerFromEnv(env: NodeJS.ProcessEnv = process.env): DelegateRunner {
  if (env.DEEPSEEK_DELEGATE_MOCK === "1") {
    return new MockRunner();
  }

  return new ClaudeRunner(env);
}

import type { DelegateRunner } from "./types.js";
import { ClaudeRunner } from "./claude-runner.js";
import { MockRunner } from "./mock-runner.js";
import { PiRunner } from "./pi-runner.js";

export function createRunnerFromEnv(env: NodeJS.ProcessEnv = process.env): DelegateRunner {
  if (env.DEEPSEEK_DELEGATE_MOCK === "1") {
    return new MockRunner();
  }

  const runner = env.DEEPSEEK_DELEGATE_RUNNER?.trim().toLowerCase();
  if (runner === "mock") {
    return new MockRunner();
  }
  if (runner === "claude") {
    return new ClaudeRunner(env);
  }
  if (runner && runner !== "pi") {
    throw new Error(
      `Unsupported DEEPSEEK_DELEGATE_RUNNER: ${runner}. Expected pi, claude, or mock.`,
    );
  }

  return new PiRunner(env);
}

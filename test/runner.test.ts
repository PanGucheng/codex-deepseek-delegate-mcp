import { describe, expect, it } from "vitest";
import { ClaudeRunner } from "../src/claude-runner.js";
import { MockRunner } from "../src/mock-runner.js";
import { PiRunner } from "../src/pi-runner.js";
import { createRunnerFromEnv } from "../src/runner.js";

describe("createRunnerFromEnv", () => {
  it("defaults to the Pi runner", () => {
    expect(createRunnerFromEnv({})).toBeInstanceOf(PiRunner);
  });

  it("keeps the legacy mock flag working", () => {
    expect(createRunnerFromEnv({ DEEPSEEK_DELEGATE_MOCK: "1" })).toBeInstanceOf(MockRunner);
  });

  it("allows explicit runner selection", () => {
    expect(createRunnerFromEnv({ DEEPSEEK_DELEGATE_RUNNER: "mock" })).toBeInstanceOf(MockRunner);
    expect(createRunnerFromEnv({ DEEPSEEK_DELEGATE_RUNNER: "claude" })).toBeInstanceOf(ClaudeRunner);
    expect(createRunnerFromEnv({ DEEPSEEK_DELEGATE_RUNNER: "pi" })).toBeInstanceOf(PiRunner);
  });

  it("rejects unsupported runner names", () => {
    expect(() => createRunnerFromEnv({ DEEPSEEK_DELEGATE_RUNNER: "other" })).toThrow(
      "Unsupported DEEPSEEK_DELEGATE_RUNNER",
    );
  });
});

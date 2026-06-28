import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommandReviewer } from "../src/command-reviewer.js";
import { ConfigError } from "../src/config.js";

describe("createCommandReviewer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is disabled when no OpenAI key or reviewer mode is configured", () => {
    expect(createCommandReviewer({})).toBeUndefined();
  });

  it("can be explicitly disabled even when an OpenAI key is present", () => {
    expect(
      createCommandReviewer({
        OPENAI_API_KEY: "test-key",
        DEEPSEEK_DELEGATE_COMMAND_REVIEWER: "off",
      }),
    ).toBeUndefined();
  });

  it("requires an OpenAI key when reviewer mode is openai", () => {
    expect(() =>
      createCommandReviewer({ DEEPSEEK_DELEGATE_COMMAND_REVIEWER: "openai" }),
    ).toThrow(ConfigError);
  });

  it("reviews a command with the OpenAI Responses API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        output_text: JSON.stringify({
          allowed: true,
          reason: "dependency install is scoped to the requested task",
        }),
      }),
    } as Response);

    const reviewer = createCommandReviewer({
      OPENAI_API_KEY: "test-key",
      DEEPSEEK_DELEGATE_COMMAND_REVIEWER: "openai",
      OPENAI_COMMAND_REVIEW_MODEL: "gpt-test",
    });

    const result = await reviewer!({
      command: "npm install left-pad",
      cwd: "E:/repo",
      allowedPaths: ["E:/repo/package.json"],
      task: "add missing dependency",
      plan: "install dependency and run tests",
      policyReason: "command is not in the default allowlist: npm install left-pad",
    });

    expect(result).toEqual({
      allowed: true,
      reason: "dependency install is scoped to the requested task",
      model: "gpt-test",
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.model).toBe("gpt-test");
    expect(JSON.stringify(body)).toContain("npm install left-pad");
    expect(JSON.stringify(body)).not.toContain("test-key");
  });
});

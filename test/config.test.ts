import { describe, expect, it } from "vitest";
import { buildDeepSeekEnv, ConfigError, getWorkspaceRoot } from "../src/config.js";

describe("buildDeepSeekEnv", () => {
  it("requires DEEPSEEK_API_KEY", () => {
    expect(() => buildDeepSeekEnv({})).toThrow(ConfigError);
  });

  it("maps DeepSeek credentials into Anthropic-compatible env vars", () => {
    const result = buildDeepSeekEnv({ DEEPSEEK_API_KEY: "secret" });

    expect(result.env.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
    expect(result.env.ANTHROPIC_AUTH_TOKEN).toBe("secret");
    expect(result.env.ANTHROPIC_API_KEY).toBe("secret");
    expect(result.env.ANTHROPIC_MODEL).toBe("deepseek-v4-pro[1m]");
    expect(result.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("deepseek-v4-flash");
    expect(result.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("deepseek-v4-flash");
  });
});

describe("getWorkspaceRoot", () => {
  it("prefers explicit env root over request cwd", () => {
    expect(
      getWorkspaceRoot(
        { DEEPSEEK_DELEGATE_WORKSPACE_ROOT: "D:/workspace" },
        "D:/workspace/project",
      ),
    ).toBe("D:/workspace");
  });

  it("uses request cwd as the root for global installs without an env root", () => {
    expect(getWorkspaceRoot({}, "D:/target-project")).toBe("D:/target-project");
  });
});

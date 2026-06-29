const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
const DEFAULT_MAIN_MODEL = "deepseek-v4-pro[1m]";
const DEFAULT_SMALL_MODEL = "deepseek-v4-flash";

export type ProcessEnv = NodeJS.ProcessEnv;

export type DeepSeekEnv = {
  env: NodeJS.ProcessEnv;
  apiKey: string;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function getWorkspaceRoot(
  env: ProcessEnv = process.env,
  fallbackCwd?: string,
): string {
  const configuredRoot = env.DEEPSEEK_DELEGATE_WORKSPACE_ROOT?.trim();
  return configuredRoot || fallbackCwd || process.cwd();
}

export function buildDeepSeekEnv(env: ProcessEnv = process.env): DeepSeekEnv {
  const apiKey = env.DEEPSEEK_API_KEY;

  if (!apiKey) {
    throw new ConfigError(
      "DEEPSEEK_API_KEY is required. Configure Codex MCP env_vars to forward it, or set it before starting the server.",
    );
  }

  return {
    apiKey,
    env: {
      ...env,
      ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL || DEEPSEEK_ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_API_KEY: apiKey,
      ANTHROPIC_MODEL: env.ANTHROPIC_MODEL || DEFAULT_MAIN_MODEL,
      ANTHROPIC_DEFAULT_HAIKU_MODEL:
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL || DEFAULT_SMALL_MODEL,
      CLAUDE_CODE_SUBAGENT_MODEL:
        env.CLAUDE_CODE_SUBAGENT_MODEL || DEFAULT_SMALL_MODEL,
      CLAUDE_AGENT_SDK_CLIENT_APP:
        env.CLAUDE_AGENT_SDK_CLIENT_APP || "deepseek-delegate-mcp/0.1.0",
    },
  };
}

export function redactEnv(env: ProcessEnv): ProcessEnv {
  const redacted = { ...env };
  for (const key of Object.keys(redacted)) {
    if (/(key|token|secret|password)/i.test(key)) {
      redacted[key] = "<redacted>";
    }
  }
  return redacted;
}

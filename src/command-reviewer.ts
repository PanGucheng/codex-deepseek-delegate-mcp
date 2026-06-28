import { ConfigError, type ProcessEnv } from "./config.js";
import type {
  CommandReviewDecision,
  CommandReviewer,
  CommandReviewRequest,
} from "./security.js";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_COMMAND_REVIEW_MODEL = "gpt-5.5";

type OpenAIResponsePayload = {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  error?: {
    message?: string;
  };
};

type ParsedReview = {
  allowed: boolean;
  reason: string;
};

export function createCommandReviewer(env: ProcessEnv = process.env): CommandReviewer | undefined {
  const mode = (
    env.DEEPSEEK_DELEGATE_COMMAND_REVIEWER ||
    (env.OPENAI_API_KEY ? "openai" : "off")
  ).toLowerCase();

  if (["off", "none", "disabled", "false", "0"].includes(mode)) {
    return undefined;
  }

  if (mode !== "openai") {
    throw new ConfigError(
      `Unsupported DEEPSEEK_DELEGATE_COMMAND_REVIEWER value: ${mode}. Use "openai" or "off".`,
    );
  }

  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ConfigError(
      "OPENAI_API_KEY is required when DEEPSEEK_DELEGATE_COMMAND_REVIEWER=openai.",
    );
  }

  const model = env.OPENAI_COMMAND_REVIEW_MODEL || DEFAULT_COMMAND_REVIEW_MODEL;
  const baseUrl = (env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");

  return (request) => reviewCommandWithOpenAI({ apiKey, baseUrl, model, request });
}

async function reviewCommandWithOpenAI({
  apiKey,
  baseUrl,
  model,
  request,
}: {
  apiKey: string;
  baseUrl: string;
  model: string;
  request: CommandReviewRequest;
}): Promise<CommandReviewDecision> {
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: COMMAND_REVIEW_SYSTEM_PROMPT }],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify(buildReviewPayload(request)),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "command_review",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["allowed", "reason"],
            properties: {
              allowed: { type: "boolean" },
              reason: { type: "string", minLength: 1, maxLength: 500 },
            },
          },
        },
      },
      max_output_tokens: 300,
    }),
  });

  const payload = (await response.json()) as OpenAIResponsePayload;
  if (!response.ok) {
    throw new Error(
      `OpenAI command review failed with HTTP ${response.status}: ${payload.error?.message || "unknown error"}`,
    );
  }

  const parsed = parseReview(extractResponseText(payload));
  return {
    allowed: parsed.allowed,
    reason: parsed.reason,
    model,
  };
}

function buildReviewPayload(request: CommandReviewRequest): Record<string, unknown> {
  return {
    command: request.command,
    cwd: request.cwd,
    allowedPaths: request.allowedPaths || [],
    task: truncate(request.task, 1200),
    plan: request.plan ? truncate(request.plan, 1800) : "",
    policyReason: request.policyReason,
  };
}

function extractResponseText(payload: OpenAIResponsePayload): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  const pieces: string[] = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (
        (content.type === "output_text" || content.type === "text") &&
        typeof content.text === "string"
      ) {
        pieces.push(content.text);
      }
    }
  }

  const text = pieces.join("\n").trim();
  if (!text) {
    throw new Error("OpenAI command review returned no text");
  }
  return text;
}

function parseReview(text: string): ParsedReview {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("OpenAI command review returned invalid JSON");
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as ParsedReview).allowed !== "boolean" ||
    typeof (parsed as ParsedReview).reason !== "string" ||
    !(parsed as ParsedReview).reason.trim()
  ) {
    throw new Error("OpenAI command review JSON did not match the expected schema");
  }

  return {
    allowed: (parsed as ParsedReview).allowed,
    reason: truncate((parsed as ParsedReview).reason.trim(), 500),
  };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

const COMMAND_REVIEW_SYSTEM_PROMPT = [
  "You review one Bash command requested by a delegated coding worker.",
  "The host has already allowed low-risk read/test commands and scoped file writes.",
  "This command reached you because it is outside the deterministic allowlist.",
  "Allow only when the command is necessary for the task, reasonably scoped to cwd/allowedPaths, and does not create broad system, credential, network, or git-history risk.",
  "Deny destructive commands, recursive deletion, git reset/clean/push, global config changes, credential or secret access, download-and-execute flows, and commands that appear to write outside the allowed scope.",
  "When uncertain, deny. Return only JSON that matches the requested schema.",
].join("\n");

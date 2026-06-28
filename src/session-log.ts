import { promises as fs } from "node:fs";
import path from "node:path";
import type { DelegateInput, DelegateResult } from "./types.js";

export type SessionLog = {
  sessionId: string;
  directory: string;
  eventsPath: string;
  append(event: string, payload: unknown): Promise<void>;
  writeResult(result: DelegateResult): Promise<void>;
};

export async function createSessionLog(cwd: string, input: DelegateInput): Promise<SessionLog> {
  const sessionId = createSessionId();
  const directory = path.join(cwd, ".delegate", "sessions", sessionId);
  const eventsPath = path.join(directory, "events.jsonl");

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "request.json"),
    `${JSON.stringify(sanitizeRequest(input), null, 2)}\n`,
    "utf8",
  );

  return {
    sessionId,
    directory,
    eventsPath,
    async append(event, payload) {
      await fs.appendFile(
        eventsPath,
        `${JSON.stringify({ ts: new Date().toISOString(), event, payload })}\n`,
        "utf8",
      );
    },
    async writeResult(result) {
      await fs.writeFile(
        path.join(directory, "result.json"),
        `${JSON.stringify(result, null, 2)}\n`,
        "utf8",
      );
    },
  };
}

function sanitizeRequest(input: DelegateInput): DelegateInput {
  return {
    ...input,
    task: truncate(input.task),
    plan: input.plan ? truncate(input.plan) : undefined,
  };
}

function truncate(value: string, max = 50_000): string {
  return value.length > max ? `${value.slice(0, max)}\n<truncated>` : value;
}

function createSessionId(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${suffix}`;
}

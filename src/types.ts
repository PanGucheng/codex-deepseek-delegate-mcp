import { z } from "zod";

export const DelegateInputSchema = z
  .object({
    task: z.string().min(1, "task is required"),
    plan: z.string().optional(),
    cwd: z.string().optional(),
    allowedFiles: z.array(z.string().min(1)).optional(),
    maxTurns: z.number().int().min(1).max(100).default(12),
    runVerification: z.boolean().default(true),
  })
  .strict();

export type DelegateInput = z.infer<typeof DelegateInputSchema>;

export type DelegateStatus = "completed" | "blocked" | "failed";

export type CommandStatus = "allowed" | "denied" | "observed";

export type TestStatus = "passed" | "failed" | "unknown";

export type CommandRecord = {
  command: string;
  status: CommandStatus;
  reason?: string;
};

export type TestRecord = {
  command: string;
  status: TestStatus;
  output?: string;
};

export type DelegateResult = {
  status: DelegateStatus;
  summary: string;
  changedFiles: string[];
  commandsRun: CommandRecord[];
  tests: TestRecord[];
  sessionId: string;
  logPath: string;
};

export type NormalizedDelegateInput = Omit<DelegateInput, "cwd" | "allowedFiles"> & {
  cwd: string;
  workspaceRoot: string;
  allowedFiles?: string[];
};

export type RunnerContext = {
  sessionId: string;
  logPath: string;
  commandsRun: CommandRecord[];
  tests: TestRecord[];
};

export interface DelegateRunner {
  run(input: NormalizedDelegateInput, context: RunnerContext): Promise<DelegateResult>;
}

export class DelegateError extends Error {
  constructor(
    message: string,
    public readonly status: DelegateStatus = "failed",
  ) {
    super(message);
    this.name = "DelegateError";
  }
}

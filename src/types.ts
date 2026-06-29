import { z } from "zod";

export const SubagentTypeSchema = z.enum(["repo-scout", "implementer"]);

export const DelegateTaskInputSchema = z
  .object({
    subagentType: SubagentTypeSchema,
    description: z.string().min(1, "description is required"),
    prompt: z.string().min(1, "prompt is required"),
    cwd: z.string().optional(),
    allowedPaths: z.array(z.string().min(1)).optional(),
    contextFiles: z.array(z.string().min(1)).optional(),
    approvedCommands: z.array(z.string().min(1)).optional(),
    taskId: z.string().min(1).max(160).optional(),
    maxTurns: z.number().int().min(1).max(100).default(12),
    runVerification: z.boolean().default(true),
  })
  .strict();

export const DelegateInputSchema = z
  .object({
    task: z.string().min(1, "task is required"),
    plan: z.string().optional(),
    cwd: z.string().optional(),
    allowedFiles: z.array(z.string().min(1)).optional(),
    maxTurns: z.number().int().min(1).max(100).default(12),
    runVerification: z.boolean().default(true),
    conversationMode: z.enum(["reuse", "fresh", "ephemeral"]).default("reuse"),
    conversationKey: z.string().min(1).max(160).optional(),
    taskId: z.string().min(1).max(160).optional(),
  })
  .strict();

export type SubagentType = z.infer<typeof SubagentTypeSchema>;
export type DelegateTaskInput = z.infer<typeof DelegateTaskInputSchema>;
export type DelegateInput = z.infer<typeof DelegateInputSchema>;

export type DelegateStatus = "completed" | "blocked" | "failed";

export type CommandStatus =
  | "allowed"
  | "allowed-write"
  | "approved"
  | "denied"
  | "observed";

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

export type CommandApprovalRequest = {
  command: string;
  cwd: string;
  allowedPaths?: string[];
  taskId: string;
  subagentType: SubagentType;
  description: string;
  prompt: string;
  policyReason: string;
};

export type CommandApprovalDecision = {
  allowed: boolean;
  reason: string;
};

export type CommandApprovalHandler = (
  request: CommandApprovalRequest,
) => Promise<CommandApprovalDecision>;

export type DelegateResult = {
  taskId: string;
  subagentType: SubagentType;
  status: DelegateStatus;
  summary: string;
  changedFiles: string[];
  commandsRun: CommandRecord[];
  tests: TestRecord[];
  sessionId: string;
  logPath: string;
  sdkSessionId?: string;
  sdkModel?: string;
  resumed: boolean;
};

export type NormalizedDelegateInput = Omit<DelegateTaskInput, "cwd" | "allowedPaths" | "contextFiles" | "taskId"> & {
  taskId: string;
  cwd: string;
  workspaceRoot: string;
  allowedPaths?: string[];
  contextFiles?: string[];
  assignmentFilePath?: string;
  resumeSdkSessionId?: string;
  resumed: boolean;
};

export type RunnerContext = {
  sessionId: string;
  logPath: string;
  commandsRun: CommandRecord[];
  tests: TestRecord[];
  commandApprovalHandler?: CommandApprovalHandler;
  sdkSessionId?: string;
  sdkModel?: string;
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

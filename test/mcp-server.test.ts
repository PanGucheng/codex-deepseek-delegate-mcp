import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createDelegateServer } from "../src/mcp-server.js";
import { MockRunner } from "../src/mock-runner.js";
import type { DelegateResult, DelegateRunner, NormalizedDelegateInput, RunnerContext } from "../src/types.js";

class ApprovalProbeRunner implements DelegateRunner {
  async run(input: NormalizedDelegateInput, context: RunnerContext): Promise<DelegateResult> {
    const approval = await context.commandApprovalHandler!({
      command: "npm install left-pad",
      cwd: input.cwd,
      allowedPaths: input.allowedPaths,
      taskId: input.taskId,
      subagentType: input.subagentType,
      description: input.description,
      prompt: input.prompt,
      policyReason: "command is not in the default allowlist: npm install left-pad",
    });

    return {
      taskId: input.taskId,
      subagentType: input.subagentType,
      status: approval.allowed ? "completed" : "blocked",
      summary: approval.reason,
      changedFiles: [],
      commandsRun: context.commandsRun,
      tests: context.tests,
      sessionId: context.sessionId,
      logPath: context.logPath,
      sdkSessionId: "22222222-2222-4222-8222-222222222222",
      sdkModel: "approval-probe",
      resumed: input.resumed,
    };
  }
}

describe("MCP server", () => {
  it("lists and calls delegate_execute over an MCP transport", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "delegate-mcp-"));
    const server = createDelegateServer(new MockRunner(), {
      DEEPSEEK_DELEGATE_WORKSPACE_ROOT: cwd,
    });
    const client = new Client(
      { name: "test-client", version: "0.0.0" },
      { capabilities: { sampling: {} } },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("delegate_execute");
    expect(tools.tools.map((tool) => tool.name)).toContain("delegate_task");

    const result = await client.callTool({
      name: "delegate_task",
      arguments: {
        subagentType: "repo-scout",
        description: "inspect nothing",
        prompt: "inspect nothing",
        cwd,
        maxTurns: 1,
        runVerification: false,
      },
    });

    const structured = result.structuredContent as Record<string, unknown>;
    const content = result.content as Array<{ type: string; text?: string }>;

    expect(structured.taskId).toMatch(/^task_/);
    expect(structured.subagentType).toBe("repo-scout");
    expect(structured.status).toBe("completed");
    expect(structured).toHaveProperty("summary");
    expect(structured).toHaveProperty("changedFiles");
    expect(structured).toHaveProperty("tests");
    expect(structured).not.toHaveProperty("commandsRun");
    expect(structured).not.toHaveProperty("sessionId");
    expect(structured).not.toHaveProperty("logPath");
    expect(content[0]?.type).toBe("text");
    expect(content[0]?.text).not.toContain("commandsRun");
    expect(content[0]?.text).not.toContain("logPath");

    const legacy = await client.callTool({
      name: "delegate_execute",
      arguments: {
        task: "implement nothing",
        cwd,
        maxTurns: 1,
        runVerification: false,
      },
    });
    expect((legacy.structuredContent as Record<string, unknown>).subagentType).toBe("implementer");

    await client.close();
    await server.close();
  });

  it("asks the MCP client to approve commands during a delegate_task call", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "delegate-mcp-approval-"));
    const server = createDelegateServer(new ApprovalProbeRunner(), {
      DEEPSEEK_DELEGATE_WORKSPACE_ROOT: cwd,
    });
    const client = new Client(
      { name: "test-client", version: "0.0.0" },
      { capabilities: { sampling: {} } },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let approvalMessage = "";

    client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
      const content = request.params.messages[0]?.content;
      approvalMessage = Array.isArray(content)
        ? content
            .filter((entry) => entry.type === "text")
            .map((entry) => entry.text)
            .join("\n")
        : content?.type === "text"
          ? content.text
          : "";
      return {
        model: "codex-test",
        role: "assistant",
        content: {
          type: "text",
          text: JSON.stringify({
            allowed: true,
            reason: "approved by Codex test client",
          }),
        },
      };
    });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "delegate_task",
      arguments: {
        subagentType: "implementer",
        description: "approval probe",
        prompt: "request approval",
        cwd,
        maxTurns: 1,
        runVerification: true,
      },
    });

    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.status).toBe("completed");
    expect(structured.summary).toBe("approved by Codex test client");
    expect(approvalMessage).toContain("npm install left-pad");
    expect(approvalMessage).toContain("outside the deterministic allowlist");

    await client.close();
    await server.close();
  });

  it("returns a clear denial when the MCP client does not support sampling approval", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "delegate-mcp-no-sampling-"));
    const server = createDelegateServer(new ApprovalProbeRunner(), {
      DEEPSEEK_DELEGATE_WORKSPACE_ROOT: cwd,
    });
    const client = new Client(
      { name: "test-client", version: "0.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "delegate_task",
      arguments: {
        subagentType: "implementer",
        description: "approval probe without sampling",
        prompt: "request approval",
        cwd,
        maxTurns: 1,
        runVerification: true,
      },
    });

    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.status).toBe("blocked");
    expect(structured.summary).toContain("does not advertise sampling/createMessage");

    await client.close();
    await server.close();
  });
});

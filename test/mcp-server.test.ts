import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createDelegateServer } from "../src/mcp-server.js";
import { MockRunner } from "../src/mock-runner.js";

describe("MCP server", () => {
  it("lists and calls delegate_execute over an MCP transport", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "delegate-mcp-"));
    const server = createDelegateServer(new MockRunner(), {
      DEEPSEEK_DELEGATE_WORKSPACE_ROOT: cwd,
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
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
});

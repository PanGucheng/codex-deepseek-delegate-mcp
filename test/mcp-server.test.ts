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

    const result = await client.callTool({
      name: "delegate_execute",
      arguments: {
        task: "implement nothing",
        cwd,
        maxTurns: 1,
        runVerification: false,
      },
    });

    const structured = result.structuredContent as { status?: string };
    const content = result.content as Array<{ type: string }>;

    expect(structured.status).toBe("completed");
    expect(content[0]?.type).toBe("text");

    await client.close();
    await server.close();
  });
});

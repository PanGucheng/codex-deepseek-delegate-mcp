import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { executeDelegateTask } from "../src/service.js";

const execFileAsync = promisify(execFile);
const shouldRun = Boolean(process.env.DEEPSEEK_API_KEY && process.env.RUN_DEEPSEEK_E2E === "1");

describe.skipIf(!shouldRun)("real DeepSeek end-to-end task flow", () => {
  it("scouts, implements, verifies, and resumes a child task", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "delegate-deepseek-e2e-"));
    await fs.writeFile(path.join(cwd, "package.json"), "{\"type\":\"module\"}\n", "utf8");
    await fs.writeFile(
      path.join(cwd, "math.js"),
      "export function add(a, b) {\n  return a - b;\n}\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(cwd, "math.test.js"),
      [
        "import assert from 'node:assert/strict';",
        "import { add } from './math.js';",
        "",
        "assert.equal(add(2, 3), 5);",
        "assert.equal(add(-2, 5), 3);",
        "console.log('math tests passed');",
        "",
      ].join("\n"),
      "utf8",
    );

    const scout = await executeDelegateTask(
      {
        subagentType: "repo-scout",
        description: "Locate the add bug fixture",
        prompt:
          "Inspect the tiny fixture. Identify files relevant to fixing add(a, b) so math.test.js passes. Do not edit files or run commands.",
        cwd,
        maxTurns: 6,
        runVerification: false,
      },
      {
        env: {
          ...process.env,
          DEEPSEEK_DELEGATE_WORKSPACE_ROOT: cwd,
        },
      },
    );

    expect(scout.status).toBe("completed");
    expect(scout.subagentType).toBe("repo-scout");
    expect(scout.changedFiles).toEqual([]);

    const implementer = await executeDelegateTask(
      {
        subagentType: "implementer",
        description: "Fix add implementation",
        prompt: [
          "Fix math.js so node math.test.js passes. Only math.js may be edited.",
          "Use Edit or Write to replace the implementation with: return a + b;",
          "Do not run shell commands in this step.",
        ].join("\n"),
        cwd,
        allowedPaths: ["math.js"],
        contextFiles: ["package.json"],
        maxTurns: 8,
        runVerification: false,
      },
      {
        env: {
          ...process.env,
          DEEPSEEK_DELEGATE_WORKSPACE_ROOT: cwd,
        },
      },
    );

    expect(implementer.status).toBe("completed");
    expect(implementer.subagentType).toBe("implementer");
    expect(implementer.taskId).toMatch(/^task_/);
    expect(implementer.changedFiles).toContain("math.js");
    expect(implementer.changedFiles).not.toContain("math.test.js");

    const math = await fs.readFile(path.join(cwd, "math.js"), "utf8");
    expect(math).toContain("a + b");
    await execFileAsync("node", ["math.test.js"], { cwd });

    const resumed = await executeDelegateTask(
      {
        subagentType: "implementer",
        description: "Verify fixed add task",
        prompt:
          "Continue the same task. Run node math.test.js and report whether it passes. Do not edit files.",
        taskId: implementer.taskId,
        cwd,
        allowedPaths: ["math.js"],
        contextFiles: ["package.json"],
        maxTurns: 8,
        runVerification: true,
      },
      {
        env: {
          ...process.env,
          DEEPSEEK_DELEGATE_WORKSPACE_ROOT: cwd,
        },
      },
    );

    expect(resumed.status).toBe("completed");
    expect(resumed.taskId).toBe(implementer.taskId);
    expect(resumed.changedFiles).toEqual([]);
  }, 240_000);
});

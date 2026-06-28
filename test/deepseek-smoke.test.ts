import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeDelegate } from "../src/service.js";

const shouldRun = Boolean(process.env.DEEPSEEK_API_KEY && process.env.RUN_DEEPSEEK_SMOKE === "1");

describe.skipIf(!shouldRun)("real DeepSeek smoke test", () => {
  it("reaches DeepSeek through Claude Agent SDK and reads a tiny fixture", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "delegate-deepseek-smoke-"));
    await fs.writeFile(
      path.join(cwd, "math.js"),
      "export function add(a, b) { return a + b; }\n",
      "utf8",
    );
    await fs.writeFile(path.join(cwd, "package.json"), "{\"type\":\"module\"}\n", "utf8");

    const result = await executeDelegate(
      {
        task: "Inspect math.js and report whether add returns the sum of its two arguments. Do not edit files.",
        plan: "Read math.js, answer briefly, and do not run commands or modify files.",
        cwd,
        allowedFiles: ["math.js", "package.json"],
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

    expect(result.status).toBe("completed");
    expect(result.changedFiles).toEqual([]);
  }, 120_000);
});

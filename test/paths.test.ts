import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFileSnapshot, diffSnapshots, normalizeInput } from "../src/paths.js";

describe("path normalization", () => {
  it("keeps cwd inside the workspace root", () => {
    const root = path.resolve(os.tmpdir(), "delegate-root");
    const cwd = path.join(root, "project");

    expect(normalizeInput({ task: "x", cwd, maxTurns: 1, runVerification: false }, root).cwd).toBe(cwd);
    expect(() =>
      normalizeInput({ task: "x", cwd: path.dirname(root), maxTurns: 1, runVerification: false }, root),
    ).toThrow(/cwd must stay inside workspace root/);
  });

  it("detects file changes in non-git workspaces", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "delegate-snapshot-"));
    const before = await createFileSnapshot(dir);
    await fs.writeFile(path.join(dir, "created.txt"), "hello", "utf8");
    const after = await createFileSnapshot(dir);

    expect(diffSnapshots(before, after)).toEqual(["created.txt"]);
  });
});

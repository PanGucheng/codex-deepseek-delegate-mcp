import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { DelegateInput, NormalizedDelegateInput } from "./types.js";
import { DelegateError } from "./types.js";

const execFileAsync = promisify(execFile);
const SNAPSHOT_EXCLUDES = new Set([".delegate", ".git", "dist", "node_modules"]);

type Fingerprint = {
  size: number;
  mtimeMs: number;
};

export type FileSnapshot = Map<string, Fingerprint>;

export function normalizeInput(input: DelegateInput, workspaceRoot: string): NormalizedDelegateInput {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedCwd = path.resolve(input.cwd || resolvedRoot);

  if (!isSubpath(resolvedRoot, resolvedCwd)) {
    throw new DelegateError(
      `cwd must stay inside workspace root. workspaceRoot=${resolvedRoot} cwd=${resolvedCwd}`,
      "blocked",
    );
  }

  const allowedFiles = input.allowedFiles?.map((entry) => {
    const resolved = path.resolve(resolvedCwd, entry);
    if (!isSubpath(resolvedCwd, resolved)) {
      throw new DelegateError(
        `allowedFiles entry escapes cwd: ${entry}`,
        "blocked",
      );
    }
    return resolved;
  });

  return {
    ...input,
    cwd: resolvedCwd,
    workspaceRoot: resolvedRoot,
    allowedFiles,
  };
}

export function isSubpath(parent: string, candidate: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedParent, resolvedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isAllowedFilePath(
  candidate: string,
  cwd: string,
  allowedFiles?: string[],
): boolean {
  const resolved = path.resolve(cwd, candidate);
  if (!isSubpath(cwd, resolved)) {
    return false;
  }

  if (!allowedFiles || allowedFiles.length === 0) {
    return true;
  }

  return allowedFiles.some((allowed) => isSubpath(allowed, resolved));
}

export function toRelativeDisplay(cwd: string, filePath: string): string {
  const relative = path.relative(cwd, filePath);
  return relative.split(path.sep).join("/");
}

export async function createFileSnapshot(root: string): Promise<FileSnapshot> {
  const snapshot: FileSnapshot = new Map();
  await collectFiles(root, root, snapshot);
  return snapshot;
}

async function collectFiles(root: string, current: string, snapshot: FileSnapshot): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (SNAPSHOT_EXCLUDES.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(current, entry.name);

    if (entry.isDirectory()) {
      await collectFiles(root, fullPath, snapshot);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const stat = await fs.stat(fullPath);
    snapshot.set(toRelativeDisplay(root, fullPath), {
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
    });
  }
}

export function diffSnapshots(before: FileSnapshot, after: FileSnapshot): string[] {
  const changed = new Set<string>();

  for (const [file, next] of after) {
    const prev = before.get(file);
    if (!prev || prev.size !== next.size || prev.mtimeMs !== next.mtimeMs) {
      changed.add(file);
    }
  }

  for (const file of before.keys()) {
    if (!after.has(file)) {
      changed.add(file);
    }
  }

  return [...changed].sort();
}

export async function getGitChangedFiles(cwd: string): Promise<string[] | undefined> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z"], {
      cwd,
      maxBuffer: 1024 * 1024 * 10,
    });

    if (!stdout) {
      return [];
    }

    return stdout
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const file = entry.slice(3);
        const renameSeparator = " -> ";
        return file.includes(renameSeparator)
          ? file.slice(file.indexOf(renameSeparator) + renameSeparator.length)
          : file;
      })
      .sort();
  } catch {
    return undefined;
  }
}

export function extractToolPaths(toolName: string, input: Record<string, unknown>): string[] {
  const namesByTool: Record<string, string[]> = {
    Read: ["file_path", "path"],
    Edit: ["file_path", "path"],
    MultiEdit: ["file_path", "path"],
    Write: ["file_path", "path"],
    LS: ["path"],
    Grep: ["path"],
    Glob: ["path"],
  };

  return (namesByTool[toolName] || [])
    .map((key) => input[key])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

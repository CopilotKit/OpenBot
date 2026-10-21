import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");

// Desktop installs a release from GitHub's tag tarball, keeping only the top-level entries and the
// single files that deployment.rs names, then runs `bun install --frozen-lockfile --ignore-scripts`.
function copiedLists(): { entries: string[]; files: string[] } {
  const source = readFileSync(
    join(repositoryRoot, "desktop", "src-tauri", "src", "deployment.rs"),
    "utf8",
  )
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  const literals = (constant: string): string[] => {
    const block = source.match(
      new RegExp(`pub const ${constant}: \\[&str; \\d+\\] = \\[([^\\]]*)\\]`),
    );
    expect(block).not.toBeNull();
    return [...(block?.[1] ?? "").matchAll(/"([^"]*)"/g)].map(
      (match) => match[1] ?? "",
    );
  };
  return {
    entries: [...literals("REQUIRED"), ...literals("ALSO_COPIED")],
    files: literals("ALSO_COPIED_FILES"),
  };
}

// A workspace reaches a deployment whole, or as its manifest alone, which is all the install needs.
function copiedWorkspace(workspace: string): boolean {
  const { entries, files } = copiedLists();
  return (
    entries.includes(workspace.split("/")[0] ?? "") ||
    files.includes(`${workspace}/package.json`)
  );
}

function lockfileWorkspaceKeys(): string[] {
  const lock = readFileSync(join(repositoryRoot, "bun.lock"), "utf8");
  const start = lock.indexOf('"workspaces": {');
  expect(start).toBeGreaterThan(-1);
  const end = lock.indexOf("\n  },", start);
  expect(end).toBeGreaterThan(start);
  return [...lock.slice(start, end).matchAll(/^ {4}"([^"]*)": \{/gm)].map(
    (match) => match[1] ?? "",
  );
}

function tracked(path: string): boolean {
  return (
    execFileSync("git", ["ls-files", "--cached", "-z", "--", path], {
      cwd: repositoryRoot,
    }).length > 0
  );
}

describe("OpenBot Desktop's copied tree", () => {
  test("every root workspace is in Desktop's copied tree", () => {
    const manifest = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    ) as { workspaces: string[] };
    for (const workspace of manifest.workspaces) {
      expect({ workspace, copied: copiedWorkspace(workspace) }).toEqual({
        workspace,
        copied: true,
      });
    }
  });

  test("every workspace the lockfile names is in Desktop's copied tree", () => {
    const keys = lockfileWorkspaceKeys().filter((key) => key !== "");
    expect(keys.length).toBeGreaterThan(0);

    for (const key of keys) {
      expect({ key, copied: copiedWorkspace(key) }).toEqual({
        key,
        copied: true,
      });
      expect(tracked(join(key, "package.json"))).toBe(true);
    }
  });

  test("every dependency patch package.json names is in Desktop's copied tree", () => {
    const manifest = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    ) as { patchedDependencies?: Record<string, string> };
    const { entries, files } = copiedLists();
    for (const patch of Object.values(manifest.patchedDependencies ?? {})) {
      const copied =
        entries.includes(patch.split("/")[0] ?? "") || files.includes(patch);
      expect({ patch, copied, tracked: tracked(patch) }).toEqual({
        patch,
        copied: true,
        tracked: true,
      });
    }
  });
});

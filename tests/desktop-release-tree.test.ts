import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");

// Desktop installs a release from GitHub's tag tarball, keeping only the top-level entries that
// deployment.rs names, then runs `bun install --frozen-lockfile --ignore-scripts`.
function copiedEntries(): string[] {
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
  return [...literals("REQUIRED"), ...literals("ALSO_COPIED")];
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
    const copied = copiedEntries();

    for (const workspace of manifest.workspaces) {
      expect(copied).toContain(workspace);
    }
  });

  test("every workspace the lockfile names is in Desktop's copied tree", () => {
    const copied = copiedEntries();
    const keys = lockfileWorkspaceKeys().filter((key) => key !== "");
    expect(keys.length).toBeGreaterThan(0);

    for (const key of keys) {
      expect(copied).toContain(key.split("/")[0] ?? "");
      expect(tracked(join(key, "package.json"))).toBe(true);
    }
  });
});

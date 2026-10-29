import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

// Chrome's id for an extension with a manifest `key`: the SHA-256 of the key's DER bytes, its first
// 32 hex digits written with the letters a to p. https://developer.chrome.com/docs/extensions/reference/manifest/key
function extensionIdOf(key: string): string {
  return [
    ...createHash("sha256")
      .update(Buffer.from(key, "base64"))
      .digest("hex")
      .slice(0, 32),
  ]
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    .join("");
}

// Lay out what GitHub's tag tarball carries (the tracked files) and deployment.rs keeps of it.
function layOutDeployment(root: string): void {
  const { entries, files } = copiedLists();
  const kept = execFileSync(
    "git",
    ["ls-files", "-z", "--", ...entries, ...files],
    {
      cwd: repositoryRoot,
    },
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  for (const file of kept) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(repositoryRoot, file), join(root, file));
  }
}

function bun(args: string[], cwd: string, env = process.env): void {
  const run = Bun.spawnSync([process.execPath, ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect({
    command: args.join(" "),
    exitCode: run.exitCode,
    said: run.exitCode === 0 ? "" : `${run.stdout}${run.stderr}`,
  }).toEqual({ command: args.join(" "), exitCode: 0, said: "" });
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

  // The person's browser on OpenBot Desktop loads the Recorder from `extension/dist` in the
  // deployment, which installation builds there (preparation::build_recorder). Lay a deployment out
  // as Desktop does, install it as Desktop does, and build the Recorder as installation does.
  test("the Recorder builds inside Desktop's copied tree, with its own extension id", () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-desktop-tree-"));
    try {
      layOutDeployment(root);
      bun(["install", "--frozen-lockfile", "--ignore-scripts"], root);
      const env = { ...process.env };
      delete env.RECORDER_BUILD_VARIANT;
      bun(["run", "build"], join(root, "extension"), env);

      const dist = join(root, "extension", "dist");
      const manifest = JSON.parse(
        readFileSync(join(dist, "manifest.json"), "utf8"),
      ) as { key: string; background: { service_worker: string } };
      const recorder = JSON.parse(
        readFileSync(
          join(repositoryRoot, "shared", "recorder-extension.json"),
          "utf8",
        ),
      ) as { extensionId: string };
      expect(extensionIdOf(manifest.key)).toBe(recorder.extensionId);
      expect(existsSync(join(dist, manifest.background.service_worker))).toBe(
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});

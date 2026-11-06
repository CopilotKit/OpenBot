import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { allowedDiff, candidateAt } from "./release-candidate-check";

test("picks the highest rc number on the commit", () => {
  expect(candidateAt(["v0.3.0-rc.1", "v0.3.0-rc.2"], "0.3.0")).toBe(
    "v0.3.0-rc.2",
  );
});

test("returns null when the commit has no tags", () => {
  expect(candidateAt([], "0.3.0")).toBeNull();
});

test("ignores tags for other versions", () => {
  expect(candidateAt(["v0.2.1"], "0.3.0")).toBeNull();
});

test("compares candidate numbers numerically", () => {
  expect(candidateAt(["v0.3.0-rc.10", "v0.3.0-rc.9"], "0.3.0")).toBe(
    "v0.3.0-rc.10",
  );
});

test("prefers rc over beta", () => {
  expect(candidateAt(["v0.3.0-beta.3", "v0.3.0-rc.1"], "0.3.0")).toBe(
    "v0.3.0-rc.1",
  );
});

test("ignores the stable tag itself", () => {
  expect(candidateAt(["v0.3.0"], "0.3.0")).toBeNull();
});

const lock = (desktop: string, other: string) =>
  `[[package]]\nname = "openbot-desktop"\nversion = "${desktop}"\n\n[[package]]\nname = "serde"\nversion = "${other}"\n`;

test("allows a package.json change that only moves the version", () => {
  const files = new Map([
    [
      "package.json",
      {
        before: JSON.stringify({ name: "x", version: "0.3.0-rc.1" }),
        after: JSON.stringify({ name: "x", version: "0.3.0" }),
      },
    ],
  ]);
  expect(allowedDiff(files)).toEqual([]);
});

test("rejects a package.json change beyond the version", () => {
  const files = new Map([
    [
      "package.json",
      {
        before: JSON.stringify({ version: "0.3.0-rc.1", dependencies: {} }),
        after: JSON.stringify({
          version: "0.3.0",
          dependencies: { left: "1.0.0" },
        }),
      },
    ],
  ]);
  const violations = allowedDiff(files);
  expect(violations).toHaveLength(1);
  expect(violations[0]).toContain("package.json");
});

test("allows a Chart.yaml change that only moves appVersion", () => {
  const files = new Map([
    [
      "charts/openbot/Chart.yaml",
      {
        before: 'name: openbot\nappVersion: "0.3.0-rc.1"\n',
        after: 'name: openbot\nappVersion: "0.3.0"\n',
      },
    ],
  ]);
  expect(allowedDiff(files)).toEqual([]);
});

test("allows a Cargo.lock change that only moves the desktop version", () => {
  const files = new Map([
    [
      "desktop/src-tauri/Cargo.lock",
      { before: lock("0.3.0-rc.1", "1.0.0"), after: lock("0.3.0", "1.0.0") },
    ],
  ]);
  expect(allowedDiff(files)).toEqual([]);
});

test("rejects a Cargo.lock change to another package's version", () => {
  const files = new Map([
    [
      "desktop/src-tauri/Cargo.lock",
      { before: lock("0.3.0-rc.1", "1.0.0"), after: lock("0.3.0", "1.0.1") },
    ],
  ]);
  const violations = allowedDiff(files);
  expect(violations).toHaveLength(1);
  expect(violations[0]).toContain("Cargo.lock");
});

test("rejects source files and the intelligence cli pin", () => {
  const change = { before: "a", after: "b" };
  const files = new Map([
    ["server/src/index.ts", change],
    ["desktop/intelligence-cli.json", change],
  ]);
  expect(allowedDiff(files)).toEqual([
    "server/src/index.ts: may not change between a candidate and its final release",
    "desktop/intelligence-cli.json: may not change between a candidate and its final release",
  ]);
});

test("allows any CHANGELOG.md change", () => {
  const files = new Map([
    ["CHANGELOG.md", { before: "# old", after: "# new\n\nmore" }],
  ]);
  expect(allowedDiff(files)).toEqual([]);
});

const repos: string[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true });
});

function git(repo: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", repo, ...args]);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function commit(repo: string, files: Record<string, string>, message: string) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, "add", "-A");
  git(
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    message,
  );
}

function repoWithCandidate(tag: string | null): string {
  const repo = mkdtempSync(join(tmpdir(), "openbot-rc-check-"));
  repos.push(repo);
  git(repo, "init");
  commit(
    repo,
    {
      "package.json": '{"name":"x","version":"0.3.0-rc.1"}',
      "CHANGELOG.md": "a",
    },
    "A",
  );
  if (tag) git(repo, "-c", "tag.gpgsign=false", "tag", tag);
  return repo;
}

function runCheck(repo: string) {
  const sha = git(repo, "rev-parse", "HEAD");
  const result = Bun.spawnSync(
    ["bun", join(import.meta.dir, "release-candidate-check.ts"), sha, "0.3.0"],
    { cwd: repo },
  );
  return {
    code: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
  };
}

test("accepts a release that only moves the version and the changelog", () => {
  const repo = repoWithCandidate("v0.3.0-rc.1");
  commit(
    repo,
    { "package.json": '{"name":"x","version":"0.3.0"}', "CHANGELOG.md": "b" },
    "B",
  );
  const { code, output } = runCheck(repo);
  expect(code).toBe(0);
  expect(output).toContain("v0.3.0 matches v0.3.0-rc.1");
});

test("rejects a release that changes another file, naming it", () => {
  const repo = repoWithCandidate("v0.3.0-rc.1");
  commit(
    repo,
    {
      "package.json": '{"name":"x","version":"0.3.0"}',
      "CHANGELOG.md": "b",
      "server/x.ts": "export {};",
    },
    "B",
  );
  const { code, output } = runCheck(repo);
  expect(code).toBe(1);
  expect(output).toContain("server/x.ts");
});

test("rejects a release whose parent is not tagged", () => {
  const repo = repoWithCandidate(null);
  commit(repo, { "CHANGELOG.md": "b" }, "B");
  const { code, output } = runCheck(repo);
  expect(code).toBe(1);
  expect(output).toContain("Cut a new candidate first");
});

test("allows a release policy change that only moves the version", () => {
  const files = new Map([
    [
      "release-policy.json",
      {
        before: JSON.stringify({
          version: "v0.3.0-rc.1",
          upgrade: { fromVersions: ["v0.2.0"] },
        }),
        after: JSON.stringify({
          version: "v0.3.0",
          upgrade: { fromVersions: ["v0.2.0"] },
        }),
      },
    ],
  ]);
  expect(allowedDiff(files)).toEqual([]);
});

test("rejects a release policy change beyond the version", () => {
  const files = new Map([
    [
      "release-policy.json",
      {
        before: JSON.stringify({
          version: "v0.3.0-rc.1",
          upgrade: { fromVersions: ["v0.2.0"] },
        }),
        after: JSON.stringify({
          version: "v0.3.0",
          upgrade: { fromVersions: ["v0.1.0"] },
        }),
      },
    ],
  ]);
  expect(allowedDiff(files)).toHaveLength(1);
});

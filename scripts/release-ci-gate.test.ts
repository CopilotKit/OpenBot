/**
 * When publishing a release may rely on main's CI instead of running the whole suite again on the
 * release commit, and when it may not. The diff is read from a real repository, as the publish
 * workflow reads it; main's CI runs are the Actions API's shape, standing in for the API.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CI_WORKFLOW,
  type CiRun,
  ciOnParent,
  decide,
  type GateDeps,
  releaseFileViolations,
} from "./release-ci-gate";
import { allowedDiff, changedFiles } from "./release-candidate-check";

const REPOSITORY = "CopilotKit/OpenBot";
const repos: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0))
    rmSync(repo, { recursive: true, force: true });
});

function run(repo: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", repo, ...args]);
  if (result.exitCode !== 0) {
    throw new Error(`${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function write(repo: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
}

function commit(repo: string, message: string): string {
  run(repo, "add", "-A");
  run(
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-q",
    "-m",
    message,
  );
  return run(repo, "rev-parse", "HEAD");
}

const pkg = (version: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ name: "openbot", version, ...extra }, null, 2)}\n`;
const lock = (desktop: string, serde = "1.0.0") =>
  `[[package]]\nname = "openbot-desktop"\nversion = "${desktop}"\n\n[[package]]\nname = "serde"\nversion = "${serde}"\n`;
const cargo = (version: string) =>
  `[package]\nname = "openbot-desktop"\nversion = "${version}"\nedition = "2021"\n`;
const chart = (version: string, chartVersion = "0.1.0") =>
  `apiVersion: v2\nname: openbot\nversion: ${chartVersion}\nappVersion: "${version}"\n`;
const policy = (version: string, from: string[]) =>
  `${JSON.stringify({ version, upgrade: { fromVersions: from } }, null, 2)}\n`;

/** main at 0.3.1, as a release PR is cut from it. */
function mainAt(): { repo: string; parent: string } {
  const repo = mkdtempSync(join(tmpdir(), "openbot-ci-gate-"));
  repos.push(repo);
  run(repo, "init", "-q", "-b", "main");
  write(repo, {
    "package.json": pkg("0.3.1"),
    "desktop/src-tauri/Cargo.toml": cargo("0.3.1"),
    "desktop/src-tauri/Cargo.lock": lock("0.3.1"),
    "charts/openbot/Chart.yaml": chart("0.3.1"),
    "CHANGELOG.md": "# Changelog\n\n## Unreleased\n\n- A fix.\n\n## 0.3.1\n",
    "release-policy.json": policy("v0.3.1", ["v0.3.0"]),
    "server/src/index.ts": "export const answer = 42;\n",
  });
  return { repo, parent: commit(repo, "main") };
}

/** What Create release PR writes for 0.3.2, plus whatever else the PR carries. */
function release(repo: string, extra: Record<string, string> = {}): string {
  write(repo, {
    "package.json": pkg("0.3.2"),
    "desktop/src-tauri/Cargo.toml": cargo("0.3.2"),
    "desktop/src-tauri/Cargo.lock": lock("0.3.2"),
    "charts/openbot/Chart.yaml": chart("0.3.2"),
    "CHANGELOG.md":
      "# Changelog\n\n## Unreleased\n\n## 0.3.2\n\n- A fix.\n\n## 0.3.1\n",
    "release-policy.json": policy("v0.3.2", ["v0.3.1", "v0.3.0"]),
    ...extra,
  });
  return commit(repo, "Release v0.3.2");
}

/** The changes, read from the repository as the script reads them. */
function changesIn(repo: string) {
  return (before: string, after: string) => changedFiles(before, after, repo);
}

function ciRun(overrides: Partial<CiRun> & { head_sha: string }): CiRun {
  return {
    id: 1,
    html_url: "https://github.com/CopilotKit/OpenBot/actions/runs/1",
    path: CI_WORKFLOW,
    event: "push",
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    head_repository: { full_name: REPOSITORY },
    ...overrides,
  };
}

/** The decision for the release commit at HEAD, with main's CI answering `answers` in turn. */
function gate(repo: string, answers: CiRun[][], waitSeconds = 600) {
  let clock = 0;
  let asked = 0;
  const slept: number[] = [];
  const deps: GateDeps = {
    parent: (sha) => run(repo, "rev-parse", `${sha}^1`),
    changes: changesIn(repo),
    runs: () => answers[Math.min(asked++, answers.length - 1)] ?? [],
    sleep: (seconds) => {
      slept.push(seconds);
      clock += seconds * 1000;
    },
    now: () => clock,
    log: () => {},
  };
  const sha = run(repo, "rev-parse", "HEAD");
  return {
    decision: decide(sha, REPOSITORY, deps, { waitSeconds, pollSeconds: 30 }),
    asked: () => asked,
    slept,
  };
}

test("a release PR as Create release PR writes it, onto a commit main's CI passed, skips the full checks", () => {
  const { repo, parent } = mainAt();
  release(repo);
  const { decision } = gate(repo, [[ciRun({ head_sha: parent })]]);
  expect(decision.fullChecks).toBe(false);
  expect(decision.parent).toBe(parent);
  expect(decision.reason).toContain("changes only release files");
});

// The point of the guard: a code change riding in the release PR is never published on the
// strength of a run that did not test it.
test("a code change sneaking into the release PR runs the full checks", () => {
  const { repo, parent } = mainAt();
  release(repo, { "server/src/index.ts": "export const answer = 43;\n" });
  const { decision, asked } = gate(repo, [[ciRun({ head_sha: parent })]]);
  expect(decision.fullChecks).toBe(true);
  expect(decision.reason).toContain(
    "server/src/index.ts is not a release file",
  );
  expect(asked()).toBe(0);
});

test("a test, a workflow or a new file in the release PR runs the full checks", () => {
  for (const extra of [
    { "tests/release-policy.test.ts": "test.todo('x');\n" },
    { ".github/workflows/ci.yml": "name: CI\n" },
    { "server/src/new.ts": "export {};\n" },
    { "desktop/intelligence-cli.json": '{"cli":"latest"}\n' },
  ]) {
    const { repo, parent } = mainAt();
    release(repo, extra);
    const { decision } = gate(repo, [[ciRun({ head_sha: parent })]]);
    expect(decision.fullChecks).toBe(true);
    expect(decision.reason).toContain(
      `${Object.keys(extra)[0]} is not a release file`,
    );
  }
});

test("a deleted source file runs the full checks", () => {
  const { repo, parent } = mainAt();
  rmSync(join(repo, "server/src/index.ts"));
  release(repo);
  const { decision } = gate(repo, [[ciRun({ head_sha: parent })]]);
  expect(decision.fullChecks).toBe(true);
  expect(decision.reason).toContain("server/src/index.ts");
});

/** main without `name`, so a file moved there is a rename git can detect. */
function mainWithout(name: string): { repo: string; parent: string } {
  const { repo } = mainAt();
  rmSync(join(repo, name));
  return { repo, parent: commit(repo, `main without ${name}`) };
}

// With git's rename detection, `server/src/index.ts` moved to a new `release-policy.json` is listed
// as release-policy.json alone, and the removed source file would never be looked at.
test("a source file renamed onto a release file's name runs the full checks", () => {
  const { repo, parent } = mainWithout("release-policy.json");
  run(repo, "mv", "server/src/index.ts", "release-policy.json");
  write(repo, {
    "package.json": pkg("0.3.2"),
    "desktop/src-tauri/Cargo.toml": cargo("0.3.2"),
    "desktop/src-tauri/Cargo.lock": lock("0.3.2"),
    "charts/openbot/Chart.yaml": chart("0.3.2"),
  });
  commit(repo, "Release v0.3.2");
  const { decision } = gate(repo, [[ciRun({ head_sha: parent })]]);
  expect(decision.fullChecks).toBe(true);
  expect(decision.reason).toContain(
    "server/src/index.ts is not a release file",
  );
});

// The same hole in the final-against-candidate check, which reads the diff the same way.
test("a final that renames a source file onto CHANGELOG.md is refused", () => {
  const { repo, parent } = mainWithout("CHANGELOG.md");
  run(repo, "mv", "server/src/index.ts", "CHANGELOG.md");
  const sha = commit(repo, "final");
  const violations = allowedDiff(changesIn(repo)(parent, sha));
  expect(violations).toContain(
    "server/src/index.ts: may not change between a candidate and its final release",
  );
});

test("a version file that changes more than its version runs the full checks", () => {
  for (const [path, text] of [
    ["package.json", pkg("0.3.2", { dependencies: { left: "1.0.0" } })],
    ["desktop/src-tauri/Cargo.lock", lock("0.3.2", "1.0.1")],
    ["charts/openbot/Chart.yaml", chart("0.3.2", "0.2.0")],
    ["desktop/src-tauri/Cargo.toml", `${cargo("0.3.2")}[features]\nx = []\n`],
    ["package.json", "{ not json"],
  ] as const) {
    const { repo, parent } = mainAt();
    release(repo, { [path]: text });
    const { decision } = gate(repo, [[ciRun({ head_sha: parent })]]);
    expect(decision.fullChecks).toBe(true);
    expect(decision.reason).toContain(`${path} changed beyond its version`);
  }
});

test("the changelog and the release policy may change freely", () => {
  const files = new Map([
    ["CHANGELOG.md", { before: "a", after: "rewritten" }],
    [
      "release-policy.json",
      {
        before: policy("v0.3.1", ["v0.3.0"]),
        after: policy("v0.3.2", ["v0.3.1"]),
      },
    ],
  ]);
  expect(releaseFileViolations(files)).toEqual([]);
});

test("a version file added or removed is not a version change", () => {
  expect(
    releaseFileViolations(
      new Map([["charts/openbot/Chart.yaml", { before: "", after: "x" }]]),
    ),
  ).toEqual(["charts/openbot/Chart.yaml was added"]);
});

test("without a passing run of main's CI on the parent, the full checks run", () => {
  const cases: [string, CiRun[]][] = [
    ["never ran", []],
    ["did not pass (failure)", [{ conclusion: "failure" } as CiRun]],
    ["did not pass (cancelled)", [{ conclusion: "cancelled" } as CiRun]],
  ];
  for (const [why, runs] of cases) {
    const { repo, parent } = mainAt();
    release(repo);
    const answer = runs.map((partial) =>
      ciRun({ ...partial, head_sha: parent }),
    );
    const { decision } = gate(repo, [answer]);
    expect(decision.fullChecks).toBe(true);
    expect(decision.reason).toContain(why);
  }
});

// Only a push to this repository's main at exactly the parent counts. A pull request's run tests a
// merge of the PR, not the commit, and skips the image builds unless it was labelled.
test("a run that is not main's CI at the parent does not count", () => {
  const parent = "p".repeat(40);
  for (const other of [
    { event: "pull_request" },
    { head_branch: "david/branch" },
    { head_sha: "q".repeat(40) },
    { path: ".github/workflows/desktop.yml" },
    { head_repository: { full_name: "someone/OpenBot" } },
  ]) {
    expect(
      ciOnParent([ciRun({ head_sha: parent, ...other })], parent, REPOSITORY)
        .state,
    ).toBe("none");
  }
  expect(
    ciOnParent([ciRun({ head_sha: parent })], parent, REPOSITORY).state,
  ).toBe("passed");
});

test("a run in progress on the parent is waited for, and its result decides", () => {
  const { repo, parent } = mainAt();
  release(repo);
  const running = ciRun({
    head_sha: parent,
    status: "in_progress",
    conclusion: null,
  });
  const passed = gate(repo, [
    [running],
    [running],
    [ciRun({ head_sha: parent })],
  ]);
  expect(passed.decision.fullChecks).toBe(false);
  expect(passed.slept).toEqual([30, 30]);

  const failed = gate(repo, [
    [running],
    [ciRun({ head_sha: parent, conclusion: "failure" })],
  ]);
  expect(failed.decision.fullChecks).toBe(true);
});

test("a run still in progress when the wait runs out means the full checks", () => {
  const { repo, parent } = mainAt();
  release(repo);
  const running = ciRun({
    head_sha: parent,
    status: "queued",
    conclusion: null,
  });
  const { decision, slept } = gate(repo, [[running]], 90);
  expect(decision.fullChecks).toBe(true);
  expect(decision.reason).toContain("still running after 90 seconds");
  expect(slept).toEqual([30, 30, 30]);
});

test("main's CI that cannot be read means the full checks, not a pass", () => {
  const { repo } = mainAt();
  release(repo);
  const sha = run(repo, "rev-parse", "HEAD");
  const decision = decide(sha, REPOSITORY, {
    parent: (commit) => run(repo, "rev-parse", `${commit}^1`),
    changes: changesIn(repo),
    runs: () => {
      throw new Error("gh: Server Error (HTTP 502)");
    },
    sleep: () => {},
    now: () => 0,
    log: () => {},
  });
  expect(decision.fullChecks).toBe(true);
  expect(decision.reason).toContain("could not be read: gh: Server Error");
});

test("the decision is made against the first parent, main as the release PR merged onto it", () => {
  const { repo } = mainAt();
  write(repo, { "server/src/index.ts": "export const answer = 7;\n" });
  const later = commit(repo, "another PR merged before the release PR");
  release(repo);
  const { decision } = gate(repo, [[ciRun({ head_sha: later })]]);
  expect(decision.parent).toBe(later);
  expect(decision.fullChecks).toBe(false);
});

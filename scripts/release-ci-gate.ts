/**
 * Whether publishing a release runs the whole CI suite on the release commit again.
 *
 * A release PR, as Create release PR writes it, moves the version and promotes the notes: the
 * `version` in package.json, the desktop crate's version line in Cargo.toml and Cargo.lock, the
 * chart's `appVersion`, CHANGELOG.md, and the release policy a person writes for the release. When
 * that is all the release commit changes from the commit it sits on, and main's CI passed on that
 * commit, its tree has already been through every check: running them again costs a quarter of an
 * hour and proves nothing new. So publish-release.yml relies on that run instead, and re-runs only
 * the checks that read the files the release did change (the `checks needed` job).
 *
 * Anything else in the diff, an added, removed or renamed file included, or a version file that
 * changed more than its version, means the full suite, as does a commit whose parent main's CI did
 * not pass: none, failed, cancelled, or still running after the wait. The decision is made against
 * the release commit's first parent, which is main as it was when the release PR merged, whichever
 * commit the PR was cut from.
 *
 * Usage, from the repository root of a checkout that has the commit and its parent:
 *
 *   bun scripts/release-ci-gate.ts <release commit>
 *
 * Env: GITHUB_REPOSITORY and GH_TOKEN, for `gh`; CI_WAIT_SECONDS (default 2400), how long to wait
 * for a run still in progress on the parent; CI_POLL_SECONDS (default 30). Writes `full_checks`
 * (`true` or `false`) and `parent` to $GITHUB_OUTPUT, and why to $GITHUB_STEP_SUMMARY, when set.
 */
import { appendFileSync } from "node:fs";
import { changedFiles, VERSION_ONLY_RULES } from "./release-candidate-check";

/** The workflow whose run on the parent stands in for the release commit's own checks. */
export const CI_WORKFLOW = ".github/workflows/ci.yml";

/** What a release PR may change freely: the notes, and the policy a person writes for it. */
export const FREE_RELEASE_FILES = ["CHANGELOG.md", "release-policy.json"];

/** What a release PR may change only by its version. */
export const VERSION_ONLY_RELEASE_FILES = [
  "package.json",
  "charts/openbot/Chart.yaml",
  "desktop/src-tauri/Cargo.toml",
  "desktop/src-tauri/Cargo.lock",
];

/**
 * The paths that make a diff more than a release: every path outside the release files, and every
 * version file that changed beyond its version. Empty means the diff is the release files alone.
 */
export function releaseFileViolations(
  files: Map<string, { before: string; after: string }>,
): string[] {
  const violations: string[] = [];
  for (const [path, { before, after }] of files) {
    if (FREE_RELEASE_FILES.includes(path)) continue;
    const normalize = VERSION_ONLY_RELEASE_FILES.includes(path)
      ? VERSION_ONLY_RULES[path]
      : undefined;
    if (!normalize) {
      violations.push(`${path} is not a release file`);
    } else if (!before || !after) {
      violations.push(`${path} was ${before ? "removed" : "added"}`);
    } else if (!sameBesidesVersion(normalize, before, after)) {
      violations.push(`${path} changed beyond its version`);
    }
  }
  return violations;
}

/** Whether two versions of a file differ only in their version. A file that no longer parses does not. */
function sameBesidesVersion(
  normalize: (text: string) => string,
  before: string,
  after: string,
): boolean {
  try {
    return normalize(before) === normalize(after);
  } catch {
    return false;
  }
}

/** The fields of a workflow run this reads, as the Actions API returns them. */
export type CiRun = {
  id: number;
  html_url: string;
  path: string;
  event: string;
  head_branch: string | null;
  head_sha: string;
  status: string;
  conclusion: string | null;
  head_repository?: { full_name?: string } | null;
};

export type CiState =
  | { state: "passed"; run: CiRun }
  | { state: "running"; run: CiRun }
  | { state: "none"; reason: string };

/**
 * What main's CI says about `parent`. Only a run of ci.yml for a push to this repository's main, at
 * exactly that commit, counts: a pull request's run tests a merge of the PR rather than the commit
 * itself, and skips the image builds unless it was labelled.
 */
export function ciOnParent(
  runs: CiRun[],
  parent: string,
  repository: string,
): CiState {
  const own = runs.filter(
    (run) =>
      run.path === CI_WORKFLOW &&
      run.event === "push" &&
      run.head_branch === "main" &&
      run.head_sha === parent &&
      run.head_repository?.full_name?.toLowerCase() ===
        repository.toLowerCase(),
  );
  const passed = own.find(
    (run) => run.status === "completed" && run.conclusion === "success",
  );
  if (passed) return { state: "passed", run: passed };
  const running = own.find((run) => run.status !== "completed");
  if (running) return { state: "running", run: running };
  if (own.length === 0) {
    return { state: "none", reason: `main's CI never ran on ${parent}` };
  }
  const outcomes = [...new Set(own.map((run) => run.conclusion ?? "unknown"))];
  return {
    state: "none",
    reason: `main's CI on ${parent} did not pass (${outcomes.join(", ")})`,
  };
}

export type Decision = {
  fullChecks: boolean;
  parent: string;
  reason: string;
  run?: CiRun;
};

export type GateDeps = {
  /** The release commit's first parent. */
  parent: (sha: string) => string;
  /** Every path the release commit changes from its parent, with both sides. */
  changes: (
    parent: string,
    sha: string,
  ) => Map<string, { before: string; after: string }>;
  /** Every run of ci.yml at a commit. */
  runs: (sha: string) => CiRun[];
  sleep: (seconds: number) => void;
  now: () => number;
  log: (line: string) => void;
};

/** Decides, waiting while main's CI on the parent is still running. */
export function decide(
  sha: string,
  repository: string,
  deps: GateDeps,
  { waitSeconds = 2400, pollSeconds = 30 } = {},
): Decision {
  const parent = deps.parent(sha);
  const violations = releaseFileViolations(deps.changes(parent, sha));
  if (violations.length > 0) {
    return {
      fullChecks: true,
      parent,
      reason: `The release commit changes more than the release files: ${violations.join("; ")}.`,
    };
  }
  const deadline = deps.now() + waitSeconds * 1000;
  for (;;) {
    // An answer the API could not give is not a pass: the full suite runs, which is never wrong.
    let runs: CiRun[];
    try {
      runs = deps.runs(parent);
    } catch (error) {
      return {
        fullChecks: true,
        parent,
        reason: `The release commit changes only release files, but main's CI on ${parent} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const ci = ciOnParent(runs, parent, repository);
    if (ci.state === "passed") {
      return {
        fullChecks: false,
        parent,
        run: ci.run,
        reason: `The release commit changes only release files, and main's CI passed on ${parent}: ${ci.run.html_url}`,
      };
    }
    if (ci.state === "none") {
      return {
        fullChecks: true,
        parent,
        reason: `The release commit changes only release files, but ${ci.reason}.`,
      };
    }
    if (deps.now() >= deadline) {
      return {
        fullChecks: true,
        parent,
        reason: `The release commit changes only release files, but main's CI on ${parent} was still running after ${waitSeconds} seconds: ${ci.run.html_url}`,
      };
    }
    deps.log(
      `main's CI on ${parent} is ${ci.run.status}; waiting for it: ${ci.run.html_url}`,
    );
    deps.sleep(pollSeconds);
  }
}

function run(cmd: string[]): string {
  const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")}: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

if (import.meta.main) {
  try {
    const sha = process.argv[2];
    const repository = process.env.GITHUB_REPOSITORY ?? "";
    if (!sha || !repository) {
      throw new Error(
        "Usage: GITHUB_REPOSITORY=<owner/repo> bun scripts/release-ci-gate.ts <release commit>",
      );
    }
    const decision = decide(
      sha,
      repository,
      {
        parent: (commit) =>
          run(["git", "rev-parse", "--verify", `${commit}^1`]).trim(),
        changes: changedFiles,
        runs: (commit) =>
          JSON.parse(
            run([
              "gh",
              "api",
              `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${commit}&event=push&per_page=100`,
            ]),
          ).workflow_runs as CiRun[],
        sleep: (seconds) => Bun.sleepSync(seconds * 1000),
        now: () => Date.now(),
        log: (line) => console.log(line),
      },
      {
        waitSeconds: Number(process.env.CI_WAIT_SECONDS ?? 2400),
        pollSeconds: Number(process.env.CI_POLL_SECONDS ?? 30),
      },
    );
    console.log(decision.reason);
    console.log(
      decision.fullChecks
        ? "The full checks run on the release commit."
        : "The full checks are not run again; the checks that read the release files are.",
    );
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `full_checks=${decision.fullChecks}\nparent=${decision.parent}\n`,
      );
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Checks for this release\n\n${decision.reason}\n\n${
          decision.fullChecks
            ? "The full CI suite runs on the release commit."
            : "The full CI suite is not run again. The checks that read the release files run in this job."
        }\n`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

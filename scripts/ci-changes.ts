/**
 * Which jobs a pull request's push has to run (the `changes` job of ci.yml and of desktop.yml).
 *
 * A job whose inputs are unchanged since a commit where it passed is not run again: the job is
 * skipped, and `verify`, the one required check, reads a skipped job as a pass. For each job this
 * walks back from the pushed commit along its first parents, finds the newest commit where that job
 * passed in this workflow (a run of this pull request, or main's own run of a commit the branch
 * sits on), and asks whether anything the job reads changed since. Anything it cannot answer (no
 * such commit within reach, the API unreadable, a path it will not handle) runs the job: a wrong
 * answer here can only ever cost minutes, never skip a check that was owed.
 *
 * Three shapes of change come out small:
 *
 * - Test files only. The suite's shards are skipped and the changed test files run on their own,
 *   with any test that names one of them, in `tests (changed files)`; `format, lint, types` still
 *   runs, since it formats, lints and type checks the tests. A test file that drives a real browser
 *   runs in one there.
 * - Docs only. Nothing runs but the tests that name a changed document (the release tests that read
 *   CHANGELOG.md, for example).
 * - A release PR: labelled `release`, from this repository's `release/publish/v*` branch, changing
 *   only the release files, each version file only by its version (scripts/release-ci-gate.ts says
 *   which). Only the checks the release gate itself re-runs on such a commit run: `format, lint,
 *   types`, and the tests that read CHANGELOG.md or release-policy.json.
 *
 * Every other event (a push to main, the release's own call of CI, a schedule) runs everything, and
 * so does a pull request labelled `full-ci`.
 *
 * Usage, from the root of a checkout with the history (fetch-depth 0):
 *
 *   bun scripts/ci-changes.ts ci|desktop
 *
 * Env: GITHUB_EVENT_PATH, GITHUB_EVENT_NAME, GITHUB_REPOSITORY, GITHUB_RUN_ID and GH_TOKEN, as
 * Actions sets them. Writes one output per job (`true` to run it) and the changed tests, as JSON
 * arrays, to $GITHUB_OUTPUT, and what it decided and why to $GITHUB_STEP_SUMMARY.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { changedFiles } from "./release-candidate-check";
import { releaseFileViolations } from "./release-ci-gate";

/** How far back along the first parents a commit where a job passed is looked for. */
export const MAX_ANCESTORS = 50;

/** The number of shards ci.yml's `test` job runs the suite in. */
export const SHARDS = 5;

const matcher = (...patterns: string[]) => {
  const globs = patterns.map((pattern) => new Bun.Glob(pattern));
  return (path: string) => globs.some((glob) => glob.match(path));
};

/** Writing for people: no job compiles, bundles or runs it. A test that names one still runs. */
export const isDocs = matcher(
  "**/*.md",
  "docs/**",
  ".claude/**",
  "LICENSE",
  "LICENSE.*",
);

/** The TypeScript LangGraph engine's tests are Node's; bunfig.toml keeps the suite out of there. */
const inLanggraphTs = matcher("agent-langgraph-ts/**");

/** Dev-tool inputs do not schedule production checks; fake-native source still can. */
const manualOnly = matcher(
  "app/workbench/**",
  "desktop/workbench/**",
  "**/vite.workbench.config.ts",
  "**/fakeNative/**/*.test.ts",
  "**/fakeNative/**/*.test.tsx",
);

/** A test file the root suite runs (`bun test`). */
export const isBunTest = (path: string) =>
  matcher("**/*.test.ts", "**/*.test.tsx")(path) &&
  !inLanggraphTs(path) &&
  !manualOnly(path);

/** A Python harness's pytest file. */
export const isPythonTest = matcher("agent-*/tests/**/*.py");

/** Any test file: the suite's, the Python harnesses' and the TypeScript engine's. */
export const isTestFile = (path: string) =>
  isBunTest(path) ||
  isPythonTest(path) ||
  matcher(
    "agent-langgraph-ts/**/*.test.ts",
    "agent-langgraph-ts/test/**",
    "agent-langgraph-ts/tests/**",
  )(path);

/** Neither docs nor a test: source, configuration, lockfiles, fixtures, workflows. */
export const isCode = (path: string) =>
  !isDocs(path) && !isTestFile(path) && !manualOnly(path);

/** A change to how CI itself runs, which every job of that workflow reads. */
const ciInputs = matcher(
  ".github/workflows/ci.yml",
  ".github/actions/**",
  "scripts/ci-changes.ts",
  "scripts/ci-run-tests.ts",
);
const desktopInputs = matcher(
  ".github/workflows/desktop.yml",
  ".github/workflows/desktop-build.yml",
  "desktop/scripts/install-linux-build-deps.sh",
  "scripts/ci-changes.ts",
);

/** One job: the outputs it is named by, the checks that must have passed, and what it reads. */
export type Rule = {
  output: string;
  /** Job names, as the Actions API reports them, that must all have passed on one commit. */
  checks: string[];
  reads: (path: string) => boolean;
};

const pythonHarness = matcher(
  "agent-*/**",
  "shared/**",
  "examples/**",
  "*.yml",
  "*.yaml",
  ".env*",
  "backend-images.env",
  "desktop/src-tauri/telemetry.compose.yml",
  "tests/compose.test.ts",
  "package.json",
  "bun.lock",
);

/** The harnesses ci.yml's `python-harness` matrix tests, one job each. */
export const PYTHON_HARNESSES = [
  "agent-crewai",
  "agent-claude-sdk",
  "agent-openai-agents",
  "agent-langgraph-agui",
  "agent-llamaindex",
  "agent-agno",
  "agent-strands",
  "agent-pydantic-ai",
  "agent-adk",
  "agent-antigravity",
  "agent-langroid",
  "agent-ag2",
  "agent-microsoft",
];

export const CI_RULES: Rule[] = [
  {
    output: "static",
    checks: ["format, lint, types"],
    // Formats, lints and type checks the tests too.
    reads: (path) => !isDocs(path) || ciInputs(path),
  },
  {
    output: "api",
    checks: ["API spec"],
    // The accepted breaking changes are Markdown the job reads.
    reads: (path) => isCode(path) || matcher("api/**")(path),
  },
  {
    output: "mobile",
    checks: ["native types"],
    reads: (path) => matcher("mobile/**")(path) || ciInputs(path),
  },
  {
    output: "app_browser",
    checks: [
      "app (real browser)",
      "app (real browser, WebKit)",
      "app (real browser, desktop setup window)",
    ],
    reads: isCode,
  },
  {
    output: "startup",
    checks: ["startup (macos-latest)", "startup (windows-latest)"],
    reads: (path) => isCode(path) || path === "app/tests/build-cache.test.ts",
  },
  {
    output: "langgraph_ts",
    checks: ["typescript langgraph engine"],
    reads: (path) =>
      (!isDocs(path) && matcher("agent-langgraph-ts/**", "shared/**")(path)) ||
      ciInputs(path),
  },
  {
    output: "python_harness",
    checks: [
      ...PYTHON_HARNESSES.map((harness) => `python harness (${harness})`),
      "compose config",
    ],
    // Of the tests, only the harnesses' own: the suite's and the TypeScript engine's run elsewhere.
    reads: (path) =>
      (!isDocs(path) &&
        pythonHarness(path) &&
        (!isTestFile(path) || isPythonTest(path))) ||
      ciInputs(path),
  },
  {
    output: "build",
    checks: ["build"],
    reads: isCode,
  },
];

/** The suite: every shard must have passed on the commit it stands in from. */
export const SUITE_RULE: Rule = {
  output: "suite",
  checks: Array.from(
    { length: SHARDS },
    (_, index) => `tests (shard ${index + 1} of ${SHARDS})`,
  ),
  reads: isCode,
};

export const DESKTOP_RULES: Rule[] = [
  {
    output: "core",
    checks: ["core"],
    reads: (path) =>
      (!isDocs(path) && matcher("desktop/src-tauri/**")(path)) ||
      desktopInputs(path),
  },
  {
    output: "app",
    // The builds, and the Docker regression tests desktop.yml runs beside them on the same gate.
    checks: [
      "app / app (macos)",
      "app / app (windows)",
      "app / app (linux)",
      "live (images)",
      "live (engines)",
    ],
    // desktop.yml's own path filter, less the docs and the tests the suite runs.
    reads: (path) =>
      (!isDocs(path) &&
        !isBunTest(path) &&
        matcher(
          "desktop/**",
          "shared/harnesses.json",
          "shared/marks/**",
          "shared/recorder-extension.json",
          "shared/fixtures/client-version/**",
          "package.json",
        )(path)) ||
      desktopInputs(path),
  },
];

export type Workflow = "ci" | "desktop";

export const WORKFLOW_PATH: Record<Workflow, string> = {
  ci: ".github/workflows/ci.yml",
  desktop: ".github/workflows/desktop.yml",
};

/** A pull request as its event describes it. */
export type PullRequest = {
  labels: string[];
  headRef: string;
  headRepository: string;
  repository: string;
  head: string;
  base: string;
};

export type Change = { path: string; deleted: boolean };

export type Deps = {
  /** The pushed commit and its first parents, newest first, the pushed commit included. */
  ancestors: (head: string) => string[];
  /** The job names that passed on a commit in this workflow's runs, the current run left out. */
  passed: (sha: string) => Set<string>;
  /** What changed between two commits. */
  diff: (from: string, to: string) => Change[];
  /** The suite's test files that name any of these paths. */
  mentions: (paths: string[]) => string[];
  /** A file's text in the checkout, or undefined. */
  read: (path: string) => string | undefined;
  /** Why the PR's diff is more than the release files; empty when it is only them. */
  releaseViolations: (base: string, head: string) => string[];
};

/** The tests that read the release files, as publish-release.yml's `checks needed` finds them. */
export const RELEASE_FILES_READ_BY_TESTS = [
  "CHANGELOG.md",
  "release-policy.json",
];

export type Decision = {
  /** One entry per rule's output, plus `partial`. */
  run: Record<string, boolean>;
  /** Suite test files to run on their own. */
  tests: string[];
  /** App test files to run in a real browser. */
  browserTests: string[];
  /** Of those, the ones that also want WebKit. */
  webkitTests: string[];
  /** The desktop setup window's browser tests, run from desktop/. */
  desktopBrowserTests: string[];
  /** Why, a line per job, for the step summary. */
  reasons: string[];
};

const RELEASE_BRANCH =
  /^release\/publish\/v\d+\.\d+\.\d+(-(rc|beta)\.[1-9]\d*)?$/;

/** Whether the PR is a release PR by its name, label and repository; its diff is checked after. */
export function releaseShaped(pr: PullRequest): boolean {
  return (
    pr.labels.includes("release") &&
    RELEASE_BRANCH.test(pr.headRef) &&
    pr.headRepository.toLowerCase() === pr.repository.toLowerCase()
  );
}

/** A path this will not reason about: anything a shell, a glob or an output line could misread. */
export const unusualPath = (path: string) =>
  [...path].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });

function everything(rules: Rule[], why: string): Decision {
  const run: Record<string, boolean> = { partial: false };
  for (const rule of rules) run[rule.output] = true;
  return {
    run,
    tests: [],
    browserTests: [],
    webkitTests: [],
    desktopBrowserTests: [],
    reasons: [why],
  };
}

/** The rules a workflow decides, the suite included for CI. */
export function rulesOf(workflow: Workflow): Rule[] {
  return workflow === "ci" ? [...CI_RULES, SUITE_RULE] : DESKTOP_RULES;
}

/**
 * Decides every job of a workflow for one pull request push. `pr` undefined is any other event,
 * which runs everything.
 */
export function decide(
  workflow: Workflow,
  pr: PullRequest | undefined,
  deps: Deps,
): Decision {
  const rules = rulesOf(workflow);
  if (!pr) return everything(rules, "Not a pull request: everything runs.");
  if (pr.labels.includes("full-ci")) {
    return everything(rules, "Labelled full-ci: everything runs.");
  }

  if (releaseShaped(pr)) {
    let violations: string[];
    try {
      violations = deps.releaseViolations(pr.base, pr.head);
    } catch (error) {
      violations = [`its diff could not be read: ${String(error)}`];
    }
    if (violations.length === 0) {
      return releaseDecision(workflow, rules, deps);
    }
    // A release PR that changes more than the release files is checked like any other PR.
  }

  const ancestors = deps.ancestors(pr.head);
  const passedAt = new Map<string, Set<string>>();
  const passed = (sha: string) => {
    let names = passedAt.get(sha);
    if (!names) {
      names = deps.passed(sha);
      passedAt.set(sha, names);
    }
    return names;
  };
  /** The newest commit where every one of these checks passed. */
  const baselineOf = (checks: string[]) =>
    ancestors.find((sha) => {
      const names = passed(sha);
      return checks.every((check) => names.has(check));
    });
  const changesSince = new Map<string, Change[]>();
  const since = (sha: string) => {
    let changes = changesSince.get(sha);
    if (!changes) {
      changes = deps.diff(sha, pr.head);
      changesSince.set(sha, changes);
    }
    return changes;
  };

  const run: Record<string, boolean> = { partial: false };
  const reasons: string[] = [];
  const decision: Decision = {
    run,
    tests: [],
    browserTests: [],
    webkitTests: [],
    desktopBrowserTests: [],
    reasons,
  };
  /** What changed since the rule's job last passed, or undefined to run it regardless. */
  const changesFor = (rule: Rule): Change[] | undefined => {
    const baseline = baselineOf(rule.checks);
    if (!baseline) {
      reasons.push(
        `${rule.output}: runs, no commit within ${ancestors.length} where it passed.`,
      );
      return undefined;
    }
    const changes = since(baseline);
    if (changes.some((change) => unusualPath(change.path))) {
      reasons.push(
        `${rule.output}: runs, a changed path has control characters.`,
      );
      return undefined;
    }
    return changes;
  };

  for (const rule of rules) {
    if (rule === SUITE_RULE) continue;
    const changes = changesFor(rule);
    if (!changes) {
      run[rule.output] = true;
      continue;
    }
    const read = changes.filter(
      (change) => !manualOnly(change.path) && rule.reads(change.path),
    );
    run[rule.output] = read.length > 0;
    reasons.push(
      read.length > 0
        ? `${rule.output}: runs, ${describe(read)} changed.`
        : `${rule.output}: skipped, nothing it reads changed since it passed.`,
    );
  }

  if (workflow === "ci") {
    decideSuite(decision, changesFor(SUITE_RULE), changesFor, deps);
  }
  return decision;
}

/** The suite, and the test files that run on their own when it does not. */
function decideSuite(
  decision: Decision,
  suiteChanges: Change[] | undefined,
  changesFor: (rule: Rule) => Change[] | undefined,
  deps: Deps,
) {
  const { run, reasons } = decision;
  const code = suiteChanges?.filter((change) => isCode(change.path));
  run.suite = !suiteChanges || (code?.length ?? 0) > 0;
  if (suiteChanges && code && code.length > 0) {
    reasons.push(`suite: runs, ${describe(code)} changed.`);
  } else if (suiteChanges) {
    reasons.push(
      "suite: skipped, only tests and docs changed since it passed.",
    );
  }

  // The test files to run on their own: the ones changed since the suite last passed, and every test
  // that names a changed file. Those the full suite or the browser job runs anyway are left out.
  const candidates = new Set<string>();
  const add = (changes: Change[] | undefined, browser: boolean) => {
    if (!changes) return;
    const named = changes
      .filter((change) => !manualOnly(change.path))
      .map((change) => change.path);
    const files = [
      ...changes
        .filter((change) => !change.deleted && isBunTest(change.path))
        .map((change) => change.path),
      ...deps.mentions(named),
    ];
    for (const file of files) {
      if (isBunTest(file) && isBrowserTest(file, deps) === browser)
        candidates.add(file);
    }
  };
  if (!run.suite) add(suiteChanges, false);
  if (!run.app_browser) {
    add(
      changesFor(
        CI_RULES.find((rule) => rule.output === "app_browser") as Rule,
      ),
      true,
    );
  }

  for (const file of [...candidates].sort()) {
    if (!isBrowserTest(file, deps)) {
      decision.tests.push(file);
    } else if (file.startsWith("desktop/")) {
      decision.desktopBrowserTests.push(file);
    } else {
      decision.browserTests.push(file);
      if (deps.read(file)?.includes("OPENBOT_APP_ENGINES")) {
        decision.webkitTests.push(file);
      }
    }
  }
  run.partial =
    decision.tests.length +
      decision.browserTests.length +
      decision.desktopBrowserTests.length >
    0;
  if (run.partial) {
    reasons.push(
      `tests (changed files): ${[
        ...decision.tests,
        ...decision.browserTests,
        ...decision.desktopBrowserTests,
      ].join(", ")}.`,
    );
  }
}

/** A test that drives a real browser, which `bun test` alone skips. */
function isBrowserTest(file: string, deps: Deps): boolean {
  return (
    file.endsWith(".browser.test.ts") ||
    (deps.read(file)?.includes("OPENBOT_APP_BROWSER") ?? false)
  );
}

function releaseDecision(
  workflow: Workflow,
  rules: Rule[],
  deps: Deps,
): Decision {
  const run: Record<string, boolean> = { partial: false };
  for (const rule of rules) run[rule.output] = false;
  const decision: Decision = {
    run,
    tests: [],
    browserTests: [],
    webkitTests: [],
    desktopBrowserTests: [],
    reasons: [
      "A release PR changing only the release files: only the checks publishing re-runs on it run.",
    ],
  };
  if (workflow === "ci") {
    run.static = true;
    decision.tests = deps
      .mentions(RELEASE_FILES_READ_BY_TESTS)
      .filter(isBunTest)
      .sort();
    run.partial = decision.tests.length > 0;
    decision.reasons.push(
      `tests (changed files): ${decision.tests.join(", ")}.`,
    );
  }
  return decision;
}

function describe(changes: Change[]): string {
  const shown = changes.slice(0, 5).map((change) => change.path);
  return changes.length > 5
    ? `${shown.join(", ")} and ${changes.length - 5} more`
    : shown.join(", ");
}

// ---------------------------------------------------------------------------------------------
// Running it in Actions.

function exec(cmd: string[], allowFailure = false): string {
  const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0 && !allowFailure) {
    throw new Error(`${cmd.join(" ")}: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

type ApiRun = {
  id: number;
  path: string;
  head_repository?: { full_name?: string } | null;
};
type ApiJob = { name: string; conclusion: string | null };

function liveDeps(
  workflow: Workflow,
  repository: string,
  currentRun: number,
  trustedRepositories: string[],
): Deps {
  const trusted = trustedRepositories.map((name) => name.toLowerCase());
  return {
    ancestors: (head) =>
      exec([
        "git",
        "rev-list",
        "--first-parent",
        `--max-count=${MAX_ANCESTORS}`,
        head,
      ])
        .split("\n")
        .filter(Boolean),
    passed: (sha) => {
      const names = new Set<string>();
      const runs = (
        JSON.parse(
          exec([
            "gh",
            "api",
            `repos/${repository}/actions/runs?head_sha=${sha}&per_page=100`,
          ]),
        ).workflow_runs as ApiRun[]
      ).filter(
        (run) =>
          run.path === WORKFLOW_PATH[workflow] &&
          run.id !== currentRun &&
          trusted.includes(run.head_repository?.full_name?.toLowerCase() ?? ""),
      );
      for (const run of runs) {
        const jobs = JSON.parse(
          exec([
            "gh",
            "api",
            `repos/${repository}/actions/runs/${run.id}/jobs?filter=all&per_page=100`,
          ]),
        ).jobs as ApiJob[];
        for (const job of jobs) {
          if (job.conclusion === "success") names.add(job.name);
        }
      }
      return names;
    },
    diff: (from, to) => {
      const out = exec([
        "git",
        "diff",
        "--no-renames",
        "--name-status",
        "-z",
        from,
        to,
      ]).split("\0");
      const changes: Change[] = [];
      for (let index = 0; index + 1 < out.length; index += 2) {
        const status = out[index];
        const path = out[index + 1];
        if (status && path) changes.push({ path, deleted: status === "D" });
      }
      return changes;
    },
    mentions: (paths) => {
      if (paths.length === 0) return [];
      const patterns = paths.flatMap((path) => ["-e", path]);
      // Exit 1 is "no file names any of them".
      return exec(
        [
          "git",
          "grep",
          "-l",
          "-z",
          "-F",
          ...patterns,
          "--",
          "*.test.ts",
          "*.test.tsx",
        ],
        true,
      )
        .split("\0")
        .filter((file) => file && isBunTest(file));
    },
    read: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    releaseViolations: (base, head) => {
      const mergeBase = exec(["git", "merge-base", base, head]).trim();
      return releaseFileViolations(changedFiles(mergeBase, head));
    },
  };
}

type PullRequestEvent = {
  pull_request?: {
    labels?: { name: string }[];
    head: { ref: string; sha: string; repo?: { full_name?: string } | null };
    base: { sha: string };
  };
};

function writeOutput(name: string, value: string) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delimiter = `EOF_${randomBytes(16).toString("hex")}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

if (import.meta.main) {
  const workflow = process.argv[2] as Workflow;
  if (workflow !== "ci" && workflow !== "desktop") {
    console.error("Usage: bun scripts/ci-changes.ts ci|desktop");
    process.exit(2);
  }
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  let decision: Decision;
  try {
    const event = (
      process.env.GITHUB_EVENT_PATH
        ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
        : {}
    ) as PullRequestEvent;
    const pull = eventName === "pull_request" ? event.pull_request : undefined;
    const pr: PullRequest | undefined = pull && {
      labels: (pull.labels ?? []).map((label) => label.name),
      headRef: pull.head.ref,
      headRepository: pull.head.repo?.full_name ?? "",
      repository,
      head: pull.head.sha,
      base: pull.base.sha,
    };
    decision = decide(
      workflow,
      pr,
      liveDeps(
        workflow,
        repository,
        Number(process.env.GITHUB_RUN_ID ?? 0),
        // This repository's runs, and the pull request's own when it comes from a fork, so one
        // fork's run never stands in for another's.
        [repository, pr?.headRepository ?? repository],
      ),
    );
  } catch (error) {
    // Unable to decide is never a reason to skip: everything runs.
    decision = everything(
      rulesOf(workflow),
      `Could not decide, so everything runs: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const [output, value] of Object.entries(decision.run)) {
    writeOutput(output, String(value));
  }
  writeOutput("tests", JSON.stringify(decision.tests));
  writeOutput("browser_tests", JSON.stringify(decision.browserTests));
  writeOutput("webkit_tests", JSON.stringify(decision.webkitTests));
  writeOutput(
    "desktop_browser_tests",
    JSON.stringify(decision.desktopBrowserTests),
  );
  for (const line of decision.reasons) console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### What this push runs\n\n${decision.reasons.map((line) => `- ${line}`).join("\n")}\n`,
    );
  }
}

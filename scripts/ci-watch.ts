#!/usr/bin/env bun
/**
 * Keeps CI fast and honest after each run of a watched workflow (.github/workflows/ci-watch.yml).
 *
 * FLAKES. A job that failed and then passed on the same commit, with no change to the code, is a
 * flaky job: re-run in the same run (Re-run failed jobs), or failed in an earlier run of the same
 * workflow on the same commit. For each one this reads the failed job's log, names the tests that
 * failed in it, and opens a `flaky-test` issue per test, or adds the run to the one already open
 * (reopening it when it was closed as fixed). A flaky job whose log names no test (a runner, a
 * mirror or a service that did not answer) gets one issue for the job, with the log's errors. The
 * fix is the test's; nothing here retries anything.
 *
 * BUDGETS. Every job of a watched workflow has a budget in .github/ci-budgets.json, well under its
 * `timeout-minutes` (which fails the job), and every workflow has one for the whole run. A job or
 * a run over its budget opens or updates a `ci-budget` issue, and says so in this run's summary.
 * scripts/ci-budgets.test.ts holds every job to having both.
 *
 * Runs from forks are left alone: their logs are not ours to turn into issue titles.
 *
 * Env: GITHUB_REPOSITORY, GITHUB_EVENT_PATH (a workflow_run event) and GH_TOKEN (actions: read,
 * issues: write). `--dry-run` says what it would file and files nothing. `--run <id>` reads that
 * run instead of the event's.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Job = {
  id: number;
  name: string;
  run_attempt: number;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
};

export type Run = {
  id: number;
  name: string;
  workflow_id: number;
  run_attempt: number;
  conclusion: string | null;
  head_sha: string;
  head_branch: string | null;
  event: string;
  html_url: string;
  created_at: string;
  head_repository?: { full_name: string } | null;
};

export type Budgets = Record<
  string,
  { run: number; jobs: Record<string, number> }
>;

const ROOT = join(import.meta.dir, "..");

/** How a GitHub Actions expression opens, written so the linter does not read it as a template. */
export const EXPRESSION = ["$", "{{"].join("");

/** A job's name with its shard numbers taken out, so every shard shares one budget and one issue. */
export function jobKey(name: string): string {
  return name.replace(/shard \d+ of \d+/, "shard N of N");
}

function minutes(from: string | null, to: string | null): number | undefined {
  if (!from || !to) return undefined;
  return (Date.parse(to) - Date.parse(from)) / 60_000;
}

/**
 * The jobs that only add up the others (`verify`, and `tests` over the shards): they fail because a
 * job they wait on failed, and that job is the one to name.
 */
const AGGREGATES = new Set([
  "verify",
  "tests",
  "checks / verify",
  "checks / tests",
]);

/**
 * The jobs that failed in an earlier attempt of this run and passed in its latest: the same commit,
 * the same inputs, a different result. The failed attempt's job is returned, for its log.
 */
export function flakyInRun(jobs: Job[], latestAttempt: number): Job[] {
  const passed = new Set(
    jobs
      .filter(
        (j) => j.run_attempt === latestAttempt && j.conclusion === "success",
      )
      .map((j) => j.name),
  );
  const flaky = new Map<string, Job>();
  for (const job of jobs) {
    if (
      job.run_attempt < latestAttempt &&
      job.conclusion === "failure" &&
      passed.has(job.name) &&
      !AGGREGATES.has(job.name)
    ) {
      flaky.set(job.name, job);
    }
  }
  return [...flaky.values()];
}

/**
 * The jobs that failed in an earlier run of this workflow on the same commit and passed in this
 * one. `earlier` is each earlier run's jobs.
 */
export function flakyAcrossRuns(current: Job[], earlier: Job[][]): Job[] {
  const passed = new Set(
    current.filter((j) => j.conclusion === "success").map((j) => j.name),
  );
  const flaky = new Map<string, Job>();
  for (const jobs of earlier) {
    for (const job of jobs) {
      if (
        job.conclusion === "failure" &&
        passed.has(job.name) &&
        !AGGREGATES.has(job.name)
      )
        flaky.set(job.name, job);
    }
  }
  return [...flaky.values()];
}

/** A terminal colour code, which every runner's log is full of. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const TIMESTAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z\s/;

/**
 * The tests a job's log says failed, by the runners' own words: Bun's `(fail)` lines, pytest's
 * `FAILED` lines, Playwright's `✘` lines and cargo's `... FAILED` lines. In the order they first
 * appear, each once.
 */
export function failingTests(log: string): string[] {
  const found = new Set<string>();
  for (const raw of log.split("\n")) {
    const line = raw.replace(TIMESTAMP, "").replace(ANSI, "").trimEnd();
    const bun = /^\s*\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/.exec(line);
    const pytest = /^FAILED (\S+::\S+)/.exec(line);
    const playwright =
      /^\s*✘\s+\d+\s+(?:\[[\w-]+\] › )?(.+?)(?: \([\d.]+(?:ms|s|m)\))?$/.exec(
        line,
      );
    const cargo = /^test (\S+) \.\.\. FAILED$/.exec(line);
    const name = bun?.[1] ?? pytest?.[1] ?? playwright?.[1] ?? cargo?.[1];
    if (name) found.add(name.trim());
  }
  return [...found];
}

/** The log's own error lines, for a flaky job that names no test. */
export function errorLines(log: string, limit = 8): string[] {
  const lines: string[] = [];
  for (const raw of log.split("\n")) {
    const line = raw.replace(TIMESTAMP, "").replace(ANSI, "").trim();
    const error =
      /^##\[error\](.+)$/.exec(line)?.[1] ?? /^error: (.+)$/.exec(line)?.[1];
    if (error && !error.startsWith("Process completed with exit code")) {
      if (!lines.includes(error)) lines.push(error);
    }
    if (lines.length >= limit) break;
  }
  return lines;
}

export type OverBudget = { job: string; minutes: number; budget: number };

/**
 * The budget a job of a matrix shares with every other leg, when the legs are known only once the
 * run starts: its name up to the bracket, then `(*)`, or `*` for a name that is all matrix.
 */
export function wildcard(name: string): string {
  if (name.startsWith(EXPRESSION)) return "*";
  const bracket = name.indexOf(" (");
  return bracket > 0 ? `${name.slice(0, bracket)} (*)` : "*";
}

/** A job's budget: under its own name (shards as `shard N of N`), else under its wildcard. */
export function budgetFor(
  jobs: Record<string, number>,
  name: string,
): number | undefined {
  return jobs[jobKey(name)] ?? jobs[wildcard(name)] ?? jobs["*"];
}

/** The latest attempt's jobs that ran past their budget, and the run itself when it did. */
export function overBudget(
  workflow: string,
  jobs: Job[],
  latestAttempt: number,
  budgets: Budgets,
): OverBudget[] {
  const budget = budgets[workflow];
  if (!budget) return [];
  const latest = jobs.filter(
    (j) => j.run_attempt === latestAttempt && j.conclusion !== "skipped",
  );
  const over: OverBudget[] = [];
  for (const job of latest) {
    const took = minutes(job.started_at, job.completed_at);
    const allowed = budgetFor(budget.jobs, job.name);
    if (took !== undefined && allowed !== undefined && took > allowed) {
      over.push({ job: jobKey(job.name), minutes: took, budget: allowed });
    }
  }
  // The whole run only on a first attempt: a re-run's attempt carries the jobs that passed before
  // with their old times, so its span counts the wait between the attempts.
  const ran = latest.filter((j) => j.conclusion !== null);
  const starts = ran.map((j) => j.started_at).filter(Boolean) as string[];
  const ends = ran.map((j) => j.completed_at).filter(Boolean) as string[];
  if (latestAttempt === 1 && starts.length && ends.length) {
    const first = starts.reduce((a, b) => (a < b ? a : b));
    const last = ends.reduce((a, b) => (a > b ? a : b));
    const took = minutes(first, last) ?? 0;
    if (took > budget.run)
      over.push({ job: "(whole run)", minutes: took, budget: budget.run });
  }
  // One entry per budget: the slowest shard speaks for the others.
  const slowest = new Map<string, OverBudget>();
  for (const entry of over) {
    const seen = slowest.get(entry.job);
    if (!seen || seen.minutes < entry.minutes) slowest.set(entry.job, entry);
  }
  return [...slowest.values()];
}

/** Text from a log, safe in an issue: no mention pings anybody, and no backtick ends a code span. */
export function quiet(text: string, max = 200): string {
  return text.replaceAll("@", "@​").replaceAll("`", "'").slice(0, max);
}

// ---------------------------------------------------------------------------------------------

function gh(args: string[], input?: string): string {
  const result = Bun.spawnSync(["gh", "api", ...args], {
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `gh api ${args.join(" ")}: ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString();
}

const json = <T>(args: string[]): T => JSON.parse(gh(args)) as T;

/**
 * A job's log, as plain text. Fetched rather than read through `gh api`, which refuses a body with
 * terminal escape sequences in it, and every log has them.
 */
async function jobLog(repository: string, jobId: number): Promise<string> {
  const token =
    process.env.GH_TOKEN ??
    Bun.spawnSync(["gh", "auth", "token"]).stdout.toString().trim();
  const response = await fetch(
    `https://api.github.com/repos/${repository}/actions/jobs/${jobId}/logs`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`The log of job ${jobId}: HTTP ${response.status}`);
  }
  return response.text();
}

function jobsOf(repository: string, runId: number): Job[] {
  const jobs: Job[] = [];
  for (let page = 1; ; page++) {
    const batch = json<{ jobs: Job[] }>([
      `repos/${repository}/actions/runs/${runId}/jobs?filter=all&per_page=100&page=${page}`,
    ]).jobs;
    jobs.push(...batch);
    if (batch.length < 100) return jobs;
  }
}

type Issue = { number: number; title: string; state: string };

function upsertIssue(
  repository: string,
  label: string,
  title: string,
  body: string,
  comment: string,
  dryRun: boolean,
): string {
  const found = json<Issue[]>([
    `repos/${repository}/issues?labels=${label}&state=all&per_page=100&sort=updated`,
  ]).find((issue) => issue.title === title);
  if (dryRun) {
    return found
      ? `would comment on #${found.number} (${found.state}): ${title}`
      : `would open: ${title}`;
  }
  if (!found) {
    const created = json<Issue>([
      `repos/${repository}/issues`,
      "--method",
      "POST",
      "-f",
      `title=${title}`,
      "-f",
      `body=${body}\n\n${comment}`,
      "-f",
      `labels[]=${label}`,
    ]);
    return `opened #${created.number}: ${title}`;
  }
  if (found.state === "closed") {
    gh([
      `repos/${repository}/issues/${found.number}`,
      "--method",
      "PATCH",
      "-f",
      "state=open",
    ]);
  }
  gh([
    `repos/${repository}/issues/${found.number}/comments`,
    "--method",
    "POST",
    "-f",
    `body=${comment}`,
  ]);
  return `${found.state === "closed" ? "reopened" : "commented on"} #${found.number}: ${title}`;
}

const FLAKY_BODY =
  "A test that failed and then passed on the same commit, with no change to the code. Each comment below is one time it happened, with the run and the job. Fix the cause and close this; it reopens if the test fails that way again.";
const FLAKY_JOB_BODY =
  "A job that failed and then passed on the same commit, with no change to the code, and whose log names no failing test: a runner, a download or a service the job waits on. Each comment below is one time it happened, with the errors from its log.";
const BUDGET_BODY =
  "A CI job, or a whole run, took longer than its budget in .github/ci-budgets.json. Each comment below is one run that did. Make it fast again, or raise the budget in a pull request that says why.";

if (import.meta.main) {
  const dryRun = process.argv.includes("--dry-run");
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (!repository) {
    console.error("GITHUB_REPOSITORY is not set.");
    process.exit(2);
  }
  const runArgument = process.argv.indexOf("--run");
  const run: Run =
    runArgument > 0
      ? json<Run>([
          `repos/${repository}/actions/runs/${process.argv[runArgument + 1]}`,
        ])
      : (
          JSON.parse(
            readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"),
          ) as { workflow_run: Run }
        ).workflow_run;
  const summary: string[] = [
    `### ${run.name} run ${run.id}, attempt ${run.run_attempt}`,
  ];
  const say = (line: string) => {
    console.log(line);
    summary.push(`- ${line}`);
  };

  if (run.head_repository && run.head_repository.full_name !== repository) {
    say("A run from a fork: left alone.");
  } else {
    const jobs = jobsOf(repository, run.id);
    const latest = run.run_attempt;
    const budgets = JSON.parse(
      readFileSync(join(ROOT, ".github/ci-budgets.json"), "utf8"),
    ) as Budgets;
    const where = `[run ${run.id}, attempt ${latest}](${run.html_url}/attempts/${latest}) on ${run.event === "pull_request" ? "a pull request" : run.head_branch}, commit ${run.head_sha.slice(0, 10)}`;

    // Flakes count only on a run that ended green: the commit passes, so what failed before was
    // not the code.
    if (run.conclusion === "success") {
      const flaky = flakyInRun(jobs, latest);
      const earlierRuns = json<{ workflow_runs: Run[] }>([
        `repos/${repository}/actions/workflows/${run.workflow_id}/runs?head_sha=${run.head_sha}&status=failure&per_page=20`,
      ]).workflow_runs.filter(
        (r) => r.id !== run.id && r.created_at < run.created_at,
      );
      const current = jobs.filter((j) => j.run_attempt === latest);
      flaky.push(
        ...flakyAcrossRuns(
          current,
          earlierRuns.map((r) => jobsOf(repository, r.id)),
        ).filter((j) => !flaky.some((f) => f.name === j.name)),
      );
      for (const job of flaky) {
        const log = await jobLog(repository, job.id);
        const tests = failingTests(log);
        const failedAt = `https://github.com/${repository}/actions/runs/${run.id}/job/${job.id}`;
        if (tests.length) {
          for (const test of tests) {
            say(
              upsertIssue(
                repository,
                "flaky-test",
                `Flaky test: ${quiet(test, 180)}`,
                FLAKY_BODY,
                `Failed in [${quiet(job.name)}](${failedAt}), then passed: ${where}.`,
                dryRun,
              ),
            );
          }
        } else {
          const errors = errorLines(log).map((e) => `    ${quiet(e, 300)}`);
          say(
            upsertIssue(
              repository,
              "flaky-test",
              `Flaky job: ${run.name} / ${quiet(jobKey(job.name), 150)}`,
              FLAKY_JOB_BODY,
              `[Failed](${failedAt}), then passed: ${where}.\n\n${errors.join("\n") || "    (no error lines in the log)"}`,
              dryRun,
            ),
          );
        }
      }
      if (!flaky.length) say("No job failed and then passed on this commit.");
    }

    for (const over of overBudget(run.name, jobs, latest, budgets)) {
      say(
        upsertIssue(
          repository,
          "ci-budget",
          `CI over budget: ${run.name} / ${over.job}`,
          BUDGET_BODY,
          `${over.minutes.toFixed(1)} minutes against a budget of ${over.budget}: ${where}.`,
          dryRun,
        ),
      );
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`);
  }
}

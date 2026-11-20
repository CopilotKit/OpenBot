/**
 * Contributor CI goes second (.github/workflows/contributor-ci.yml, every five minutes).
 *
 * CI from a pull request opened from a fork runs on the shared standard runners, one run at a time
 * (CI's and Desktop's `concurrency` put every fork run in one group). When CopilotKit's own runs (a
 * branch of this repository, or main) have a job waiting for a runner, this cancels the fork runs in
 * progress or queued and says so on each pull request, once. When nothing of CopilotKit's is waiting
 * and no fork run of that workflow is active, it re-runs the oldest fork run that was cancelled on its
 * pull request's current commit and has not run since, one per workflow at a time, so they drain one
 * after another. That also picks up a fork run GitHub dropped from the shared group's pending slot.
 *
 * Usage: bun scripts/contributor-ci.ts [--dry-run]
 *
 * Env: GITHUB_REPOSITORY and GH_TOKEN (actions: write, pull-requests: write).
 */

/** How long a CopilotKit job may wait for a runner before contributor CI makes way. */
export const WAIT_MINUTES = 3;

/** How far back a cancelled contributor run is still re-run. */
export const RESUME_HOURS = 24;

/** The comment's marker, so a pull request is told once per run. */
export const PAUSED_MARKER = "<!-- contributor-ci: paused";

/** The workflows whose fork runs this pauses and re-runs. */
export const WORKFLOWS = [
  ".github/workflows/ci.yml",
  ".github/workflows/desktop.yml",
];

export type Run = {
  id: number;
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  created_at: string;
  head_repository?: { full_name?: string } | null;
  pull_requests?: { number: number }[];
};

export type Job = { status: string; created_at: string };

/** A pull request from a fork, run against this repository. */
export function isContributorRun(run: Run, repository: string): boolean {
  return (
    run.event === "pull_request" &&
    WORKFLOWS.includes(run.path) &&
    (run.head_repository?.full_name ?? "").toLowerCase() !==
      repository.toLowerCase()
  );
}

const ACTIVE = new Set([
  "queued",
  "in_progress",
  "waiting",
  "pending",
  "requested",
]);

/** Whether a CopilotKit job has waited longer than WAIT_MINUTES for a runner. */
export function teamIsWaiting(
  runs: Run[],
  jobsOf: (run: Run) => Job[],
  repository: string,
  now: number,
): Run | undefined {
  const longAgo = (time: string) =>
    now - Date.parse(time) > WAIT_MINUTES * 60_000;
  return runs.find((run) => {
    if (!ACTIVE.has(run.status) || isContributorRun(run, repository)) {
      return false;
    }
    // A pull request from a fork that is not one of ours is never the team's, whatever workflow.
    if (
      run.event === "pull_request" &&
      (run.head_repository?.full_name ?? "").toLowerCase() !==
        repository.toLowerCase()
    ) {
      return false;
    }
    if (run.status === "queued") return longAgo(run.created_at);
    return jobsOf(run).some(
      (job) => job.status === "queued" && longAgo(job.created_at),
    );
  });
}

export type Plan = {
  cancel: Run[];
  rerun: Run[];
  why: string;
};

export type Facts = {
  repository: string;
  now: number;
  /** Every active run of the repository. */
  active: Run[];
  /** Fork runs of the watched workflows cancelled in the last RESUME_HOURS, newest first. */
  cancelled: Run[];
  jobsOf: (run: Run) => Job[];
  /** The commit a pull request is at now, or undefined when it is closed. */
  headOf: (number: number) => string | undefined;
  /** Every run of a workflow at a commit. */
  runsAt: (path: string, sha: string) => Run[];
};

export function plan(facts: Facts): Plan {
  const contributors = facts.active.filter((run) =>
    isContributorRun(run, facts.repository),
  );
  const waiting = teamIsWaiting(
    facts.active,
    facts.jobsOf,
    facts.repository,
    facts.now,
  );
  if (waiting) {
    return {
      cancel: contributors,
      rerun: [],
      why: contributors.length
        ? `Run ${waiting.id} of CopilotKit's has waited over ${WAIT_MINUTES} minutes for a runner: pausing ${contributors.length} contributor run(s).`
        : `Run ${waiting.id} of CopilotKit's is waiting for a runner; no contributor run is active.`,
    };
  }
  const rerun: Run[] = [];
  for (const path of WORKFLOWS) {
    if (contributors.some((run) => run.path === path)) continue;
    const candidates = facts.cancelled
      .filter(
        (run) => run.path === path && isContributorRun(run, facts.repository),
      )
      .filter(
        (run) =>
          facts.now - Date.parse(run.created_at) < RESUME_HOURS * 3_600_000,
      )
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    for (const run of candidates) {
      const number = run.pull_requests?.[0]?.number;
      if (number === undefined || facts.headOf(number) !== run.head_sha)
        continue;
      // Not when this commit has run again since, or is running now.
      const since = facts
        .runsAt(path, run.head_sha)
        .some(
          (other) =>
            other.id !== run.id &&
            (ACTIVE.has(other.status) || other.conclusion !== "cancelled"),
        );
      if (since) continue;
      rerun.push(run);
      break;
    }
  }
  return {
    cancel: [],
    rerun,
    why: rerun.length
      ? `Nothing of CopilotKit's is waiting: re-running ${rerun.map((run) => run.id).join(", ")}.`
      : "Nothing of CopilotKit's is waiting, and no contributor run needs re-running.",
  };
}

// ---------------------------------------------------------------------------------------------

function gh(args: string[], allowFailure = false): string {
  const result = Bun.spawnSync(["gh", "api", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0 && !allowFailure) {
    throw new Error(
      `gh api ${args.join(" ")}: ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString();
}

const json = <T>(args: string[]): T => JSON.parse(gh(args)) as T;

if (import.meta.main) {
  const dryRun = process.argv.includes("--dry-run");
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (!repository) {
    console.error("GITHUB_REPOSITORY is not set.");
    process.exit(2);
  }
  const runs = (status: string, extra = "") =>
    json<{ workflow_runs: Run[] }>([
      `repos/${repository}/actions/runs?status=${status}&per_page=100${extra}`,
    ]).workflow_runs;
  const active = [
    "queued",
    "in_progress",
    "waiting",
    "pending",
    "requested",
  ].flatMap((status) => runs(status));
  const since = new Date(Date.now() - RESUME_HOURS * 3_600_000)
    .toISOString()
    .slice(0, 19);
  const anyContributor = active.some((run) =>
    isContributorRun(run, repository),
  );
  // Only read when something could be re-run, to spend the token's requests where they matter.
  const cancelled = anyContributor
    ? []
    : runs("cancelled", `&event=pull_request&created=%3E${since}`).filter(
        (run) => isContributorRun(run, repository),
      );
  const result = plan({
    repository,
    now: Date.now(),
    active,
    cancelled,
    // A job list is read only when a contributor run could be paused or re-run.
    jobsOf: (run) =>
      anyContributor || cancelled.length > 0
        ? json<{ jobs: Job[] }>([
            `repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
          ]).jobs
        : [],
    headOf: (number) => {
      const pull = json<{ state: string; head: { sha: string } }>([
        `repos/${repository}/pulls/${number}`,
      ]);
      return pull.state === "open" ? pull.head.sha : undefined;
    },
    runsAt: (path, sha) =>
      json<{ workflow_runs: Run[] }>([
        `repos/${repository}/actions/workflows/${path.split("/").at(-1)}/runs?head_sha=${sha}&per_page=100`,
      ]).workflow_runs,
  });
  console.log(result.why);
  for (const run of result.cancel) {
    console.log(
      `${dryRun ? "Would cancel" : "Cancelling"} run ${run.id} (${run.path}).`,
    );
    if (dryRun) continue;
    gh(
      ["-X", "POST", `repos/${repository}/actions/runs/${run.id}/cancel`],
      true,
    );
    const number = run.pull_requests?.[0]?.number;
    if (number === undefined) continue;
    const marker = `${PAUSED_MARKER} ${run.id} -->`;
    const comments = json<{ body: string }[]>([
      `repos/${repository}/issues/${number}/comments?per_page=100`,
    ]);
    if (comments.some((comment) => comment.body.includes(marker))) continue;
    gh([
      "-X",
      "POST",
      `repos/${repository}/issues/${number}/comments`,
      "-f",
      `body=${marker}\nCI for this pull request is paused while the team needs the runners. It will re-run on its own once they are free, and nothing is needed from you. Thanks for your patience.`,
    ]);
  }
  for (const run of result.rerun) {
    console.log(
      `${dryRun ? "Would re-run" : "Re-running"} run ${run.id} (${run.path}).`,
    );
    if (!dryRun)
      gh(["-X", "POST", `repos/${repository}/actions/runs/${run.id}/rerun`]);
  }
}

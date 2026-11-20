/**
 * The Release workflow (.github/workflows/cut-release.yml): one run that cuts a release in the order
 * it has to happen, each step starting only when the one before it has finished.
 *
 *   preflight    every check that can fail fast, before anything is built (scripts/release-preflight.ts)
 *   server       the server images' release: their version commit, their release checks, the images
 *                and the release files at this version, dispatched there and waited on
 *   release-pr   Create release PR, on the branch's tip once its CI is green, waited on; a dry run
 *                prints the version, the notes and the diff it would propose
 *   merge        merges that PR, only while the branch is still where the PR was cut from, which is
 *                what publishes (Publish release starts on the push)
 *   publish      waits for Publish release, then names the signing runs it started, which wait for
 *                their environments' reviewers as they always have
 *   follow-up    once both signing runs have finished (and the release is Latest, unless held):
 *                merges the merge-back into main, merges the server images' version change, and
 *                moves the server images to main after the merge-back, merging that once every
 *                check passes, so their checks hold them to the release just published
 *
 *   bun scripts/release-run.ts <step>      one step, reading the earlier steps' results from the env
 *   bun scripts/release-run.ts all         every step in turn, as a person would run it locally
 *
 * Env:
 *   GITHUB_REPOSITORY, GITHUB_TOKEN   this repository, and a token that can dispatch and read its runs
 *   MERGE_TOKEN                       a token whose merge starts workflows (not GITHUB_TOKEN); merge only
 *   SERVER_REPOSITORY, SERVER_TOKEN   where the server images are released, and a token that can read
 *                                     it and dispatch its Release workflow
 *   RELEASE_REF                       the branch being released: main, or release/X.Y
 *   BUMP                              patch or minor
 *   KIND                              rc, or final (from main, a stable release; from release/X.Y, the
 *                                     final that finishes its candidates)
 *   DRY_RUN                           true: no tag, no publish, Latest untouched, no PR opened or merged
 *   SERVER_WRITE_TOKEN                a token that can push a branch and open and merge PRs where the
 *                                     server images are built; follow-up only
 *   HOLD_LATEST                       RELEASE_HOLD_LATEST, the releases kept from Latest; follow-up only
 *   SERVER_RUN_ID                     wait on this server run instead of dispatching one (a re-run)
 *
 * Nothing here prints the server images' repository or its commits: this repository's run logs are
 * public. The server run is named by its number, and its log is read where it ran.
 */
import { appendFileSync } from "node:fs";
import { type CiRun, ciOnParent } from "./release-ci-gate";
import {
  notesProblems,
  policyProblems,
  previousStable,
  type ReleasePolicy,
  versionProblems,
} from "./release-preflight";
import { type Kind, nextVersion } from "./release-version";

const API = "https://api.github.com";
/** The charts the server images publish, whose appVersion is the version their images install. */
export const SERVER_CHARTS = ["openbot", "openbot-bundle", "openbot-agent"];
const CREATE_RELEASE_PR = "release.yml";
const PUBLISH_RELEASE = "publish-release.yml";
const SERVER_RELEASE = "release.yml";
const SIGNING = ["desktop-macos-signing.yml", "desktop-signing.yml"];

class Problem extends Error {}

/** A repository on the API. `label` is what an error calls it, so the server's name never shows. */
export class Repo {
  constructor(
    readonly name: string,
    private readonly token: string,
    readonly label: string,
  ) {}

  async request(
    method: string,
    path: string,
    body?: unknown,
    accept = "application/vnd.github+json",
  ): Promise<Response> {
    const response = await fetch(`${API}/repos/${this.name}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: accept,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response;
  }

  /** The JSON answer, or an error naming only the label, the path within it and the status. */
  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.request(method, path, body);
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(
        `${this.label} answered ${response.status} to ${method} ${path.split("?")[0]}: ${detail}`,
      );
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.json<T>("GET", path);
  }

  /** A file at a commit, as text, or undefined when it is not there. */
  async file(path: string, ref: string): Promise<string | undefined> {
    const response = await this.request(
      "GET",
      `contents/${path}?ref=${ref}`,
      undefined,
      "application/vnd.github.raw+json",
    );
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(
        `${this.label} answered ${response.status} reading ${path}.`,
      );
    }
    return response.text();
  }

  async exists(path: string): Promise<boolean> {
    const response = await this.request("GET", path);
    if (response.status === 404) return false;
    if (!response.ok)
      throw new Error(`${this.label} answered ${response.status} to ${path}.`);
    return true;
  }
}

/** Everything a step needs from the environment. */
export type Context = {
  openbot: Repo;
  server: Repo;
  merger?: Repo;
  /** Where the server images are built, with a token that can push a branch, open and merge PRs. */
  serverWriter?: Repo;
  ref: string;
  bump: "patch" | "minor";
  kind: "rc" | "final";
  dryRun: boolean;
  waitSeconds: number;
  pollSeconds: number;
  log: (line: string) => void;
};

/** What preflight decided, which every later step reads. */
export type Plan = {
  /** `stable`, `rc` or `final`, as Create release PR's `kind` takes it. */
  cutKind: Kind;
  version: string;
  previous: string;
  prerelease: boolean;
  latest: boolean;
  tip: string;
  pin: string;
};

const short = (sha: string) => sha.slice(0, 12);

/** What Create release PR is asked for: `final` from main is a stable release. */
export function cutKind(ref: string, kind: "rc" | "final"): Kind {
  if (kind === "rc") return "rc";
  return ref === "main" ? "stable" : "final";
}

/** The appVersion a Chart.yaml names, quoted or not. */
export function appVersionOf(chart: string): string | undefined {
  return /^appVersion:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/m.exec(chart)?.[1];
}

/** Whether a stable release of `version` sorts at or above the current Latest, as release-becomes-latest.sh decides. */
export function becomesLatest(
  version: string,
  prerelease: boolean,
  currentLatest: string | undefined,
): boolean {
  if (prerelease) return false;
  if (!currentLatest) return true;
  const a = version.split(".").map(Number);
  const b = currentLatest
    .replace(/^v/, "")
    .split("-")[0]
    .split(".")
    .map(Number);
  for (const index of [0, 1, 2]) {
    if ((a[index] ?? 0) !== (b[index] ?? 0))
      return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return true;
}

type Run = {
  id: number;
  html_url: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  event: string;
  path: string;
  head_branch: string | null;
  head_repository?: { full_name?: string } | null;
};

/**
 * Every workflow that ran on the push of one commit, taken together: passed when each one's newest
 * run succeeded (or was skipped), running while any is still going, failed when any did not pass,
 * none when nothing ran. A pull request's runs say nothing about the commit itself.
 */
export function serverChecksState(
  runs: readonly Run[],
): "passed" | "running" | "failed" | "none" {
  const pushes = runs.filter((run) => run.event === "push");
  if (pushes.length === 0) return "none";
  const newest = new Map<string, Run>();
  for (const run of pushes) {
    const key = run.path;
    const seen = newest.get(key);
    if (!seen || run.id > seen.id) newest.set(key, run);
  }
  const latest = [...newest.values()];
  if (latest.some((run) => run.status !== "completed")) return "running";
  return latest.every((run) =>
    ["success", "skipped"].includes(run.conclusion ?? ""),
  )
    ? "passed"
    : "failed";
}

async function runsAt(
  repo: Repo,
  workflow: string,
  sha: string,
): Promise<Run[]> {
  const { workflow_runs } = await repo.get<{ workflow_runs: Run[] }>(
    `actions/workflows/${workflow}/runs?head_sha=${sha}&event=push&per_page=100`,
  );
  return workflow_runs;
}

async function branchTip(repo: Repo, ref: string): Promise<string> {
  return (await repo.get<{ sha: string }>(`commits/${encodeURIComponent(ref)}`))
    .sha;
}

/** Waits until main's CI passed on `sha`; a failure, or no run at all, is a problem. */
async function mainCiGreen(
  ctx: Context,
  sha: string,
): Promise<string | undefined> {
  const deadline = Date.now() + ctx.waitSeconds * 1000;
  for (;;) {
    const state = ciOnParent(
      (await runsAt(ctx.openbot, "ci.yml", sha)) as CiRun[],
      sha,
      ctx.openbot.name,
    );
    if (state.state === "passed") {
      ctx.log(`main's CI passed on ${short(sha)}: ${state.run.html_url}`);
      return undefined;
    }
    if (state.state === "none") {
      return `${state.reason.replace(sha, short(sha))}. A release is cut only from a commit whose CI is green.`;
    }
    if (Date.now() >= deadline) {
      return `main's CI on ${short(sha)} was still running after ${ctx.waitSeconds} seconds: ${state.run.html_url}`;
    }
    ctx.log(
      `main's CI on ${short(sha)} is ${state.run.status}; waiting for it.`,
    );
    await Bun.sleep(ctx.pollSeconds * 1000);
  }
}

/** Every check, all of them run before any is reported, so one run names everything to fix. */
export async function preflight(ctx: Context): Promise<Plan> {
  const { openbot, server, ref } = ctx;
  const problems: string[] = [];
  const fail = (): never => {
    for (const problem of problems) console.log(`::error::${problem}`);
    throw new Problem(
      `Preflight found ${problems.length} problem${problems.length === 1 ? "" : "s"}. Nothing was built.`,
    );
  };

  if (ref !== "main" && !/^release\/\d+\.\d+$/.test(ref)) {
    problems.push(
      `A release is cut from main or a release/X.Y branch, not ${ref}.`,
    );
    fail();
  }
  const kind = cutKind(ref, ctx.kind);
  const tip = await branchTip(openbot, ref);
  ctx.log(
    `Releasing ${ref} at ${short(tip)}: ${ctx.bump}, ${ctx.kind} (Create release PR kind ${kind}).`,
  );

  const packageJson = await openbot.file("package.json", tip);
  const current = packageJson
    ? (JSON.parse(packageJson).version as string)
    : "";
  let version: string;
  try {
    version = nextVersion(current, ctx.bump, kind);
  } catch (error) {
    problems.push(
      `${ref} is at ${current || "no version"}, and a ${ctx.kind} ${ctx.bump} cannot be cut from it: ${(error as Error).message}.`,
    );
    return fail();
  }
  const prerelease = version.includes("-");
  ctx.log(`OpenBot ${ref} says ${current}; this release is ${version}.`);

  // main must be green whichever branch is released: the release ends by merging back into main
  // and moving the server images to it.
  const mainTip = ref === "main" ? tip : await branchTip(openbot, "main");
  const red = await mainCiGreen(ctx, mainTip);
  if (red) problems.push(red);
  if (ref !== "main") {
    ctx.log(
      "CI does not run on pushes to a release branch, so publishing runs the full suite on the release commit.",
    );
  }

  if (await openbot.exists(`git/ref/tags/v${version}`)) {
    problems.push(`v${version} is already tagged.`);
  }
  const pulls = await openbot.get<
    { html_url: string; head: { ref: string } }[]
  >("pulls?state=open&per_page=100");
  for (const pull of pulls.filter((p) =>
    p.head.ref.startsWith("release/publish/"),
  )) {
    problems.push(
      `A release PR is already open: ${pull.html_url}. Merge or close it first.`,
    );
  }

  const releases = await openbot.get<{ tag_name: string; draft: boolean }[]>(
    "releases?per_page=100",
  );
  const previous =
    previousStable(
      releases
        .filter((release) => !release.draft)
        .map((release) => release.tag_name),
      version,
    ) ?? "";
  ctx.log(
    `The last release, which this one upgrades from: ${previous || "none"}.`,
  );

  const policyAt = async (sha: string) => {
    const text = await openbot.file("release-policy.json", sha);
    return text ? (JSON.parse(text) as ReleasePolicy) : undefined;
  };
  problems.push(
    ...policyProblems(
      `OpenBot ${ref} at ${short(tip)}`,
      await policyAt(tip),
      version,
      previous || undefined,
    ),
  );
  problems.push(
    ...notesProblems((await openbot.file("CHANGELOG.md", tip)) ?? "", version),
  );

  // The server images: the newest commit they release from, never named here, the OpenBot commit
  // they are built from, and the versions they would release with.
  const serverTip = await branchTip(server, "main");
  const pinEntry = await server.get<{ type: string; sha: string }>(
    `contents/openbot?ref=${serverTip}`,
  );
  const pin = pinEntry.type === "submodule" ? pinEntry.sha : "";
  if (!pin) {
    problems.push("The server images name no OpenBot commit to build from.");
    fail();
  }
  ctx.log(`The server images are built from OpenBot ${short(pin)}.`);
  problems.push(
    ...policyProblems(
      `OpenBot ${short(pin)}, which the server images are built from,`,
      await policyAt(pin),
      version,
      previous || undefined,
    ).map(
      (problem) =>
        `${problem} Then move the server images to a ${ref} commit that has it, and run Release again.`,
    ),
  );
  const compare = await openbot.get<{ status: string }>(
    `compare/${pin}...${tip}`,
  );
  if (compare.status !== "ahead" && compare.status !== "identical") {
    problems.push(
      `The server images are built from OpenBot ${short(pin)}, which is not on ${ref} (${compare.status}). Move them to a ${ref} commit.`,
    );
  }
  const state = serverChecksState(
    (
      await server.get<{ workflow_runs: Run[] }>(
        `actions/runs?head_sha=${serverTip}&event=push&per_page=100`,
      )
    ).workflow_runs,
  );
  if (state === "running") {
    ctx.log(
      "The server images' checks are still running on their newest commit; their release waits for them.",
    );
  } else if (state !== "passed") {
    problems.push(
      `The server images' checks ${state === "none" ? "never ran" : "failed"} on the commit they would release from. They must pass first.`,
    );
  }

  const serverPackage = await server.file("package.json", serverTip);
  const charts: Record<string, string> = {};
  for (const chart of SERVER_CHARTS) {
    const text = await server.file(`charts/${chart}/Chart.yaml`, serverTip);
    if (text === undefined) continue;
    charts[chart] = appVersionOf(text) ?? "no appVersion";
  }
  const serverVersion = serverPackage
    ? (JSON.parse(serverPackage).version as string)
    : "none";
  ctx.log(
    `The server images say ${serverVersion}; their charts: ${Object.entries(
      charts,
    )
      .map(([name, value]) => `${name} ${value}`)
      .join(", ")}.`,
  );
  problems.push(
    ...versionProblems(
      { openbot: current, server: serverVersion, charts },
      version,
    ),
  );

  let currentLatest: string | undefined;
  const latestResponse = await openbot.request("GET", "releases/latest");
  if (latestResponse.ok)
    currentLatest = ((await latestResponse.json()) as { tag_name: string })
      .tag_name;
  else if (latestResponse.status !== 404)
    throw new Error(
      `Could not read the Latest release: ${latestResponse.status}`,
    );
  const latest = becomesLatest(version, prerelease, currentLatest);

  if (problems.length > 0) fail();
  ctx.log(
    `Preflight passed: v${version}, upgrading from ${previous || "nothing"}, ${latest ? "becomes" : "does not become"} the latest release.`,
  );
  return { cutKind: kind, version, previous, prerelease, latest, tip, pin };
}

type Job = {
  name: string;
  status: string;
  conclusion: string | null;
  id: number;
};

/** Waits for a run to finish, saying each job as it finishes. Returns the jobs; throws on a failed run. */
async function waitForRun(
  ctx: Context,
  repo: Repo,
  id: number,
  label: string,
  timeoutMinutes: number,
): Promise<Job[]> {
  const deadline = Date.now() + timeoutMinutes * 60_000;
  const seen = new Map<string, string>();
  for (;;) {
    const run = await repo.get<Run>(`actions/runs/${id}`);
    const { jobs } = await repo.get<{ jobs: Job[] }>(
      `actions/runs/${id}/jobs?per_page=100`,
    );
    for (const job of jobs) {
      const said = `${job.status}${job.conclusion ? `: ${job.conclusion}` : ""}`;
      if (seen.get(job.name) !== said) {
        seen.set(job.name, said);
        ctx.log(`${label}: ${job.name}, ${said}`);
      }
    }
    if (run.status === "completed") {
      if (run.conclusion !== "success") {
        const failed = jobs
          .filter(
            (job) =>
              job.conclusion &&
              !["success", "skipped"].includes(job.conclusion),
          )
          .map((job) => job.name);
        throw new Problem(
          `${label} ended ${run.conclusion}${failed.length ? ` at ${failed.join(", ")}` : ""} (run ${id}).`,
        );
      }
      ctx.log(`${label} succeeded (run ${id}).`);
      return jobs;
    }
    if (Date.now() >= deadline) {
      throw new Problem(
        `${label} was still ${run.status} after ${timeoutMinutes} minutes (run ${id}).`,
      );
    }
    await Bun.sleep(ctx.pollSeconds * 1000);
  }
}

async function dispatch(
  repo: Repo,
  workflow: string,
  ref: string,
  inputs: Record<string, string>,
): Promise<number> {
  const answer = await repo.json<{ workflow_run_id?: number }>(
    "POST",
    `actions/workflows/${workflow}/dispatches`,
    { ref, inputs, return_run_details: true },
  );
  if (!answer?.workflow_run_id)
    throw new Error(`${repo.label} returned no run for ${workflow}.`);
  return answer.workflow_run_id;
}

/** The server images' release, dispatched there and waited on. */
export async function serverRelease(
  ctx: Context,
  plan: Plan,
  attach?: number,
): Promise<number> {
  const inputs = {
    version: `v${plan.version}`,
    previous: plan.previous,
    latest: String(plan.latest),
    dry_run: String(ctx.dryRun),
  };
  const id =
    attach ?? (await dispatch(ctx.server, SERVER_RELEASE, "main", inputs));
  ctx.log(
    `${attach ? "Waiting on" : "Started"} the server images' release of v${plan.version}${ctx.dryRun ? " (dry run)" : ""}, run ${id}: its version commit, release checks, images and release files.`,
  );
  await waitForRun(
    ctx,
    ctx.server,
    id,
    "server images",
    Number(process.env.SERVER_WAIT_MINUTES ?? 180),
  );
  return id;
}

/** The part of a job log from the line naming `marker` on, timestamps removed. */
export function logFrom(log: string, marker: string): string {
  const lines = log
    .split(/\r?\n/)
    .map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, ""));
  const start = lines.findIndex((line) => line.includes(marker));
  return (start < 0 ? lines.slice(-120) : lines.slice(start)).join("\n");
}

export type ReleasePr = { number: number; head: string; base: string };

/** Create release PR on the branch's tip, once its CI is green. A dry run prints what it would propose. */
export async function releasePr(
  ctx: Context,
  plan: Plan,
): Promise<ReleasePr | undefined> {
  const { openbot, ref } = ctx;
  if (ref === "main") {
    const tip = await branchTip(openbot, ref);
    if (tip !== plan.tip)
      ctx.log(`main moved to ${short(tip)} since preflight.`);
    const red = await mainCiGreen(ctx, tip);
    if (red) throw new Problem(red);
  }
  const id = await dispatch(openbot, CREATE_RELEASE_PR, ref, {
    bump: ctx.bump,
    kind: plan.cutKind,
    dry_run: String(ctx.dryRun),
  });
  ctx.log(
    `Create release PR, run ${id}: https://github.com/${openbot.name}/actions/runs/${id}`,
  );
  const jobs = await waitForRun(ctx, openbot, id, "Create release PR", 30);
  if (ctx.dryRun) {
    const job = jobs.find((candidate) => candidate.name === "create");
    if (job) {
      const response = await openbot.request(
        "GET",
        `actions/jobs/${job.id}/logs`,
      );
      if (response.ok) {
        ctx.log("What the release PR would propose:");
        ctx.log(logFrom(await response.text(), "git --no-pager diff"));
      }
    }
    return undefined;
  }
  const owner = openbot.name.split("/")[0];
  const [pull] = await openbot.get<{ number: number; head: { sha: string } }[]>(
    `pulls?state=open&head=${owner}:release/publish/v${plan.version}`,
  );
  if (!pull)
    throw new Problem(`Create release PR opened no PR for v${plan.version}.`);
  const commit = await openbot.get<{ parents: { sha: string }[] }>(
    `commits/${pull.head.sha}`,
  );
  const base = commit.parents[0]?.sha ?? "";
  ctx.log(`Release PR #${pull.number}, cut from ${short(base)}.`);
  return { number: pull.number, head: pull.head.sha, base };
}

/**
 * Merges the release PR, which publishes. Only while the branch is still the commit the PR was cut
 * from: merged onto a branch that moved, the changelog's promotion is applied to a different
 * Unreleased section, and lines land under the wrong heading.
 */
export async function merge(
  ctx: Context,
  plan: Plan,
  pr: ReleasePr,
): Promise<string> {
  const merger = ctx.merger;
  if (!merger)
    throw new Error("MERGE_TOKEN is needed to merge the release PR.");
  const tip = await branchTip(ctx.openbot, ctx.ref);
  if (tip !== pr.base) {
    await merger.json("PATCH", `pulls/${pr.number}`, { state: "closed" });
    await merger.request(
      "DELETE",
      `git/refs/heads/release/publish/v${plan.version}`,
    );
    throw new Problem(
      `${ctx.ref} moved from ${short(pr.base)} to ${short(tip)} while release PR #${pr.number} was open, so its notes could land in the wrong section. ` +
        "The PR is closed. Re-run the failed jobs to cut it again on the new tip.",
    );
  }
  const merged = await merger.json<{ sha: string }>(
    "PUT",
    `pulls/${pr.number}/merge`,
    {
      merge_method: "squash",
      sha: pr.head,
      commit_title: `Release v${plan.version} (#${pr.number})`,
    },
  );
  const commit = await ctx.openbot.get<{ parents: { sha: string }[] }>(
    `commits/${merged.sha}`,
  );
  if (commit.parents[0]?.sha !== pr.base) {
    console.log(
      `::error::Release PR #${pr.number} merged as ${short(merged.sha)} onto ${short(commit.parents[0]?.sha ?? "")}, not ${short(pr.base)}: check the published notes.`,
    );
  }
  ctx.log(
    `Merged release PR #${pr.number} as ${short(merged.sha)}. Publish release starts on the push.`,
  );
  return merged.sha;
}

/** Waits for Publish release on the merge, then names the signing runs it started. */
export async function publish(
  ctx: Context,
  plan: Plan,
  sha: string,
): Promise<void> {
  const { openbot } = ctx;
  let run: Run | undefined;
  const appearBy = Date.now() + 10 * 60_000;
  while (!run) {
    run = (await runsAt(openbot, PUBLISH_RELEASE, sha))[0];
    if (run) break;
    if (Date.now() >= appearBy)
      throw new Problem(`Publish release did not start for ${short(sha)}.`);
    await Bun.sleep(ctx.pollSeconds * 1000);
  }
  ctx.log(`Publish release: ${run.html_url}`);
  await waitForRun(
    ctx,
    openbot,
    run.id,
    "Publish release",
    Number(process.env.PUBLISH_WAIT_MINUTES ?? 240),
  );
  const tag = `v${plan.version}`;
  ctx.log(
    `${tag} is published, not Latest yet. Signing waits for its reviewers:`,
  );
  for (const workflow of SIGNING) {
    const { workflow_runs } = await openbot.get<{ workflow_runs: Run[] }>(
      `actions/workflows/${workflow}/runs?event=workflow_dispatch&branch=${tag}&per_page=5`,
    );
    for (const signing of workflow_runs)
      ctx.log(`- ${workflow}: ${signing.status}, ${signing.html_url}`);
  }
  ctx.log(
    plan.latest
      ? `Once both are approved and attached, the second makes ${tag} Latest (unless RELEASE_HOLD_LATEST lists it), starts Downloads sync and removes older installers.`
      : `${tag} does not become Latest.`,
  );
}

/** Whether RELEASE_HOLD_LATEST (tags separated by spaces or commas) lists `tag`. */
export function heldLatest(hold: string, tag: string): boolean {
  return hold
    .split(/[\s,]+/)
    .filter(Boolean)
    .includes(tag);
}

type CheckRun = { name: string; status: string; conclusion: string | null };

/**
 * A commit's check runs taken together: passed when there is at least one and every one finished
 * as a success, skipped or neutral; running while any is going; failed (with their names) when any
 * finished otherwise.
 */
export function checksState(
  runs: readonly CheckRun[],
):
  | { state: "passed" | "running" | "none" }
  | { state: "failed"; failed: string[] } {
  if (runs.length === 0) return { state: "none" };
  const failed = runs
    .filter(
      (run) =>
        run.status === "completed" &&
        !["success", "skipped", "neutral"].includes(run.conclusion ?? ""),
    )
    .map((run) => run.name);
  if (failed.length > 0) return { state: "failed", failed };
  if (runs.some((run) => run.status !== "completed"))
    return { state: "running" };
  return { state: "passed" };
}

/** Waits for every check on a commit to pass. A failure names the checks; a timeout says so. */
async function waitForChecks(
  ctx: Context,
  repo: Repo,
  sha: string,
  label: string,
  timeoutMinutes: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMinutes * 60_000;
  let said = "";
  for (;;) {
    const { check_runs } = await repo.get<{ check_runs: CheckRun[] }>(
      `commits/${sha}/check-runs?per_page=100`,
    );
    const result = checksState(check_runs);
    if (result.state === "passed") {
      ctx.log(`${label}: every check passed.`);
      return;
    }
    if (result.state === "failed") {
      throw new Problem(`${label} failed ${result.failed.join(", ")}.`);
    }
    if (Date.now() >= deadline) {
      throw new Problem(
        `${label} was still ${result.state === "none" ? "waiting for its checks to start" : "running its checks"} after ${timeoutMinutes} minutes.`,
      );
    }
    const now = `${check_runs.filter((run) => run.status === "completed").length} of ${check_runs.length} checks done`;
    if (now !== said) ctx.log(`${label}: ${now}.`);
    said = now;
    await Bun.sleep(ctx.pollSeconds * 1000);
  }
}

type Pull = {
  number: number;
  html_url: string;
  head: { sha: string; ref: string };
  mergeable: boolean | null;
};

async function openPull(repo: Repo, head: string): Promise<Pull | undefined> {
  const owner = repo.name.split("/")[0];
  const [pull] = await repo.get<Pull[]>(
    `pulls?state=open&head=${owner}:${head}`,
  );
  return pull;
}

/** Squash-merges a PR once GitHub has decided it can merge; refuses one that conflicts. */
async function mergePull(
  ctx: Context,
  repo: Repo,
  pull: Pull,
  title: string,
  label: string,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const current = await repo.get<Pull>(`pulls/${pull.number}`);
    if (current.mergeable === false) {
      throw new Problem(
        `${label} #${pull.number} conflicts with main. A person resolves it.`,
      );
    }
    if (current.mergeable === true || attempt >= 20) {
      const merged = await repo.json<{ sha: string }>(
        "PUT",
        `pulls/${pull.number}/merge`,
        { merge_method: "squash", sha: current.head.sha, commit_title: title },
      );
      ctx.log(`Merged ${label} #${pull.number} as ${short(merged.sha)}.`);
      return merged.sha;
    }
    await Bun.sleep(3000);
  }
}

/**
 * After both signing runs have finished: the release's merge-back into main, then the server
 * images brought to it, their version and the OpenBot commit they are built from, so their main's
 * checks hold them to the release just published. Left for later, every pull request there fails
 * the check that holds the server to the published releases, because the release it now must
 * upgrade from is missing from the policy it builds with.
 */
export async function followUp(ctx: Context, plan: Plan): Promise<void> {
  const tag = `v${plan.version}`;
  if (plan.prerelease) {
    ctx.log(
      `${tag} is a candidate: main and the server images stay as they are.`,
    );
    return;
  }
  const { openbot } = ctx;
  const waitMinutes = Number(process.env.FOLLOW_UP_WAIT_MINUTES ?? 330);
  const deadline = Date.now() + waitMinutes * 60_000;

  // Both signing runs, approved by their reviewers and finished.
  if (!ctx.dryRun) {
    for (const workflow of SIGNING) {
      for (;;) {
        const { workflow_runs } = await openbot.get<{ workflow_runs: Run[] }>(
          `actions/workflows/${workflow}/runs?event=workflow_dispatch&branch=${tag}&per_page=5`,
        );
        const newest = workflow_runs.sort((a, b) => b.id - a.id)[0];
        if (newest?.status === "completed") {
          if (newest.conclusion !== "success") {
            throw new Problem(
              `${workflow} for ${tag} ended ${newest.conclusion}: ${newest.html_url}. Sign it again from its tag, then re-run the failed jobs.`,
            );
          }
          ctx.log(`${workflow} for ${tag} succeeded.`);
          break;
        }
        if (Date.now() >= deadline) {
          throw new Problem(
            `${workflow} for ${tag} was not finished after ${waitMinutes} minutes${newest ? ` (${newest.status}: ${newest.html_url})` : ""}. Once it is, re-run the failed jobs.`,
          );
        }
        await Bun.sleep(ctx.pollSeconds * 1000);
      }
    }
    const held = heldLatest(process.env.HOLD_LATEST ?? "", tag);
    if (plan.latest && !held) {
      const latest = await openbot.get<{ tag_name: string }>("releases/latest");
      if (latest.tag_name !== tag) {
        throw new Problem(
          `Both signing runs finished but the Latest release is ${latest.tag_name}, not ${tag}.`,
        );
      }
      ctx.log(`${tag} is the Latest release.`);
    } else if (held) {
      ctx.log(
        `RELEASE_HOLD_LATEST holds ${tag}; it stays not Latest until the rollout finishes.`,
      );
    }
  }

  // The merge-back: main's own images again after a stable release from main, or the release
  // branch's version and fixes after a final.
  const mergeBack =
    ctx.ref === "main" ? `main-images/${tag}` : `merge-back/${tag}`;
  let pull = await openPull(openbot, mergeBack);
  if (ctx.dryRun) {
    ctx.log(
      `Would merge the PR from ${mergeBack} into main${pull ? ` (#${pull.number})` : ", once Publish release opens it"}.`,
    );
  } else {
    const appearBy = Date.now() + 10 * 60_000;
    while (!pull && ctx.ref !== "main" && Date.now() < appearBy) {
      await Bun.sleep(ctx.pollSeconds * 1000);
      pull = await openPull(openbot, mergeBack);
    }
    if (pull) {
      if (!ctx.merger) throw new Error("MERGE_TOKEN is needed to merge back.");
      await mergePull(
        ctx,
        ctx.merger,
        pull,
        ctx.ref === "main"
          ? `Run main's OpenBot images again after ${tag} (#${pull.number})`
          : `Merge ${ctx.ref} back into main (#${pull.number})`,
        "The merge-back PR",
      );
    } else if (ctx.ref === "main") {
      ctx.log(
        "main already runs its own images; there is nothing to merge back.",
      );
    } else {
      throw new Problem(`Publish release opened no PR from ${mergeBack}.`);
    }
  }
  const target = await branchTip(openbot, "main");

  // The server images: their version change first, then the OpenBot commit they build from.
  const writer = ctx.serverWriter;
  if (ctx.dryRun) {
    const pin = await ctx.server.get<{ sha: string }>(
      `contents/openbot?ref=${await branchTip(ctx.server, "main")}`,
    );
    ctx.log(
      `Would merge the server images' version change for ${tag}, then move them from OpenBot ${short(pin.sha)} to ${short(target)}, main after the merge-back, once their checks pass.`,
    );
    return;
  }
  if (!writer)
    throw new Error("SERVER_WRITE_TOKEN is needed to move the server images.");
  const versionPull = await openPull(writer, `release/${tag}`);
  if (versionPull) {
    await waitForChecks(
      ctx,
      writer,
      versionPull.head.sha,
      "The server images' version change",
      60,
    );
    await mergePull(
      ctx,
      writer,
      versionPull,
      `Release ${tag}: package.json and every published chart's appVersion (#${versionPull.number})`,
      "The server images' version change",
    );
  } else {
    const version = await writer.file("package.json", "main");
    if (!version || JSON.parse(version).version !== plan.version) {
      throw new Problem(
        `The server images' version change for ${tag} is neither open nor on their main.`,
      );
    }
    ctx.log(`The server images' main already says ${plan.version}.`);
  }

  const serverMain = await branchTip(writer, "main");
  const current = await writer.get<{ sha: string }>(
    `contents/openbot?ref=${serverMain}`,
  );
  if (current.sha === target) {
    ctx.log(
      `The server images are already built from OpenBot ${short(target)}.`,
    );
    return;
  }
  const branch = `release/openbot-${tag}`;
  const base = await writer.get<{ tree: { sha: string } }>(
    `git/commits/${serverMain}`,
  );
  const tree = await writer.json<{ sha: string }>("POST", "git/trees", {
    base_tree: base.tree.sha,
    tree: [{ path: "openbot", mode: "160000", type: "commit", sha: target }],
  });
  const message = `OpenBot at ${short(target)}, main after ${tag}\n\nBuilds the server images from public main after ${tag} and its merge-back, so their checks hold them to ${tag}'s release policy.`;
  const commit = await writer.json<{ sha: string }>("POST", "git/commits", {
    message,
    tree: tree.sha,
    parents: [serverMain],
  });
  if (await writer.exists(`git/ref/heads/${branch}`)) {
    await writer.json("PATCH", `git/refs/heads/${branch}`, {
      sha: commit.sha,
      force: true,
    });
  } else {
    await writer.json("POST", "git/refs", {
      ref: `refs/heads/${branch}`,
      sha: commit.sha,
    });
  }
  const pinPull =
    (await openPull(writer, branch)) ??
    (await writer.json<Pull>("POST", "pulls", {
      title: `OpenBot at ${short(target)}, main after ${tag}`,
      head: branch,
      base: "main",
      body: `${message.split("\n\n")[1]}\n\nOpened by the Release workflow, which merges it once every check passes.`,
    }));
  ctx.log(
    `Moving the server images from OpenBot ${short(current.sha)} to ${short(target)}: PR #${pinPull.number} where they are built. Every check runs on it.`,
  );
  await waitForChecks(
    ctx,
    writer,
    commit.sha,
    `The server images' PR #${pinPull.number}`,
    Number(process.env.PIN_WAIT_MINUTES ?? 150),
  );
  await mergePull(
    ctx,
    writer,
    pinPull,
    `OpenBot at ${short(target)}, main after ${tag} (#${pinPull.number})`,
    "The server images' PR",
  );
  ctx.log(
    `${tag} is finished: main is merged back, and the server images build from it.`,
  );
}

function summary(text: string) {
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

function output(values: Record<string, string | number | boolean>) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  for (const line of lines) console.log(line);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

function planFromEnv(): Plan {
  return {
    cutKind: required("CUT_KIND") as Kind,
    version: required("VERSION"),
    previous: process.env.PREVIOUS ?? "",
    prerelease: process.env.PRERELEASE === "true",
    latest: process.env.LATEST === "true",
    tip: required("TIP"),
    pin: process.env.PIN ?? "",
  };
}

/** A token from the env, or, run by a person, the one `gh` is signed in with. */
function token(name: string): string {
  if (process.env[name]) return process.env[name] as string;
  if (process.env.GITHUB_ACTIONS === "true") return required(name);
  const gh = Bun.spawnSync(["gh", "auth", "token"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const value = gh.stdout.toString().trim();
  if (gh.exitCode !== 0 || !value)
    throw new Error(`${name} is not set, and gh is not signed in.`);
  return value;
}

function contextFromEnv(): Context {
  const kind = required("KIND");
  const bump = required("BUMP");
  if (kind !== "rc" && kind !== "final")
    throw new Error(`KIND is rc or final, not ${kind}.`);
  if (bump !== "patch" && bump !== "minor")
    throw new Error(`BUMP is patch or minor, not ${bump}.`);
  return {
    openbot: new Repo(
      required("GITHUB_REPOSITORY"),
      token("GITHUB_TOKEN"),
      "OpenBot",
    ),
    server: new Repo(
      required("SERVER_REPOSITORY"),
      token("SERVER_TOKEN"),
      "the server images' repository",
    ),
    merger: process.env.MERGE_TOKEN
      ? new Repo(
          required("GITHUB_REPOSITORY"),
          process.env.MERGE_TOKEN,
          "OpenBot",
        )
      : undefined,
    serverWriter: process.env.SERVER_WRITE_TOKEN
      ? new Repo(
          required("SERVER_REPOSITORY"),
          process.env.SERVER_WRITE_TOKEN,
          "the server images' repository",
        )
      : undefined,
    ref: required("RELEASE_REF"),
    bump,
    kind,
    dryRun: process.env.DRY_RUN === "true",
    waitSeconds: Number(process.env.CI_WAIT_SECONDS ?? 2400),
    pollSeconds: Number(process.env.CI_POLL_SECONDS ?? 30),
    log: (line) => console.log(line),
  };
}

function planOutputs(plan: Plan) {
  output({
    cut_kind: plan.cutKind,
    version: plan.version,
    previous: plan.previous,
    prerelease: plan.prerelease,
    latest: plan.latest,
    tip: plan.tip,
    pin: plan.pin,
  });
  summary(
    `### Release v${plan.version}\n\n- From \`${plan.tip.slice(0, 12)}\`, upgrading from ${plan.previous || "nothing"}\n- The OpenBot commit the server images are built from: \`${plan.pin.slice(0, 12)}\`\n- Becomes Latest: ${plan.latest}\n`,
  );
}

if (import.meta.main) {
  const step = process.argv[2];
  try {
    const ctx = contextFromEnv();
    const attach = process.env.SERVER_RUN_ID
      ? Number(process.env.SERVER_RUN_ID)
      : undefined;
    if (ctx.dryRun)
      ctx.log(
        "Dry run: no tag is pushed, nothing is published, Latest does not move.",
      );
    if (step === "preflight") {
      planOutputs(await preflight(ctx));
    } else if (step === "server") {
      output({ server_run: await serverRelease(ctx, planFromEnv(), attach) });
    } else if (step === "release-pr") {
      const pr = await releasePr(ctx, planFromEnv());
      if (pr) output({ pr: pr.number, head: pr.head, base: pr.base });
    } else if (step === "merge") {
      const pr = {
        number: Number(required("PR")),
        head: required("HEAD"),
        base: required("BASE"),
      };
      output({ merged: await merge(ctx, planFromEnv(), pr) });
    } else if (step === "publish") {
      await publish(ctx, planFromEnv(), required("MERGED"));
    } else if (step === "follow-up") {
      await followUp(ctx, planFromEnv());
    } else if (step === "all") {
      const plan = await preflight(ctx);
      planOutputs(plan);
      await serverRelease(ctx, plan, attach);
      const pr = await releasePr(ctx, plan);
      if (pr && !ctx.dryRun)
        await publish(ctx, plan, await merge(ctx, plan, pr));
      await followUp(ctx, plan);
      if (ctx.dryRun)
        ctx.log(
          `Dry run of v${plan.version} finished: every step ran except the merges, the publish and Latest.`,
        );
    } else {
      throw new Error(
        "Usage: bun scripts/release-run.ts preflight|server|release-pr|merge|publish|follow-up|all",
      );
    }
  } catch (error) {
    console.log(
      `::error::${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

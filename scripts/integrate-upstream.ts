#!/usr/bin/env bun
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

/** One regression command. `cwd` is relative to the candidate; `env` adds to the inherited environment. */
export interface IntegrationCheck {
  name?: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
}
export interface IntegrationOptions {
  repositoryRoot: string;
  outputDirectory: string;
  branch: string;
  baseRef?: string;
  baselineCommit: string;
  upstreamRepository: string;
  upstreamRef: string;
  upstreamCommit: string;
  /** argv arrays, or "ci" to run the candidate's own CI `static` and `test` jobs. */
  checks: string[][] | "ci";
  /** Written only for a ready candidate: the branch, without the commits main already has. */
  bundlePath?: string;
}
export interface IntegrationReport {
  status: "ready" | "conflicts" | "checks-failed";
  accepted: false;
  originalDirty: boolean;
  originalCommit: string;
  baselineCommit: string;
  upstreamCommit: string;
  upstreamRepository: string;
  branch: string;
  candidateDirectory: string;
  conflictingPaths: string[];
  changedPaths: string[];
  checks: {
    name?: string;
    command: string[];
    cwd?: string;
    exitCode: number;
    stdout: string;
    stderr: string;
  }[];
}

/** CI jobs whose steps make up the default regression run, in the order they are run. */
export const CI_CHECK_JOBS = ["static", "test"] as const;
/** Each stream keeps its last 64 KiB, so a long test log cannot outgrow the report or job summary. */
const OUTPUT_TAIL = 64 * 1024;
const UPSTREAM_RECORD = ".openbot-upstream.json";

// `/dev/null` rather than an empty value: an empty `core.hooksPath` is not a documented way to turn
// hooks off, and this runs against repositories whose `.git` other code has had write access to.
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function exactCommit(cwd: string, commit: string): string {
  if (
    !/^[0-9a-f]{40}$/.test(commit) ||
    git(cwd, "rev-parse", "--verify", `${commit}^{commit}`) !== commit
  )
    throw new Error(`Expected exact available commit: ${commit}`);
  return commit;
}
function assertChecks(input: unknown): asserts input is string[][] | "ci" {
  if (input === "ci") return;
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.some(
      (command) =>
        !Array.isArray(command) ||
        command.length === 0 ||
        command.some((arg) => typeof arg !== "string" || arg.length === 0),
    )
  )
    throw new Error(
      'Declare "ci" or at least one regression check as a nonempty argv array',
    );
}
function tail(text: string): string {
  return text.length > OUTPUT_TAIL
    ? `[${text.length - OUTPUT_TAIL} earlier characters omitted]\n${text.slice(-OUTPUT_TAIL)}`
    : text;
}
function insideCandidate(path: string): string {
  const normalized = normalize(path);
  if (
    isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  )
    throw new Error(`CI working directory leaves the candidate: ${path}`);
  return normalized;
}

/**
 * The `run` steps of the candidate's own CI jobs, as CI runs them: bash with `-eo pipefail`, in the
 * step's working directory, with the job's and the step's environment. A step this cannot run the
 * way CI would (an expression, a condition, another shell) is refused rather than skipped, so the
 * default run never quietly tests less than CI does.
 */
export function ciChecks(workflow: string): IntegrationCheck[] {
  const parsed = Bun.YAML.parse(workflow) as {
    jobs?: Record<
      string,
      {
        env?: Record<string, unknown>;
        steps?: Record<string, unknown>[];
      }
    >;
  };
  const checks: IntegrationCheck[] = [];
  for (const id of CI_CHECK_JOBS) {
    const job = parsed.jobs?.[id];
    if (!job?.steps?.length)
      throw new Error(`ci.yml has no ${id} job with steps`);
    const strings = (value: unknown, where: string) => {
      const result: Record<string, string> = {};
      for (const [key, entry] of Object.entries(value ?? {})) {
        if (
          (typeof entry !== "string" && typeof entry !== "number") ||
          String(entry).includes("${{")
        )
          throw new Error(`ci.yml ${where} ${key} is not a literal value`);
        result[key] = String(entry);
      }
      return result;
    };
    const jobEnv = strings(job.env, `${id} env`);
    for (const [index, step] of job.steps.entries()) {
      if (step.uses !== undefined) continue;
      const where = `${id} step ${index + 1}`;
      if (typeof step.run !== "string")
        throw new Error(`ci.yml ${where} has neither uses nor run`);
      for (const key of Object.keys(step))
        if (!["name", "run", "working-directory", "env"].includes(key))
          throw new Error(`ci.yml ${where} uses ${key}, which this cannot run`);
      if (step.run.includes("${{"))
        throw new Error(`ci.yml ${where} uses an expression`);
      const cwd = step["working-directory"];
      if (cwd !== undefined && (typeof cwd !== "string" || cwd.includes("${{")))
        throw new Error(`ci.yml ${where} has an unusable working-directory`);
      checks.push({
        name: `ci ${id}: ${typeof step.name === "string" ? step.name : step.run.trim().split("\n")[0]}`,
        command: [
          "bash",
          "--noprofile",
          "--norc",
          "-eo",
          "pipefail",
          "-c",
          step.run,
        ],
        ...(cwd ? { cwd: insideCandidate(cwd) } : {}),
        env: { ...jobEnv, ...strings(step.env, `${where} env`) },
      });
    }
  }
  return checks;
}

/** Creates a standalone clone: neither the original index, refs, remotes nor dirty files are changed. */
export async function integrateUpstream(
  options: IntegrationOptions,
): Promise<IntegrationReport> {
  const root = resolve(options.repositoryRoot);
  const output = resolve(options.outputDirectory);
  const inside = relative(root, output);
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside)))
    throw new Error("Candidate must be outside the original checkout");
  if (existsSync(output))
    throw new Error(`Candidate path already exists: ${output}`);
  assertChecks(options.checks);
  git(root, "check-ref-format", "--branch", options.branch);
  if (
    !options.upstreamRef.startsWith("refs/tags/") ||
    /[\s:~^?*[\\]/.test(options.upstreamRef)
  )
    throw new Error("Select an exact upstream refs/tags/... release");
  if (!/^[0-9a-f]{40}$/.test(options.upstreamCommit))
    throw new Error("Upstream commit must be an exact SHA-1");
  if (
    !options.upstreamRepository ||
    options.upstreamRepository.startsWith("-") ||
    /[\r\n]/.test(options.upstreamRepository)
  )
    throw new Error("Invalid upstream repository");
  const originalCommit = git(
    root,
    "rev-parse",
    "--verify",
    `${options.baseRef ?? "HEAD"}^{commit}`,
  );
  exactCommit(root, options.baselineCommit);
  git(
    root,
    "merge-base",
    "--is-ancestor",
    options.baselineCommit,
    originalCommit,
  );
  const originalDirty =
    git(root, "status", "--porcelain=v1", "--untracked-files=all") !== "";

  git(
    dirname(output),
    "clone",
    "--no-hardlinks",
    "--no-checkout",
    "--",
    root,
    output,
  );
  git(output, "checkout", "-b", options.branch, originalCommit);
  git(
    output,
    "fetch",
    "--no-tags",
    "--",
    options.upstreamRepository,
    options.upstreamRef,
  );
  const fetched = git(output, "rev-parse", "FETCH_HEAD^{commit}");
  if (fetched !== options.upstreamCommit)
    throw new Error(
      `Upstream tag resolved to ${fetched}, expected ${options.upstreamCommit}; candidate retained at ${output}`,
    );
  git(output, "merge-base", "--is-ancestor", options.baselineCommit, fetched);
  const merge = spawnSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=OpenBot Upstream Integration",
      "-c",
      "user.email=openbot-integration@localhost",
      "merge",
      "--no-ff",
      "--no-edit",
      fetched,
    ],
    { cwd: output, encoding: "utf8" },
  );
  if (merge.error) throw merge.error;
  const conflictingPaths = git(output, "diff", "--name-only", "--diff-filter=U")
    .split("\n")
    .filter(Boolean);
  if (merge.status !== 0 && conflictingPaths.length === 0)
    throw new Error(
      `Git merge failed; candidate retained at ${output}: ${merge.stderr}${merge.stdout}`,
    );
  const report: IntegrationReport = {
    status: conflictingPaths.length ? "conflicts" : "ready",
    accepted: false,
    originalDirty,
    originalCommit,
    baselineCommit: options.baselineCommit,
    upstreamCommit: fetched,
    upstreamRepository: options.upstreamRepository,
    branch: options.branch,
    candidateDirectory: output,
    conflictingPaths,
    changedPaths: git(output, "diff", "--name-only", originalCommit)
      .split("\n")
      .filter(Boolean),
    checks: [],
  };
  const reportPath = resolve(output, ".git", "openbot-upgrade-report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (report.status === "conflicts") return report;
  writeFileSync(
    resolve(output, UPSTREAM_RECORD),
    upstreamRecord(options.upstreamRepository, options.baselineCommit, fetched),
  );
  git(output, "add", UPSTREAM_RECORD);
  git(
    output,
    "-c",
    "user.name=OpenBot Upstream Integration",
    "-c",
    "user.email=openbot-integration@localhost",
    "commit",
    "-m",
    `Record upstream baseline ${fetched}`,
  );
  const candidateCommit = git(output, "rev-parse", "HEAD");
  let checks: IntegrationCheck[];
  try {
    checks =
      options.checks === "ci"
        ? ciChecks(
            readFileSync(resolve(output, ".github/workflows/ci.yml"), "utf8"),
          )
        : options.checks.map((command) => ({ command }));
  } catch (error) {
    report.status = "checks-failed";
    report.checks.push({
      name: "read the candidate's CI checks",
      command: [],
      exitCode: 1,
      stdout: "",
      stderr: String(error),
    });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }
  for (const { name, command, cwd, env } of checks) {
    let check: IntegrationReport["checks"][number];
    try {
      const child = Bun.spawn(command, {
        cwd: cwd ? resolve(output, cwd) : output,
        env: { ...process.env, ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      check = {
        ...(name ? { name } : {}),
        command,
        ...(cwd ? { cwd } : {}),
        exitCode,
        stdout: tail(stdout),
        stderr: tail(stderr),
      };
    } catch (error) {
      check = {
        ...(name ? { name } : {}),
        command,
        ...(cwd ? { cwd } : {}),
        exitCode: 127,
        stdout: "",
        stderr: `Could not execute regression command: ${String(error)}`,
      };
    }
    if (
      check.exitCode === 0 &&
      (git(output, "rev-parse", "HEAD") !== candidateCommit ||
        git(output, "status", "--porcelain=v1", "--untracked-files=no") !== "")
    ) {
      check.exitCode = 1;
      check.stderr +=
        "\nRegression command changed candidate source or commit; review and re-run verification.";
    }
    report.checks.push(check);
    if (check.exitCode !== 0) {
      report.status = "checks-failed";
      break;
    }
  }
  if (report.status === "ready" && options.bundlePath)
    git(
      output,
      "bundle",
      "create",
      resolve(options.bundlePath),
      `refs/heads/${options.branch}`,
      `^${originalCommit}`,
    );
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function upstreamRecord(
  upstreamRepository: string,
  previousUpstreamCommit: string,
  upstreamCommit: string,
): string {
  return `${JSON.stringify({ upstreamRepository, previousUpstreamCommit, upstreamCommit }, null, 2)}\n`;
}

export interface BundleVerification {
  repositoryRoot: string;
  bundle: string;
  branch: string;
  /** The trusted branch the candidate must start from, e.g. refs/remotes/origin/main. */
  baseRef: string;
  baselineCommit: string;
  upstreamRepository: string;
  upstreamCommit: string;
  /** "github-token" cannot push changes to .github/workflows. */
  tokenKind: "app" | "github-token";
}
export interface VerifiedCandidate {
  commit: string;
  mergeCommit: string;
  startCommit: string;
  changedPaths: string[];
  workflowPaths: string[];
}

/**
 * Reads a candidate bundle that a job running upstream code produced, and accepts it only if its
 * content is exactly what trusted inputs determine: a clean merge of a commit on the trusted branch
 * with the verified upstream commit, recomputed here with `git merge-tree` (which runs no hooks,
 * filters or project code), plus the upstream record and nothing else. Commit messages and authors
 * are the only things the bundle decides.
 */
export function verifyCandidateBundle(
  options: BundleVerification,
): VerifiedCandidate {
  const root = resolve(options.repositoryRoot);
  const bundle = resolve(options.bundle);
  git(root, "check-ref-format", "--branch", options.branch);
  exactCommit(root, options.baselineCommit);
  if (!/^[0-9a-f]{40}$/.test(options.upstreamCommit))
    throw new Error("Upstream commit must be an exact SHA-1");
  if (options.tokenKind !== "app" && options.tokenKind !== "github-token")
    throw new Error("Token kind must be app or github-token");
  const base = git(
    root,
    "rev-parse",
    "--verify",
    `${options.baseRef}^{commit}`,
  );
  const head = `refs/heads/${options.branch}`;
  git(root, "bundle", "verify", "--quiet", bundle);
  const heads = git(root, "bundle", "list-heads", bundle)
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" ")[1]);
  if (heads.length !== 1 || heads[0] !== head)
    throw new Error(`Bundle must carry exactly ${head}`);
  git(
    root,
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    bundle,
    `+${head}:refs/openbot/candidate`,
  );
  const commit = git(root, "rev-parse", "refs/openbot/candidate^{commit}");
  const parents = (revision: string) =>
    git(root, "rev-list", "--parents", "-n", "1", revision).split(" ").slice(1);
  const [mergeCommit, ...extraParents] = parents(commit);
  if (!mergeCommit || extraParents.length)
    throw new Error(
      "Candidate must be one commit recording the upstream baseline",
    );
  const [startCommit, mergedUpstream, ...extra] = parents(mergeCommit);
  if (!startCommit || mergedUpstream !== options.upstreamCommit || extra.length)
    throw new Error(
      `Candidate must merge exactly upstream ${options.upstreamCommit} into the trusted branch`,
    );
  const ancestor = (older: string, newer: string) =>
    spawnSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "merge-base",
        "--is-ancestor",
        older,
        newer,
      ],
      { cwd: root },
    ).status === 0;
  if (!ancestor(startCommit, base))
    throw new Error(`Candidate does not start from ${options.baseRef}`);
  if (
    !ancestor(options.baselineCommit, startCommit) ||
    !ancestor(options.baselineCommit, mergedUpstream)
  )
    throw new Error(
      "Recorded upstream baseline is not an ancestor of both sides",
    );
  const recomputed = spawnSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "merge-tree",
      "--write-tree",
      "--no-messages",
      startCommit,
      mergedUpstream,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (recomputed.status !== 0)
    throw new Error(
      "Upstream does not merge cleanly into the trusted branch; the bundle claims otherwise",
    );
  if (
    recomputed.stdout.trim() !== git(root, "rev-parse", `${mergeCommit}^{tree}`)
  )
    throw new Error(
      "Candidate merge differs from a clean merge of the trusted branch and upstream",
    );
  const recorded = git(
    root,
    "diff-tree",
    "-r",
    "--no-commit-id",
    "--name-only",
    "--no-renames",
    mergeCommit,
    commit,
  );
  if (recorded !== UPSTREAM_RECORD)
    throw new Error(
      `Candidate may only add ${UPSTREAM_RECORD} after the merge`,
    );
  const entry = git(root, "ls-tree", commit, "--", UPSTREAM_RECORD).split(/\s/);
  if (entry[0] !== "100644" || entry[1] !== "blob")
    throw new Error(`${UPSTREAM_RECORD} must be a regular file`);
  if (
    git(root, "cat-file", "blob", `${commit}:${UPSTREAM_RECORD}`) !==
    upstreamRecord(
      options.upstreamRepository,
      options.baselineCommit,
      options.upstreamCommit,
    ).trim()
  )
    throw new Error(`${UPSTREAM_RECORD} does not record this integration`);
  const lines = (output: string) => [
    ...new Set(output.split("\n").filter(Boolean)),
  ];
  const workflowPaths = lines(
    git(
      root,
      "log",
      "--format=",
      "--name-only",
      "-m",
      "--no-renames",
      commit,
      "--not",
      base,
      "--",
      ".github/workflows",
    ),
  ).sort();
  if (options.tokenKind === "github-token" && workflowPaths.length)
    throw new Error(
      `This upstream release changes ${workflowPaths.join(", ")}. GITHUB_TOKEN cannot push changes to .github/workflows, so nothing was pushed. Configure the upgrade GitHub App (OPENBOT_UPGRADE_APP_CLIENT_ID and OPENBOT_UPGRADE_APP_PRIVATE_KEY, with contents, pull requests and workflows write) and run this again, or push the verified bundle from the run's artifact by hand.`,
    );
  return {
    commit,
    mergeCommit,
    startCommit,
    changedPaths: lines(git(root, "diff", "--name-only", startCommit, commit)),
    workflowPaths,
  };
}

/** Pushes a verified candidate to a new branch. Hooks never run, and an existing branch is never moved. */
export function publishCandidateBundle(
  options: BundleVerification & { remote: string },
): VerifiedCandidate {
  if (!options.remote || options.remote.startsWith("-"))
    throw new Error("Invalid remote");
  const verified = verifyCandidateBundle(options);
  git(
    resolve(options.repositoryRoot),
    "push",
    "--no-verify",
    "--",
    options.remote,
    `${verified.commit}:refs/heads/${options.branch}`,
  );
  return verified;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      repository: { type: "string", default: "." },
      output: { type: "string" },
      branch: { type: "string" },
      base: { type: "string" },
      baseline: { type: "string" },
      upstream: { type: "string" },
      tag: { type: "string" },
      commit: { type: "string" },
      checks: { type: "string" },
      report: { type: "string" },
      bundle: { type: "string" },
      "publish-bundle": { type: "string" },
      remote: { type: "string" },
      "token-kind": { type: "string" },
      summary: { type: "string" },
    },
  });
  try {
    if (values["publish-bundle"]) {
      if (
        !values.branch ||
        !values.base ||
        !values.baseline ||
        !values.upstream ||
        !values.commit ||
        !values.remote ||
        !values["token-kind"]
      )
        throw new Error(
          "Required: --publish-bundle FILE --branch --base REF --baseline --upstream --commit SHA --remote URL --token-kind app|github-token",
        );
      const verified = publishCandidateBundle({
        repositoryRoot: values.repository,
        bundle: values["publish-bundle"],
        branch: values.branch,
        baseRef: values.base,
        baselineCommit: values.baseline,
        upstreamRepository: values.upstream,
        upstreamCommit: values.commit,
        tokenKind: values["token-kind"] as BundleVerification["tokenKind"],
        remote: values.remote,
      });
      if (values.summary)
        writeFileSync(values.summary, `${JSON.stringify(verified, null, 2)}\n`);
      console.log(JSON.stringify(verified, null, 2));
    } else {
      if (
        !values.output ||
        !values.branch ||
        !values.baseline ||
        !values.upstream ||
        !values.tag ||
        !values.commit ||
        !values.checks
      )
        throw new Error(
          "Required: --output --branch --baseline --upstream --tag refs/tags/v... --commit SHA --checks ci|JSON_ARGV_ARRAYS",
        );
      const checks: unknown =
        values.checks === "ci" ? "ci" : JSON.parse(values.checks);
      assertChecks(checks);
      const report = await integrateUpstream({
        repositoryRoot: values.repository,
        outputDirectory: values.output,
        branch: values.branch,
        baseRef: values.base,
        baselineCommit: values.baseline,
        upstreamRepository: values.upstream,
        upstreamRef: values.tag,
        upstreamCommit: values.commit,
        checks,
        bundlePath: values.bundle,
      });
      if (values.report)
        writeFileSync(values.report, `${JSON.stringify(report, null, 2)}\n`);
      console.log(JSON.stringify(report, null, 2));
      if (report.status !== "ready") process.exitCode = 2;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (process.env.GITHUB_ACTIONS === "true") {
      console.error(`::error::${message}`);
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${message}\n`);
    } else console.error(message);
    process.exitCode = 1;
  }
}

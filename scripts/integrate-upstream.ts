#!/usr/bin/env bun
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

export interface IntegrationOptions {
  repositoryRoot: string;
  outputDirectory: string;
  branch: string;
  baseRef?: string;
  baselineCommit: string;
  upstreamRepository: string;
  upstreamRef: string;
  upstreamCommit: string;
  checks: string[][];
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
    command: string[];
    exitCode: number;
    stdout: string;
    stderr: string;
  }[];
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=", ...args], {
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
function assertChecks(input: unknown): asserts input is string[][] {
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
      "Declare at least one regression check as a nonempty argv array",
    );
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
      "core.hooksPath=",
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
    resolve(output, ".openbot-upstream.json"),
    `${JSON.stringify({ upstreamRepository: options.upstreamRepository, previousUpstreamCommit: options.baselineCommit, upstreamCommit: fetched }, null, 2)}\n`,
  );
  git(output, "add", ".openbot-upstream.json");
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
  for (const command of options.checks) {
    let check: IntegrationReport["checks"][number];
    try {
      const child = Bun.spawn(command, {
        cwd: output,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      check = { command, exitCode, stdout, stderr };
    } catch (error) {
      check = {
        command,
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
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
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
    },
  });
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
      "Required: --output --branch --baseline --upstream --tag refs/tags/v... --commit SHA --checks JSON_ARGV_ARRAYS",
    );
  const checks: unknown = JSON.parse(values.checks);
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
  });
  if (values.report)
    writeFileSync(values.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "ready") process.exitCode = 2;
}

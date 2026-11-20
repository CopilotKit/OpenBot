import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// A namespace import, so each test fails on its own if a function it drives is missing.
import * as upstreamIntegration from "../scripts/integrate-upstream";

/** A GitHub Actions expression, written so the linter does not read it as a template literal. */
const expression = (value: string) => ["$", "{{ ", value, " }}"].join("");
// The upstream upgrade workflow runs upstream code in one job and pushes in another. These drive
// the real hand-over between them: a candidate integrated and bundled by the first, verified and
// pushed from a fresh clone by the second, against real repositories.

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function scratch(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function commitAll(cwd: string, message: string) {
  git(cwd, "add", ".");
  git(
    cwd,
    "-c",
    "user.name=Upgrade Test",
    "-c",
    "user.email=upgrade@example.test",
    "commit",
    "-m",
    message,
  );
}
function hook(path: string, marker: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\necho ran > '${marker}'\n`);
  chmodSync(path, 0o755);
}

/** A fork whose main carries a customer change, and an upstream release tag in the same history. */
function fork(options: { upstreamChangesWorkflow?: boolean } = {}) {
  const root = join(scratch("openbot-fork-"), "fork");
  mkdirSync(root);
  git(root, "init", "-b", "main");
  writeFileSync(join(root, "core.txt"), "original\n");
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, ".github/workflows/ci.yml"), "name: CI\n");
  commitAll(root, "baseline");
  const baseline = git(root, "rev-parse", "HEAD");
  git(root, "switch", "-c", "upstream");
  writeFileSync(join(root, "core.txt"), "upstream\n");
  if (options.upstreamChangesWorkflow)
    writeFileSync(join(root, ".github/workflows/ci.yml"), "name: CI v2\n");
  commitAll(root, "upstream release");
  git(root, "tag", "v0.3.0");
  const upstream = git(root, "rev-parse", "HEAD");
  git(root, "switch", "main");
  writeFileSync(join(root, "customer.txt"), "customer component\n");
  commitAll(root, "customer extension");
  // The remote the publishing job pushes to: the fork as GitHub holds it.
  const remote = join(scratch("openbot-remote-"), "fork.git");
  git(root, "clone", "--bare", "--quiet", root, remote);
  return { root, baseline, upstream, remote };
}
const branch = "upgrade/upstream-1";

/** What the integrate job does: integrate, check and bundle. */
async function integrate(
  repo: ReturnType<typeof fork>,
  checks: string[][] = [[process.execPath, "-e", "0"]],
) {
  const output = join(scratch("openbot-candidate-"), "candidate");
  const bundle = join(scratch("openbot-bundle-"), "candidate.bundle");
  const report = await upstreamIntegration.integrateUpstream({
    repositoryRoot: repo.root,
    outputDirectory: output,
    branch,
    baseRef: "refs/heads/main",
    baselineCommit: repo.baseline,
    upstreamRepository: repo.root,
    upstreamRef: "refs/tags/v0.3.0",
    upstreamCommit: repo.upstream,
    checks,
    bundlePath: bundle,
  });
  return { output, bundle, report };
}
/** What the publish job starts from: a fresh clone of the fork's main. */
function freshClone(repo: ReturnType<typeof fork>) {
  const clone = join(scratch("openbot-publish-"), "clone");
  git(repo.root, "clone", "--quiet", "--branch", "main", repo.remote, clone);
  return clone;
}
function verification(
  repo: ReturnType<typeof fork>,
  clone: string,
  bundle: string,
) {
  return {
    repositoryRoot: clone,
    bundle,
    branch,
    baseRef: "refs/remotes/origin/main",
    baselineCommit: repo.baseline,
    upstreamRepository: repo.root,
    upstreamCommit: repo.upstream,
    tokenKind: "app" as const,
  };
}
/** Builds a bundle from a candidate after rewriting its last commits, as a hostile job could. */
function rebundle(output: string, bundle: string, originalCommit: string) {
  rmSync(bundle, { force: true });
  git(
    output,
    "bundle",
    "create",
    bundle,
    `refs/heads/${branch}`,
    `^${originalCommit}`,
  );
}

describe("handing an integrated candidate to the publishing job", () => {
  test("a fresh clone verifies the bundle and pushes exactly the candidate, and no hook runs on either side", async () => {
    const repo = fork();
    const markers = scratch("openbot-markers-");
    // A check is upstream code. Here it plants a pre-push hook in the candidate, which is where
    // the old single job pushed from with the write token.
    const plant = join(markers, "candidate-hook");
    const { output, bundle, report } = await integrate(repo, [
      [
        process.execPath,
        "-e",
        `const fs=require('fs');fs.writeFileSync('.git/hooks/pre-push','#!/bin/sh\\necho ran > ${plant}\\n');fs.chmodSync('.git/hooks/pre-push',0o755)`,
      ],
    ]);
    expect(report.status).toBe("ready");
    expect(existsSync(bundle)).toBe(true);
    const clone = freshClone(repo);
    const local = join(markers, "publish-hook");
    hook(join(clone, ".git/hooks/pre-push"), local);
    hook(join(clone, ".git/hooks/reference-transaction"), local);

    const verified = upstreamIntegration.publishCandidateBundle({
      ...verification(repo, clone, bundle),
      remote: repo.remote,
    });

    expect(verified.commit).toBe(git(output, "rev-parse", "HEAD"));
    expect(git(repo.remote, "rev-parse", `refs/heads/${branch}`)).toBe(
      verified.commit,
    );
    expect(verified.changedPaths.sort()).toEqual([
      ".openbot-upstream.json",
      "core.txt",
    ]);
    expect(verified.workflowPaths).toEqual([]);
    expect(existsSync(plant)).toBe(false);
    expect(existsSync(local)).toBe(false);
    // The clone's working tree stays main; the candidate is only objects and one private ref.
    expect(git(clone, "rev-parse", "HEAD")).toBe(
      git(repo.root, "rev-parse", "main"),
    );
    expect(readFileSync(join(clone, "core.txt"), "utf8")).toBe("original\n");
  });

  test.each([
    [
      "a file changed after the merge",
      (output: string) => {
        writeFileSync(
          join(output, "customer.txt"),
          "replaced by upstream code\n",
        );
        git(output, "add", "customer.txt");
        git(
          output,
          "-c",
          "user.name=x",
          "-c",
          "user.email=x@x",
          "commit",
          "--amend",
          "--no-edit",
        );
      },
      "may only add .openbot-upstream.json",
    ],
    [
      "a merge whose tree is not the clean merge",
      (output: string) => {
        const [start, upstream] = git(
          output,
          "rev-parse",
          "HEAD~1^1",
          "HEAD~1^2",
        ).split("\n");
        writeFileSync(join(output, "backdoor.txt"), "x\n");
        git(output, "add", "backdoor.txt");
        const tree = git(output, "write-tree");
        const merge = git(
          output,
          "-c",
          "user.name=x",
          "-c",
          "user.email=x@x",
          "commit-tree",
          tree,
          "-p",
          start!,
          "-p",
          upstream!,
          "-m",
          "merge",
        );
        git(output, "rm", "-q", "--cached", "backdoor.txt");
        const record = git(
          output,
          "-c",
          "user.name=x",
          "-c",
          "user.email=x@x",
          "commit-tree",
          `${git(output, "rev-parse", "HEAD^{tree}")}`,
          "-p",
          merge,
          "-m",
          "record",
        );
        git(output, "update-ref", `refs/heads/${branch}`, record);
      },
      "differs from a clean merge",
    ],
    [
      "a record naming another upstream",
      (output: string) => {
        writeFileSync(
          join(output, ".openbot-upstream.json"),
          '{"upstreamCommit":"elsewhere"}\n',
        );
        git(output, "add", ".openbot-upstream.json");
        git(
          output,
          "-c",
          "user.name=x",
          "-c",
          "user.email=x@x",
          "commit",
          "--amend",
          "--no-edit",
        );
      },
      "does not record this integration",
    ],
    [
      "an extra commit on top",
      (output: string) => {
        writeFileSync(join(output, "later.txt"), "later\n");
        git(output, "add", "later.txt");
        git(
          output,
          "-c",
          "user.name=x",
          "-c",
          "user.email=x@x",
          "commit",
          "-m",
          "later",
        );
      },
      "merge exactly upstream",
    ],
  ])("refuses %s and pushes nothing", async (_name, tamper, reason) => {
    const repo = fork();
    const { output, bundle, report } = await integrate(repo);
    expect(report.status).toBe("ready");
    tamper(output);
    rebundle(output, bundle, report.originalCommit);
    const clone = freshClone(repo);
    expect(() =>
      upstreamIntegration.publishCandidateBundle({
        ...verification(repo, clone, bundle),
        remote: repo.remote,
      }),
    ).toThrow(reason);
    expect(() =>
      git(repo.remote, "rev-parse", "--verify", `refs/heads/${branch}`),
    ).toThrow();
  });

  test("refuses a bundle that merges a different upstream commit than the one dispatched", async () => {
    const repo = fork();
    const { bundle } = await integrate(repo);
    const clone = freshClone(repo);
    expect(() =>
      upstreamIntegration.verifyCandidateBundle({
        ...verification(repo, clone, bundle),
        upstreamCommit: repo.baseline,
      }),
    ).toThrow(`merge exactly upstream ${repo.baseline}`);
  });
});

describe("pushing with GITHUB_TOKEN", () => {
  function cli(
    repo: ReturnType<typeof fork>,
    clone: string,
    bundle: string,
    tokenKind: string,
  ) {
    const summary = join(scratch("openbot-summary-"), "summary.md");
    writeFileSync(summary, "");
    const run = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "../scripts/integrate-upstream.ts"),
        "--publish-bundle",
        bundle,
        "--repository",
        clone,
        "--branch",
        branch,
        "--base",
        "refs/remotes/origin/main",
        "--baseline",
        repo.baseline,
        "--upstream",
        repo.root,
        "--commit",
        repo.upstream,
        "--remote",
        repo.remote,
        "--token-kind",
        tokenKind,
      ],
      {
        env: {
          ...process.env,
          GITHUB_ACTIONS: "true",
          GITHUB_STEP_SUMMARY: summary,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return {
      exitCode: run.exitCode,
      stderr: run.stderr.toString(),
      summary: readFileSync(summary, "utf8"),
    };
  }

  test("fails clearly, before pushing, when the upstream release changes workflows", async () => {
    const repo = fork({ upstreamChangesWorkflow: true });
    const { bundle } = await integrate(repo);
    const result = cli(repo, freshClone(repo), bundle, "github-token");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("::error::");
    expect(result.stderr).toContain(".github/workflows/ci.yml");
    expect(result.stderr).toContain(
      "GITHUB_TOKEN cannot push changes to .github/workflows",
    );
    expect(result.summary).toContain("OPENBOT_UPGRADE_APP_CLIENT_ID");
    expect(() =>
      git(repo.remote, "rev-parse", "--verify", `refs/heads/${branch}`),
    ).toThrow();
  });

  test("an App token pushes the same workflow-changing candidate", async () => {
    const repo = fork({ upstreamChangesWorkflow: true });
    const { output, bundle } = await integrate(repo);
    const result = cli(repo, freshClone(repo), bundle, "app");
    expect(result.exitCode).toBe(0);
    expect(git(repo.remote, "rev-parse", `refs/heads/${branch}`)).toBe(
      git(output, "rev-parse", "HEAD"),
    );
  });

  test("GITHUB_TOKEN still pushes a candidate that leaves workflows alone", async () => {
    const repo = fork();
    const { bundle } = await integrate(repo);
    expect(cli(repo, freshClone(repo), bundle, "github-token").exitCode).toBe(
      0,
    );
  });
});

describe("the upstream upgrade workflow", () => {
  type Step = Record<string, unknown> & {
    run?: string;
    uses?: string;
    with?: Record<string, unknown>;
    env?: Record<string, unknown>;
  };
  type Job = {
    permissions?: Record<string, string>;
    needs?: string;
    if?: string;
    steps: Step[];
  };
  const workflow = Bun.YAML.parse(
    readFileSync(
      join(import.meta.dir, "../.github/workflows/upstream-upgrade.yml"),
      "utf8",
    ),
  ) as { permissions: Record<string, string>; jobs: Record<string, Job> };
  const jobs = Object.entries(workflow.jobs);
  const runsCandidate = (job: Job) =>
    job.steps.some((step) => step.run?.includes("--output"));
  const writes = (job: Job) =>
    Object.values(job.permissions ?? {}).includes("write");

  test("upstream code runs only in a job that cannot write, and the writing job runs none", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    const integrate = jobs.filter(([, job]) => runsCandidate(job));
    const publish = jobs.filter(([, job]) => writes(job));
    expect(integrate).toHaveLength(1);
    expect(publish).toHaveLength(1);
    const [, integrateJob] = integrate[0]!;
    const [publishName, publishJob] = publish[0]!;
    expect(integrateJob.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(integrateJob)).not.toContain("secrets.");
    expect(JSON.stringify(integrateJob)).not.toContain("GH_TOKEN");
    expect(publishJob.needs).toBe(integrate[0]![0]);
    expect(publishName).not.toBe(integrate[0]![0]);
    // Nothing from the candidate executes in the publishing job: no install, test or check run,
    // no checkout of anything but main, and the only artifact it reads is the bundle.
    for (const step of publishJob.steps) {
      expect(step.run ?? "").not.toMatch(
        /bun (install|test|run)|--output|--checks/,
      );
      if (step.uses?.startsWith("actions/checkout@"))
        expect(step.with?.ref).toBe("main");
      if (step.uses?.startsWith("actions/download-artifact@"))
        expect(String(step.with?.name)).toStartWith("upstream-bundle-");
    }
    const push = publishJob.steps.find((step) =>
      step.run?.includes("--publish-bundle"),
    );
    expect(push?.env?.GIT_CONFIG_KEY_2).toBe("core.hooksPath");
    expect(push?.env?.GIT_CONFIG_VALUE_2).toBe("/dev/null");
  });

  test("an App token is used when configured, and GITHUB_TOKEN only when it is not", () => {
    const publish = jobs.find(([, job]) => writes(job))![1];
    const app = publish.steps.find((step) =>
      step.uses?.startsWith("actions/create-github-app-token@"),
    );
    expect(app?.uses).toMatch(/@[0-9a-f]{40}$/);
    expect(app?.if).toBe("vars.OPENBOT_UPGRADE_APP_CLIENT_ID != ''");
    expect(app?.with).toMatchObject({
      "client-id": expression("vars.OPENBOT_UPGRADE_APP_CLIENT_ID"),
      "private-key": expression("secrets.OPENBOT_UPGRADE_APP_PRIVATE_KEY"),
      "permission-contents": "write",
      "permission-pull-requests": "write",
      "permission-workflows": "write",
    });
    for (const step of publish.steps.filter((step) => step.env?.GH_TOKEN))
      expect(step.env?.GH_TOKEN).toBe(
        expression("steps.app-token.outputs.token || secrets.GITHUB_TOKEN"),
      );
    const propose = publish.steps.find((step) =>
      step.run?.includes("gh pr create"),
    )!.run!;
    // Said plainly in the PR body and the job summary when falling back.
    expect(propose).toContain('if [ "$TOKEN_KIND" != app ]; then');
    expect(propose.match(/CI must be started by hand/g)).toHaveLength(2);
    expect(propose).toContain("cannot push changes to");
    expect(propose).toContain("GITHUB_STEP_SUMMARY");
  });
});

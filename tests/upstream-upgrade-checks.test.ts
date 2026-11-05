import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
// A namespace import, so each test fails on its own if a function it drives is missing.
import * as upstreamIntegration from "../scripts/integrate-upstream";

/** A GitHub Actions expression, written so the linter does not read it as a template literal. */
const expression = (value: string) => ["$", "{{ ", value, " }}"].join("");
// The upgrade's default checks are what CI runs. CI's test job needs a database, so the
// integration job has to have the same one, and the commands have to be CI's own.

const root = join(import.meta.dir, "..");
type Job = {
  services?: Record<string, unknown>;
  env?: Record<string, string>;
  steps: { run?: string; "working-directory"?: string }[];
  permissions?: Record<string, string>;
};
function workflow(name: string) {
  return Bun.YAML.parse(
    readFileSync(join(root, ".github/workflows", name), "utf8"),
  ) as { jobs: Record<string, Job> };
}
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
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

describe("the integration job's environment", () => {
  const ci = workflow("ci.yml").jobs.test!;
  const integrate = Object.values(workflow("upstream-upgrade.yml").jobs).find(
    (job) => job.steps.some((step) => step.run?.includes("--output")),
  )!;

  test("has the database CI's test job has", () => {
    expect(ci.services).toBeDefined();
    expect(integrate.services).toEqual(ci.services!);
  });

  test("points the suite at that database", () => {
    const service = ci.services!.postgres as {
      env: Record<string, string>;
      ports: string[];
    };
    for (const name of ["DATABASE_URL", "TEST_DATABASE_URL"]) {
      expect(ci.env?.[name]).toBeDefined();
      const url = new URL(integrate.env![name]!);
      expect(url.hostname).toBe("127.0.0.1");
      expect(url.username).toBe(service.env.POSTGRES_USER!);
      expect(url.password).toBe(service.env.POSTGRES_PASSWORD!);
      expect(url.port).toBe(service.ports[0]!.split(":")[0]!);
      expect(url.pathname).toBe(`/${service.env.POSTGRES_DB}`);
    }
  });

  test("defaults to the candidate's own CI checks", () => {
    expect(integrate.env?.UPGRADE_CHECKS).toBe(
      expression("vars.OPENBOT_UPGRADE_CHECKS || 'ci'"),
    );
    const run = integrate.steps.find((step) => step.run?.includes("--output"));
    expect(run?.run).toContain('--checks "$UPGRADE_CHECKS"');
  });
});

describe("CI checks", () => {
  test("this repository's ci.yml static and test jobs can be run as checks, in CI's order", () => {
    const jobs = workflow("ci.yml").jobs;
    const checks = upstreamIntegration.ciChecks(
      readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"),
    );
    const expected = (["static", "test"] as const).flatMap((id) =>
      jobs[id]!.steps.filter((step) => step.run).map((step) => ({
        script: step.run!,
        cwd: step["working-directory"],
      })),
    );
    expect(
      checks.map((check) => ({ script: check.command.at(-1), cwd: check.cwd })),
    ).toEqual(expected);
    for (const check of checks)
      expect(check.command.slice(0, -1)).toEqual([
        "bash",
        "--noprofile",
        "--norc",
        "-eo",
        "pipefail",
        "-c",
      ]);
    const migrate = checks.find((check) =>
      check.command.at(-1)?.includes("scripts/migrate.ts"),
    );
    expect(migrate?.cwd).toBe("server");
    expect(migrate?.env?.DATABASE_URL).toBe(jobs.test!.env!.DATABASE_URL!);
    expect(checks.at(-1)?.command.at(-1)).toBe("bun run test:ci");
  });

  function candidate(ci: string) {
    const repo = mkdtempSync(join(tmpdir(), "openbot-ci-checks-"));
    directories.push(repo, `${repo}-candidate`);
    git(repo, "init", "-b", "main");
    writeFileSync(join(repo, "core.txt"), "original\n");
    commitAll(repo, "baseline");
    const baseline = git(repo, "rev-parse", "HEAD");
    git(repo, "switch", "-c", "upstream");
    mkdirSync(join(repo, ".github/workflows"), { recursive: true });
    mkdirSync(join(repo, "server"));
    writeFileSync(join(repo, "server/.keep"), "");
    writeFileSync(
      join(repo, "log.js"),
      `const fs = require("fs"), path = require("path");
fs.appendFileSync(path.join(process.env.LOG_DIR, "log"), [process.argv[2], path.basename(process.cwd()), process.env.FROM_JOB ?? "-", process.env.FROM_STEP ?? "-"].join(" ") + "\\n");
`,
    );
    writeFileSync(join(repo, ".github/workflows/ci.yml"), ci);
    commitAll(repo, "upstream release");
    git(repo, "tag", "v0.3.0");
    const upstream = git(repo, "rev-parse", "HEAD");
    git(repo, "switch", "main");
    return {
      repositoryRoot: repo,
      outputDirectory: `${repo}-candidate`,
      branch: "upgrade/upstream-v0.3.0",
      baselineCommit: baseline,
      upstreamRepository: repo,
      upstreamRef: "refs/tags/v0.3.0",
      upstreamCommit: upstream,
      checks: "ci" as const,
    };
  }
  const bun = process.execPath;

  test("runs the candidate's CI steps in order, in their directories, with their environment", async () => {
    const logs = mkdtempSync(join(tmpdir(), "openbot-ci-log-"));
    directories.push(logs);
    const options = candidate(`
jobs:
  static:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: ${bun} log.js static
  test:
    runs-on: ubuntu-latest
    env:
      LOG_DIR: ${logs}
      FROM_JOB: job
    steps:
      - run: ${bun} ../log.js test
        working-directory: server
        env:
          FROM_STEP: step
      - name: pipefail is on, as in CI
        run: false | true
      - run: ${bun} log.js unreachable
`);
    process.env.LOG_DIR = logs;
    try {
      const report = await upstreamIntegration.integrateUpstream(options);
      expect(report.status).toBe("checks-failed");
      expect(report.checks.map((check) => check.exitCode)).toEqual([0, 0, 1]);
      expect(report.checks[2]?.name).toBe("ci test: pipefail is on, as in CI");
      expect(readFileSync(join(logs, "log"), "utf8")).toBe(
        `static ${basename(options.outputDirectory)} - -\ntest server job step\n`,
      );
    } finally {
      delete process.env.LOG_DIR;
    }
  });

  test.each([
    [
      "an expression",
      `      - run: echo ${expression("matrix.target")}\n`,
      "uses an expression",
    ],
    ["a condition", "      - run: echo hi\n        if: always()\n", "uses if"],
    [
      "another shell",
      "      - run: echo hi\n        shell: pwsh\n",
      "uses shell",
    ],
  ])(
    "refuses a CI step with %s instead of skipping it",
    async (_name, step, reason) => {
      const report = await upstreamIntegration.integrateUpstream(
        candidate(
          `jobs:\n  static:\n    steps:\n      - run: "true"\n  test:\n    steps:\n${step}`,
        ),
      );
      expect(report.status).toBe("checks-failed");
      expect(report.checks).toHaveLength(1);
      expect(report.checks[0]?.stderr).toContain(reason);
    },
  );
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Budgets,
  budgetFor,
  failingTests,
  flakyAcrossRuns,
  flakyInRun,
  type Job,
  overBudget,
  quiet,
} from "./ci-watch";

/**
 * The rules scripts/ci-watch.ts files issues by, held to real CI output: the jobs of a run of this
 * repository's CI whose WebKit job failed and then passed when re-run (run 45545231902), the log
 * of a failed WebKit job, and the log of a desktop build whose Rust test failed and then passed.
 */

const FIXTURES = join(import.meta.dir, "ci-watch.fixtures");
const rerun = JSON.parse(
  readFileSync(join(FIXTURES, "rerun-jobs.json"), "utf8"),
) as Job[];
const webkitLog = readFileSync(join(FIXTURES, "bun-webkit.log"), "utf8");

describe("a flaky job", () => {
  test("is one that failed and then passed when its run was re-run, never the job that adds the others up", () => {
    expect(flakyInRun(rerun, 2).map((job) => job.name)).toEqual([
      "app (real browser, WebKit)",
    ]);
  });

  test("is returned as its failed attempt, whose log names the test", () => {
    const [job] = flakyInRun(rerun, 2);
    expect(job?.run_attempt).toBe(1);
    expect(job?.conclusion).toBe("failure");
  });

  test("is none in a run that was not re-run", () => {
    const firstAttempt = rerun.filter((job) => job.run_attempt === 1);
    expect(flakyInRun(firstAttempt, 1)).toEqual([]);
  });

  test("is also one that failed in an earlier run of the same commit and passes now", () => {
    const failed = rerun.filter((job) => job.run_attempt === 1);
    const passed = rerun.filter((job) => job.run_attempt === 2);
    expect(flakyAcrossRuns(passed, [failed]).map((job) => job.name)).toEqual([
      "app (real browser, WebKit)",
    ]);
  });
});

describe("the tests a failed job's log names", () => {
  test("are Bun's failed tests, each once, by their full name", () => {
    expect(failingTests(webkitLog)).toEqual([
      "the chat and the audit log's filters while the organization is moved or out of reach > each says the server's sentence calmly, in chromium, 1440, light",
    ]);
  });

  test("are cargo's failed tests in the desktop app's log", () => {
    const log = readFileSync(join(FIXTURES, "cargo-desktop.log"), "utf8");
    expect(failingTests(log)).toEqual([
      "windows::tests::a_probe_that_answers_late_is_reported_slow_with_its_duration",
    ]);
  });

  test("are none in a log with no failed test", () => {
    expect(
      failingTests(
        "2026-11-25T04:13:47.5963824Z (pass) Routines on the strip > opened directly [949.74ms]\n",
      ),
    ).toEqual([]);
  });
});

describe("budgets", () => {
  const budgets: Budgets = {
    CI: {
      run: 15,
      jobs: {
        "app (real browser, WebKit)": 6,
        "tests (shard N of N)": 7,
        "component dockerfile (*)": 10,
      },
    },
  };

  test("a job over its budget is named with how long it took", () => {
    const over = overBudget("CI", rerun, 2, budgets);
    expect(over.map((o) => o.job)).toEqual(["app (real browser, WebKit)"]);
    expect(over[0]?.minutes).toBeCloseTo(7.88, 1);
  });

  test("the whole run is held to its budget on a first attempt only", () => {
    const firstAttempt = rerun.filter((job) => job.run_attempt === 1);
    expect(
      overBudget("CI", firstAttempt, 1, {
        CI: { run: 5, jobs: {} },
      }).map((o) => o.job),
    ).toEqual(["(whole run)"]);
    expect(overBudget("CI", rerun, 2, { CI: { run: 5, jobs: {} } })).toEqual(
      [],
    );
  });

  test("every shard shares one budget, and a matrix read at run time shares its wildcard", () => {
    expect(budgetFor(budgets.CI?.jobs ?? {}, "tests (shard 3 of 5)")).toBe(7);
    expect(
      budgetFor(budgets.CI?.jobs ?? {}, "component dockerfile (agent-adk)"),
    ).toBe(10);
  });
});

test("text from a log pings nobody and closes no code span", () => {
  expect(quiet("@octocat said `hi`")).toBe("@​octocat said 'hi'");
});

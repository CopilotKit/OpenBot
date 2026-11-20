/**
 * The decisions the Release workflow makes between its steps: which Create release PR kind a run
 * asks for, whether the release becomes Latest (the same answer release-becomes-latest.sh gives),
 * when a workflow's push run counts as green, and what a chart's appVersion is.
 */
import { expect, test } from "bun:test";
import {
  appVersionOf,
  becomesLatest,
  checksState,
  cutKind,
  heldLatest,
  logFrom,
  serverChecksState,
} from "./release-run";

test("final from main is a stable release, from a release branch the final", () => {
  expect(cutKind("main", "final")).toBe("stable");
  expect(cutKind("release/1.1", "final")).toBe("final");
  expect(cutKind("main", "rc")).toBe("rc");
  expect(cutKind("release/1.1", "rc")).toBe("rc");
});

test("Latest moves only forward, and never to a candidate", () => {
  expect(becomesLatest("1.1.2", false, "v1.1.1")).toBe(true);
  expect(becomesLatest("1.1.1", false, "v1.1.1")).toBe(true);
  // A patch to an older line while a newer release is Latest.
  expect(becomesLatest("1.0.4", false, "v1.1.1")).toBe(false);
  expect(becomesLatest("1.1.2-rc.1", true, "v1.1.1")).toBe(false);
  expect(becomesLatest("0.0.1", false, undefined)).toBe(true);
});

type Run = Parameters<typeof serverChecksState>[0][number];
const run = (over: Partial<Run>): Run => ({
  id: 1,
  html_url: "",
  status: "completed",
  conclusion: "success",
  head_sha: "a".repeat(40),
  event: "push",
  path: ".github/workflows/images.yml",
  head_branch: "main",
  ...over,
});
const other = { path: ".github/workflows/checks.yml", id: 10 };

test("the server images are green only when every workflow on their commit passed", () => {
  expect(serverChecksState([run({}), run(other)])).toBe("passed");
  expect(
    serverChecksState([
      run({}),
      run({ ...other, status: "in_progress", conclusion: null }),
    ]),
  ).toBe("running");
  expect(
    serverChecksState([run({}), run({ ...other, conclusion: "failure" })]),
  ).toBe("failed");
  // A pull request's run says nothing about the commit.
  expect(serverChecksState([run({ event: "pull_request" })])).toBe("none");
  expect(serverChecksState([])).toBe("none");
  // A workflow run again after a failure counts by its newest run.
  expect(
    serverChecksState([run({ conclusion: "failure" }), run({ id: 2 })]),
  ).toBe("passed");
  expect(
    serverChecksState([run({ id: 2, conclusion: "failure" }), run({})]),
  ).toBe("failed");
});

test("a change is merged only once every check on it passed", () => {
  const check = (
    status: string,
    conclusion: string | null,
    name = "verify",
  ) => ({
    name,
    status,
    conclusion,
  });
  expect(checksState([])).toEqual({ state: "none" });
  expect(
    checksState([
      check("completed", "success"),
      check("completed", "skipped", "tests"),
    ]),
  ).toEqual({ state: "passed" });
  expect(
    checksState([
      check("completed", "success"),
      check("in_progress", null, "tests"),
    ]),
  ).toEqual({ state: "running" });
  // A failure is said at once, with its name, without waiting for the rest.
  expect(
    checksState([
      check("in_progress", null),
      check("completed", "failure", "upgrade from v1.1.1"),
    ]),
  ).toEqual({ state: "failed", failed: ["upgrade from v1.1.1"] });
  expect(checksState([check("completed", "cancelled")])).toEqual({
    state: "failed",
    failed: ["verify"],
  });
});

test("RELEASE_HOLD_LATEST lists tags by spaces or commas", () => {
  expect(heldLatest("v1.1.0", "v1.1.0")).toBe(true);
  expect(heldLatest("v1.0.9, v1.1.0", "v1.1.0")).toBe(true);
  expect(heldLatest(" v1.1.0\nv1.2.0 ", "v1.2.0")).toBe(true);
  expect(heldLatest("v1.1.0", "v1.1.1")).toBe(false);
  expect(heldLatest("", "v1.1.1")).toBe(false);
});

test("a chart's appVersion reads quoted or bare", () => {
  expect(
    appVersionOf(
      'apiVersion: v2\nname: openbot\nversion: 0.9.0\nappVersion: "1.1.2"\n',
    ),
  ).toBe("1.1.2");
  expect(
    appVersionOf(
      "name: openbot-agent\nappVersion: 1.1.1-rc.1 # follows the release\n",
    ),
  ).toBe("1.1.1-rc.1");
  expect(appVersionOf("name: openbot\nversion: 0.9.0\n")).toBeUndefined();
});

test("a dry run's preview is read from the job log without its timestamps", () => {
  const log = [
    "2026-11-19T20:00:00.0000000Z ##[group]Run bun scripts/release-prepare.ts",
    "2026-11-19T20:00:01.0000000Z ##[group]Run git --no-pager diff -- package.json CHANGELOG.md",
    '2026-11-19T20:00:01.1000000Z -  "version": "1.1.1",',
    '2026-11-19T20:00:01.1000000Z +  "version": "1.1.2",',
  ].join("\n");
  expect(logFrom(log, "git --no-pager diff")).toBe(
    '##[group]Run git --no-pager diff -- package.json CHANGELOG.md\n-  "version": "1.1.1",\n+  "version": "1.1.2",',
  );
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunStore } from "../src/storage/run-store";

const directories: string[] = [];

async function store() {
  const directory = await mkdtemp(join(tmpdir(), "openbot-recovery-"));
  directories.push(directory);
  return new RunStore(join(directory, "gateway.sqlite"));
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("restart recovery", () => {
  test("fails queued and active rows once without changing terminal rows", async () => {
    const runs = await store();
    for (const runId of ["queued", "preparing", "running", "completed"]) {
      runs.reserveRun({ provider: "codex", runId, threadId: "thread-1" });
    }
    runs.transitionRun("codex", "preparing", "preparing", ["queued"]);
    runs.transitionRun("codex", "running", "preparing", ["queued"]);
    runs.transitionRun("codex", "running", "running", ["preparing"]);
    runs.transitionRun("codex", "completed", "preparing", ["queued"]);
    runs.transitionRun("codex", "completed", "running", ["preparing"]);
    runs.transitionRun("codex", "completed", "completed", ["running"]);
    runs.attachWorkspace("codex", "running", "/jobs/codex/running");

    expect(
      runs.recoverInterrupted("Gateway restarted; submit a new run."),
    ).toBe(3);
    expect(
      runs.recoverInterrupted("Gateway restarted; submit a new run."),
    ).toBe(0);
    expect(runs.getRun("codex", "queued")).toMatchObject({ state: "failed" });
    expect(runs.getRun("codex", "preparing")).toMatchObject({
      state: "failed",
    });
    expect(runs.getRun("codex", "running")).toMatchObject({
      state: "failed",
      workspacePath: "/jobs/codex/running",
      errorSummary: "Gateway restarted; submit a new run.",
    });
    expect(runs.getRun("codex", "completed")).toMatchObject({
      state: "completed",
    });
    runs.close();
  });

  test("uses guarded atomic transitions and retains completed result data", async () => {
    const runs = await store();
    runs.reserveRun({ provider: "grok", runId: "run-1", threadId: "thread-1" });
    expect(() =>
      runs.transitionRun("grok", "run-1", "completed", ["queued"]),
    ).toThrow(/transition/i);
    runs.transitionRun("grok", "run-1", "preparing", ["queued"]);
    runs.transitionRun("grok", "run-1", "running", ["preparing"]);
    runs.saveResult("grok", "run-1", {
      patch: "diff --git a/a b/a",
      baseCommit: "a".repeat(40),
      commits: [{ hash: "b".repeat(40), subject: "change" }],
    });
    runs.transitionRun("grok", "run-1", "completed", ["running"]);

    const reopenedPath = runs.path;
    runs.close();
    const reopened = new RunStore(reopenedPath);
    expect(reopened.getRun("grok", "run-1")).toMatchObject({
      state: "completed",
      patch: "diff --git a/a b/a",
      baseCommit: "a".repeat(40),
      commits: [{ hash: "b".repeat(40), subject: "change" }],
    });
    reopened.close();
  });
});

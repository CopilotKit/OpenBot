import { describe, expect, test } from "bun:test";
import { type Facts, plan, type Run, WAIT_MINUTES } from "./contributor-ci";

const REPO = "CopilotKit/OpenBot";
const NOW = Date.parse("2026-11-20T03:30:00Z");
const minutesAgo = (minutes: number) =>
  new Date(NOW - minutes * 60_000).toISOString();

const run = (overrides: Partial<Run>): Run => ({
  id: 1,
  path: ".github/workflows/ci.yml",
  event: "pull_request",
  status: "in_progress",
  conclusion: null,
  head_sha: "aaa",
  created_at: minutesAgo(1),
  head_repository: { full_name: REPO },
  pull_requests: [{ number: 10 }],
  ...overrides,
});

/** A contributor's run: a pull request from a fork. */
const fork = (overrides: Partial<Run>) =>
  run({ head_repository: { full_name: "someone/OpenBot" }, ...overrides });

const facts = (overrides: Partial<Facts>): Facts => ({
  repository: REPO,
  now: NOW,
  active: [],
  cancelled: [],
  jobsOf: () => [],
  headOf: () => "fff",
  runsAt: () => [],
  ...overrides,
});

describe("contributor CI makes way for CopilotKit's", () => {
  test("a team job waiting over the limit pauses every contributor run", () => {
    const team = run({ id: 2, event: "push", status: "in_progress" });
    const contributor = fork({ id: 3, status: "in_progress" });
    const queuedContributor = fork({ id: 4, status: "queued" });
    const result = plan(
      facts({
        active: [team, contributor, queuedContributor],
        jobsOf: (r) =>
          r.id === 2
            ? [{ status: "queued", created_at: minutesAgo(WAIT_MINUTES + 1) }]
            : [],
      }),
    );
    expect(result.cancel.map((r) => r.id)).toEqual([3, 4]);
    expect(result.rerun).toEqual([]);
  });

  test("a whole team run still queued counts by its queued jobs, a team PR branch's too", () => {
    const result = plan(
      facts({
        active: [
          run({
            id: 2,
            status: "queued",
            created_at: minutesAgo(WAIT_MINUTES + 2),
          }),
          fork({ id: 3 }),
        ],
        jobsOf: (r) =>
          r.id === 2
            ? [{ status: "queued", created_at: minutesAgo(WAIT_MINUTES + 2) }]
            : [],
      }),
    );
    expect(result.cancel.map((r) => r.id)).toEqual([3]);
  });

  // Run 43097645146: Desktop macOS signing on a team branch, `queued` since 11 November with no
  // jobs, which GitHub would not cancel. It paused every fork run every five minutes.
  test("a run stuck in queued for days with no jobs is not the team waiting", () => {
    const ghost = run({
      id: 43097645146,
      path: ".github/workflows/desktop-macos-signing.yml",
      event: "pull_request",
      status: "queued",
      conclusion: null,
      created_at: "2026-11-11T20:42:40Z",
      head_repository: { full_name: REPO },
      pull_requests: [],
    });
    const contributor = fork({ id: 3, status: "in_progress" });
    const result = plan(
      facts({ active: [ghost, contributor], jobsOf: () => [] }),
    );
    expect(result.cancel).toEqual([]);
    // Nor when the API does list a queued job for it: it is days old.
    const stale = plan(
      facts({
        active: [ghost, contributor],
        jobsOf: () => [
          { status: "queued", created_at: "2026-11-11T20:42:41Z" },
        ],
      }),
    );
    expect(stale.cancel).toEqual([]);
  });

  test("a queued team run with no jobs yet pauses nothing", () => {
    const result = plan(
      facts({
        active: [
          run({ id: 2, status: "queued", created_at: minutesAgo(20) }),
          fork({ id: 3 }),
        ],
        jobsOf: () => [],
      }),
    );
    expect(result.cancel).toEqual([]);
  });

  test("a team job that has only just queued pauses nothing", () => {
    const result = plan(
      facts({
        active: [run({ id: 2, event: "push" }), fork({ id: 3 })],
        jobsOf: () => [{ status: "queued", created_at: minutesAgo(1) }],
      }),
    );
    expect(result.cancel).toEqual([]);
  });

  test("a contributor's own waiting run never counts as the team waiting", () => {
    const result = plan(
      facts({
        active: [fork({ id: 3, status: "queued", created_at: minutesAgo(30) })],
      }),
    );
    expect(result.cancel).toEqual([]);
  });
});

describe("contributor CI resumes when the runners are free", () => {
  test("the oldest run cancelled on its pull request's current commit is re-run, one per workflow", () => {
    const result = plan(
      facts({
        cancelled: [
          fork({
            id: 5,
            status: "completed",
            conclusion: "cancelled",
            head_sha: "fff",
            created_at: minutesAgo(10),
            pull_requests: [{ number: 11 }],
          }),
          fork({
            id: 6,
            status: "completed",
            conclusion: "cancelled",
            head_sha: "fff",
            created_at: minutesAgo(40),
            pull_requests: [{ number: 12 }],
          }),
        ],
      }),
    );
    expect(result.rerun.map((r) => r.id)).toEqual([6]);
  });

  test("not while a contributor run of that workflow is active, or a team job waits", () => {
    const cancelled = [
      fork({
        id: 5,
        status: "completed",
        conclusion: "cancelled",
        head_sha: "fff",
      }),
    ];
    expect(
      plan(
        facts({ cancelled, active: [fork({ id: 7, status: "in_progress" })] }),
      ).rerun,
    ).toEqual([]);
    expect(
      plan(
        facts({
          cancelled,
          active: [
            run({ id: 2, status: "queued", created_at: minutesAgo(10) }),
          ],
          jobsOf: () => [{ status: "queued", created_at: minutesAgo(10) }],
        }),
      ).rerun,
    ).toEqual([]);
  });

  test("not a commit the pull request has moved past, or one that ran again since", () => {
    const old = fork({
      id: 5,
      status: "completed",
      conclusion: "cancelled",
      head_sha: "old",
    });
    expect(plan(facts({ cancelled: [old] })).rerun).toEqual([]);
    const current = fork({
      id: 5,
      status: "completed",
      conclusion: "cancelled",
      head_sha: "fff",
    });
    expect(
      plan(
        facts({
          cancelled: [current],
          runsAt: () => [
            current,
            fork({
              id: 8,
              status: "completed",
              conclusion: "success",
              head_sha: "fff",
            }),
          ],
        }),
      ).rerun,
    ).toEqual([]);
  });

  test("not a closed pull request, nor one cancelled over a day ago", () => {
    const cancelled = fork({
      id: 5,
      status: "completed",
      conclusion: "cancelled",
      head_sha: "fff",
    });
    expect(
      plan(facts({ cancelled: [cancelled], headOf: () => undefined })).rerun,
    ).toEqual([]);
    expect(
      plan(
        facts({
          cancelled: [{ ...cancelled, created_at: minutesAgo(25 * 60) }],
        }),
      ).rerun,
    ).toEqual([]);
  });
});

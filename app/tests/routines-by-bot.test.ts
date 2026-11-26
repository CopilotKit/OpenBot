import { describe, expect, test } from "bun:test";
import type { CheckIn } from "../src/lib/api/generated/model/checkIn";
import type { Goal } from "../src/lib/api/generated/model/goal";
import {
  isRunning,
  type RowFact,
  rowFact,
  rowName,
  routinesByBot,
} from "../src/lib/routines/by-bot";
import type { MergedRoutine } from "../src/lib/routines/merged";
import type { RoutineRecord } from "../src/lib/routines/queries";

const routine = (
  id: string,
  overrides: Partial<RoutineRecord> = {},
): RoutineRecord => ({
  id,
  botId: "b1",
  schedule: "Weekdays at 09:00",
  cron: "0 9 * * 1-5",
  timezone: "UTC",
  instruction: "Post the standup summary.",
  title: null,
  conversation: { id: "c1", name: null, title: "Standup", gone: false },
  enabled: true,
  nextRunAt: "2999-01-01T09:00:00.000Z",
  lastRun: null,
  goalId: null,
  createdAt: "2026-10-09T10:00:00Z",
  ...overrides,
});

const goal = (id: string, overrides: Partial<Goal> = {}): Goal => ({
  id,
  botId: "b1",
  conversationId: "c1",
  threadId: "t1",
  title: "Reconcile receipts",
  instruction: "Do it.",
  successCriteria: "The receipts match the bank.",
  status: "active",
  progress: "",
  lastResult: null,
  subscriptions: [],
  recurring: false,
  endsWhenMet: false,
  createdAt: "2026-10-09T10:00:00Z",
  updatedAt: "2026-10-09T10:00:00Z",
  completedAt: null,
  ...overrides,
});

const checkIn = (id: string, overrides: Partial<CheckIn> = {}): CheckIn => ({
  id,
  botId: "b1",
  conversationId: "c1",
  focus: "",
  subject: "inbox",
  sourceLink: null,
  enabled: true,
  intervalMinutes: 1440,
  nextRunAt: "2999-01-01T09:00:00.000Z",
  lastRunAt: null,
  lastStatus: "idle",
  lastError: null,
  lastRun: null,
  createdAt: "2026-10-09T10:00:00Z",
  updatedAt: "2026-10-09T10:00:00Z",
  ...overrides,
});

const routineRow = (
  id: string,
  overrides: Partial<RoutineRecord> = {},
): MergedRoutine => ({
  kind: "routine",
  id,
  agentId: overrides.botId ?? "b1",
  routine: routine(id, overrides),
});

const goalRow = (
  id: string,
  routines: RoutineRecord[] = [],
  overrides: Partial<Goal> = {},
): MergedRoutine => ({
  kind: "goal",
  id,
  agentId: overrides.botId ?? "b1",
  goal: goal(id, overrides),
  routines,
});

const checkInRow = (
  id: string,
  overrides: Partial<CheckIn> = {},
): MergedRoutine => ({
  kind: "check-in",
  id,
  agentId: overrides.botId ?? "b1",
  checkIn: checkIn(id, overrides),
});

const running = { status: null, at: null };
const failed = { status: "failed", at: null };
const skipped = { status: "skipped", at: null };
const succeeded = { status: "succeeded", at: null };

describe("isRunning", () => {
  test("a routine with an open run is running", () => {
    expect(isRunning(routineRow("r", { lastRun: running }))).toBe(true);
  });

  test("a routine that never ran or finished its run is not running", () => {
    expect(isRunning(routineRow("r"))).toBe(false);
    expect(isRunning(routineRow("r", { lastRun: succeeded }))).toBe(false);
  });

  test("a check-in is running when its last status is running", () => {
    expect(isRunning(checkInRow("c", { lastStatus: "running" }))).toBe(true);
    expect(isRunning(checkInRow("c", { lastStatus: "idle" }))).toBe(false);
  });

  test("a goal is running when any routine that runs it is running", () => {
    const open = routine("r1", { goalId: "g", lastRun: running });
    const done = routine("r2", { goalId: "g", lastRun: succeeded });
    expect(isRunning(goalRow("g", [done, open]))).toBe(true);
    expect(isRunning(goalRow("g", [done]))).toBe(false);
    expect(isRunning(goalRow("g"))).toBe(false);
  });
});

describe("rowName", () => {
  test("a routine is named by its title, else by what it does", () => {
    expect(rowName(routineRow("r", { title: "Standup" }))).toBe("Standup");
    expect(rowName(routineRow("r"))).toBe("Post the standup summary.");
    expect(rowName(routineRow("r", { goalId: "g" }))).toBe("Runs a goal");
  });

  test("a goal is named by its title", () => {
    expect(rowName(goalRow("g", [], { title: "Keep the wiki fresh" }))).toBe(
      "Keep the wiki fresh",
    );
  });

  test("a check-in is named by its subject, else by everything it reads", () => {
    expect(rowName(checkInRow("c", { subject: "inbox" }))).toBe("inbox");
    expect(rowName(checkInRow("c", { subject: "" }))).toBe(
      "Everything it reads",
    );
  });
});

describe("rowFact", () => {
  const fact = (row: MergedRoutine, goalStarts: string | null = null) =>
    rowFact(row, goalStarts);
  const said = (text: string, tone: RowFact["tone"]): RowFact => ({
    text,
    tone,
  });

  test("running comes first, over a failure and over paused", () => {
    expect(fact(routineRow("r", { lastRun: running }))).toEqual(
      said("Running now", "running"),
    );
    expect(fact(routineRow("r", { lastRun: running, enabled: false }))).toEqual(
      said("Running now", "running"),
    );
    expect(fact(checkInRow("c", { lastStatus: "running" }))).toEqual(
      said("Running now", "running"),
    );
    expect(
      fact(
        goalRow("g", [routine("r", { goalId: "g", lastRun: running })], {
          status: "paused",
        }),
      ),
    ).toEqual(said("Running now", "running"));
  });

  test("a routine whose last run failed says so, as a warning", () => {
    expect(fact(routineRow("r", { lastRun: failed }))).toEqual(
      said("Failed recently", "warning"),
    );
  });

  test("a routine whose last run was skipped says so, as a warning", () => {
    expect(fact(routineRow("r", { lastRun: skipped }))).toEqual(
      said("Skipped recently", "warning"),
    );
  });

  test("a failed run still shows when the routine is paused", () => {
    expect(fact(routineRow("r", { lastRun: failed, enabled: false }))).toEqual(
      said("Failed recently", "warning"),
    );
  });

  test("a routine whose conversation was deleted says so, as a warning", () => {
    expect(
      fact(
        routineRow("r", {
          conversation: { id: "c1", name: null, title: null, gone: true },
        }),
      ),
    ).toEqual(said("Its conversation was deleted", "warning"));
  });

  test("a failed run comes before a deleted conversation", () => {
    expect(
      fact(
        routineRow("r", {
          lastRun: failed,
          conversation: { id: "c1", name: null, title: null, gone: true },
        }),
      ),
    ).toEqual(said("Failed recently", "warning"));
  });

  test("a check-in that errored says so, as a warning", () => {
    expect(fact(checkInRow("c", { lastStatus: "error" }))).toEqual(
      said("Couldn't check last time", "warning"),
    );
  });

  test("a paused routine or check-in is muted", () => {
    expect(fact(routineRow("r", { enabled: false }))).toEqual(
      said("Paused", "muted"),
    );
    expect(fact(checkInRow("c", { enabled: false }))).toEqual(
      said("Paused", "muted"),
    );
  });

  test("a paused goal is muted, and a completed goal says completed", () => {
    expect(fact(goalRow("g", [], { status: "paused" }))).toEqual(
      said("Paused", "muted"),
    );
    expect(fact(goalRow("g", [], { status: "completed" }))).toEqual(
      said("Completed", "muted"),
    );
  });

  test("a routine that is on says when it starts", () => {
    expect(
      fact(routineRow("r", { lastRun: succeeded, timezone: "UTC" })),
    ).toEqual({
      text: expect.stringContaining("Weekdays at 09:00"),
      tone: "normal",
    });
  });

  test("a goal that is on says when it starts, or nothing", () => {
    expect(fact(goalRow("g"), "Every Monday")).toEqual(
      said("Every Monday", "normal"),
    );
    expect(fact(goalRow("g"), null)).toEqual(said("", "normal"));
  });

  test("a check-in that is on says how often it checks", () => {
    expect(fact(checkInRow("c", { intervalMinutes: 1440 }))).toEqual(
      said("Checks once a day", "normal"),
    );
    expect(fact(checkInRow("c", { intervalMinutes: 90 }))).toEqual(
      said("Checks every 90 minutes", "normal"),
    );
  });
});

describe("routinesByBot", () => {
  const bot = (id: string, name: string) => ({
    id,
    name,
    avatarSeed: `seed-${id}`,
  });
  const ids = (rows: MergedRoutine[]) => rows.map((row) => row.id);

  test("Bots in shown come first in its order, then hidden, then the rest", () => {
    const rows = [
      routineRow("r1", { botId: "stray" }),
      routineRow("r2", { botId: "h1" }),
      routineRow("r3", { botId: "s2" }),
      routineRow("r4", { botId: "s1" }),
    ];
    const groups = routinesByBot(
      rows,
      [bot("s1", "Sam"), bot("s2", "Sky")],
      [bot("h1", "Hal")],
    );
    expect(groups.map((group) => group.botId)).toEqual([
      "s1",
      "s2",
      "h1",
      "stray",
    ]);
    expect(groups.map((group) => group.hidden)).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(groups.map((group) => group.name)).toEqual([
      "Sam",
      "Sky",
      "Hal",
      "A Bot",
    ]);
    expect(groups.map((group) => group.known)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(groups.map((group) => group.seed)).toEqual([
      "seed-s1",
      "seed-s2",
      "seed-h1",
      "stray",
    ]);
  });

  test("a Bot in both lists is one group, in the shown position", () => {
    const rows = [
      routineRow("r1", { botId: "s1" }),
      routineRow("r2", { botId: "h1" }),
    ];
    const groups = routinesByBot(
      rows,
      [bot("s1", "Sam")],
      [bot("h1", "Hal"), bot("s1", "Sam")],
    );
    expect(groups.map((group) => group.botId)).toEqual(["s1", "h1"]);
    expect(groups[0]).toMatchObject({ hidden: false, known: true });
    expect(ids(groups[0]?.rows ?? [])).toEqual(["r1"]);
  });

  test("a Bot with no rows has no group", () => {
    const groups = routinesByBot(
      [routineRow("r1", { botId: "s1" })],
      [bot("s1", "Sam"), bot("s2", "Sky")],
      [bot("h1", "Hal")],
    );
    expect(groups.map((group) => group.botId)).toEqual(["s1"]);
  });

  test("a group holds its Bot's rows only", () => {
    const groups = routinesByBot(
      [
        routineRow("r1", { botId: "s1" }),
        routineRow("r2", { botId: "s2" }),
        checkInRow("c1", { botId: "s1" }),
      ],
      [bot("s1", "Sam"), bot("s2", "Sky")],
      [],
    );
    expect(ids(groups[0].rows)).toEqual(["r1", "c1"]);
    expect(ids(groups[1].rows)).toEqual(["r2"]);
  });

  test("inside a group the five bands run in order", () => {
    const early = "2999-01-01T09:00:00.000Z";
    const mid = "2999-01-02T09:00:00.000Z";
    const late = "2999-01-03T09:00:00.000Z";
    const rows: MergedRoutine[] = [
      routineRow("off", { enabled: false }),
      goalRow("done", [], { status: "completed" }),
      goalRow("no-start"),
      checkInRow("late", { nextRunAt: late }),
      routineRow("failing", { lastRun: failed, nextRunAt: late }),
      goalRow("goal-mid", [
        routine("g-off", {
          goalId: "goal-mid",
          enabled: false,
          nextRunAt: early,
        }),
        routine("g-on", { goalId: "goal-mid", nextRunAt: mid }),
      ]),
      routineRow("early", { nextRunAt: early }),
      checkInRow("running", { lastStatus: "running", nextRunAt: late }),
      checkInRow("paused", { enabled: false, nextRunAt: early }),
    ];
    const [group] = routinesByBot(rows, [bot("b1", "Bo")], []);
    expect(ids(group.rows)).toEqual([
      "running",
      "failing",
      "early",
      "goal-mid",
      "late",
      "no-start",
      "off",
      "done",
      "paused",
    ]);
  });

  test("a goal whose routines are all off has no start", () => {
    const rows: MergedRoutine[] = [
      goalRow("g-off", [routine("r", { goalId: "g-off", enabled: false })]),
      routineRow("r-on"),
    ];
    const [group] = routinesByBot(rows, [bot("b1", "Bo")], []);
    expect(ids(group.rows)).toEqual(["r-on", "g-off"]);
  });

  test("ties keep the input order", () => {
    const rows: MergedRoutine[] = [
      routineRow("a"),
      checkInRow("b"),
      routineRow("c"),
      routineRow("d", { enabled: false }),
      routineRow("e", { enabled: false }),
    ];
    const [group] = routinesByBot(rows, [bot("b1", "Bo")], []);
    expect(ids(group.rows)).toEqual(["a", "b", "c", "d", "e"]);
  });
});

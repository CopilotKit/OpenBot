import { expect, test } from "bun:test";
import { routinesSummary } from "@/components/bot-profile/activity";
import type { ActivityItem, BotActivity } from "@/lib/bot-lifecycle/queries";

const item = (id: string, kind: ActivityItem["kind"]): ActivityItem => ({
  id,
  kind,
  title: id,
  detail: null,
  status: "scheduled",
  at: "2999-01-01T09:00:00.000Z",
  channelId: null,
  needsYou: false,
  stoppable: false,
  cancellable: false,
});

/** A goal, the daily routine that runs it, and a routine of its own, all lined up. */
const activity: BotActivity = {
  inProgress: [],
  scheduled: [
    item("responsibility:goal-1", "responsibility"),
    item("routine:runs-goal", "routine"),
    item("routine:standalone", "routine"),
    item("follow_up:later", "follow_up"),
  ],
  onDemand: [item("responsibility:goal-2", "responsibility")],
  completed: [],
};

test("a routine that runs a goal is counted once, with its goal, as the Routines page lists it", () => {
  expect(
    routinesSummary(activity, {
      goalRoutineIds: new Set(["runs-goal"]),
      checkIns: 0,
    }),
  ).toBe("2 scheduled · 1 on demand");
});

test("check-ins that are on are counted with the routines", () => {
  expect(
    routinesSummary(activity, {
      goalRoutineIds: new Set(["runs-goal"]),
      checkIns: 1,
    }),
  ).toBe("3 scheduled · 1 on demand");
});

test("a Bot with only a check-in has a routine lined up", () => {
  expect(
    routinesSummary(
      { inProgress: [], scheduled: [], onDemand: [], completed: [] },
      { goalRoutineIds: new Set(), checkIns: 1 },
    ),
  ).toBe("1 scheduled");
});

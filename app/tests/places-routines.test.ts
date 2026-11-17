import { expect, test } from "bun:test";
import { groupRoutinesByBot } from "@/lib/places/routine-groups";
import type { MergedRoutine } from "@/lib/routines/merged";

function routine(id: string, agentId: string, enabled: boolean): MergedRoutine {
  return {
    kind: "routine",
    id,
    agentId,
    routine: { enabled },
  } as unknown as MergedRoutine;
}

function goal(id: string, agentId: string, status: string): MergedRoutine {
  return {
    kind: "goal",
    id,
    agentId,
    goal: { status },
    routines: [],
  } as unknown as MergedRoutine;
}

function checkIn(id: string, agentId: string, enabled: boolean): MergedRoutine {
  return {
    kind: "check-in",
    id,
    agentId,
    checkIn: { enabled },
  } as unknown as MergedRoutine;
}

const names: Record<string, string> = {
  a: "Ada",
  b: "Bea",
  c: "Cleo",
};
const nameOf = (agentId: string) => names[agentId] ?? agentId;

test("each Bot's routines are one group, in the order they were given", () => {
  const rows = [
    routine("r1", "b", true),
    goal("g1", "a", "active"),
    checkIn("c1", "b", true),
    routine("r2", "a", true),
  ];
  const groups = groupRoutinesByBot(rows, nameOf);
  expect(groups.map((group) => group.agentId)).toEqual(["a", "b"]);
  expect(groups[0]?.rows.map((row) => row.id)).toEqual(["g1", "r2"]);
  expect(groups[1]?.rows.map((row) => row.id)).toEqual(["r1", "c1"]);
});

test("a Bot with a routine that is on comes before a Bot whose routines are all off", () => {
  const rows = [
    routine("r1", "a", false),
    goal("g1", "a", "paused"),
    checkIn("c1", "b", false),
    goal("g2", "b", "active"),
    routine("r2", "c", false),
  ];
  const groups = groupRoutinesByBot(rows, nameOf);
  expect(groups.map((group) => group.agentId)).toEqual(["b", "a", "c"]);
});

test("Bots with the same standing are in name order", () => {
  const rows = [
    routine("r1", "c", true),
    routine("r2", "a", true),
    routine("r3", "b", true),
  ];
  const groups = groupRoutinesByBot(rows, nameOf);
  expect(groups.map((group) => group.agentId)).toEqual(["a", "b", "c"]);
});

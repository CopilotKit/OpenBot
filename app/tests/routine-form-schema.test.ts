import { expect, test } from "bun:test";
import { ROUTINE_FORM_DEFAULTS, routineFormSchema } from "@/lib/routines/form";

const base = {
  ...ROUTINE_FORM_DEFAULTS,
  agentId: "bot-1",
  channelId: "c1",
  instruction: "Send it",
};

function issues(values: object) {
  const result = routineFormSchema.safeParse({ ...base, ...values });
  return result.success
    ? []
    : result.error.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
      }));
}

test("a schedule ignores a long event", () => {
  expect(issues({ starts: "schedule", eventType: "a".repeat(129) })).toEqual(
    [],
  );
});

test("an event over 128 characters fails once, at the event", () => {
  expect(issues({ starts: "event", eventType: "a".repeat(129) })).toEqual([
    { path: ["eventType"], message: "Keep the event under 128 characters." },
  ]);
});

test("an event needs a name", () => {
  expect(issues({ starts: "event", eventType: "" })).toEqual([
    { path: ["eventType"], message: "Say which event starts it." },
  ]);
});

test("a cleared time fails a daily schedule only", () => {
  expect(issues({ repeat: "daily", time: "" })).toEqual([
    { path: ["time"], message: "Choose a time." },
  ]);
  expect(issues({ repeat: "hourly", time: "" })).toEqual([]);
  expect(issues({ starts: "now", time: "" })).toEqual([]);
});

test("only telling ignores what it does not draw", () => {
  expect(
    issues({
      does: "tell",
      doneWhen: "a".repeat(3001),
      starts: "event",
      eventType: "",
    }),
  ).toEqual([]);
});

test("only telling caps the instruction at 1000 characters", () => {
  const instruction = "a".repeat(1001);
  expect(issues({ does: "tell", instruction })).toEqual([
    {
      path: ["instruction"],
      message: "Keep it under 1000 characters when it only tells you.",
    },
  ]);
  expect(issues({ does: "act", instruction })).toEqual([]);
});

const ROUTINE_MESSAGE = "Keep it to 2000 characters or fewer.";
const GOAL_MESSAGE = "Keep it to 6000 characters or fewer.";

test("a routine's instruction is capped at 2000 characters, counted in code points", () => {
  // The schedule with no Done when makes a routine; the server counts code points.
  expect(issues({ instruction: "a".repeat(2000) })).toEqual([]);
  expect(issues({ instruction: "a".repeat(2001) })).toEqual([
    { path: ["instruction"], message: ROUTINE_MESSAGE },
  ]);
  // 2000 emoji are 4000 UTF-16 units and still one short of the limit.
  expect(issues({ instruction: "😀".repeat(2000) })).toEqual([]);
  expect(issues({ instruction: "😀".repeat(2001) })).toEqual([
    { path: ["instruction"], message: ROUTINE_MESSAGE },
  ]);
  // Spaces around it are trimmed away, as the server does.
  expect(issues({ instruction: ` ${"a".repeat(2000)} ` })).toEqual([]);
});

test("a goal's instruction is capped at 6000 characters in every goal case", () => {
  const goals = [
    { starts: "schedule", doneWhen: "It is sent." },
    { starts: "event", eventType: "push", doneWhen: "" },
    { starts: "event", eventType: "push", doneWhen: "It is sent." },
    { starts: "now", doneWhen: "" },
    { starts: "now", doneWhen: "It is sent." },
  ];
  for (const goal of goals) {
    expect(issues({ ...goal, instruction: "a".repeat(6000) })).toEqual([]);
    expect(issues({ ...goal, instruction: "a".repeat(6001) })).toEqual([
      { path: ["instruction"], message: GOAL_MESSAGE },
    ]);
  }
});

test("a routine's cap does not apply to a goal, and a goal's does not apply to telling", () => {
  expect(issues({ starts: "now", instruction: "a".repeat(2001) })).toEqual([]);
  expect(issues({ does: "tell", instruction: "a".repeat(1001) })).toEqual([
    {
      path: ["instruction"],
      message: "Keep it under 1000 characters when it only tells you.",
    },
  ]);
});

import { describe, expect, test } from "bun:test";
import {
  cronFrom,
  NEW_CONVERSATION,
  ROUTINE_FORM_DEFAULTS,
} from "../src/lib/routines/form";
import { planRoutine, runGoalInstruction } from "../src/lib/routines/plan";

const base = {
  ...ROUTINE_FORM_DEFAULTS,
  agentId: "bot",
  channelId: "c1",
  instruction: "Send the numbers",
  title: "",
};

describe("planRoutine", () => {
  test("the base schedule is weekdays at nine", () => {
    expect(cronFrom(base)).toBe("0 9 * * 1-5");
  });

  test("act, schedule, no outcome: a routine", () => {
    expect(planRoutine(base, "UTC")).toEqual({
      kind: "routine",
      routine: {
        agentId: "bot",
        channelId: "c1",
        instruction: "Send the numbers",
        cron: "0 9 * * 1-5",
        timezone: "UTC",
      },
    });
  });

  test("act, schedule, an outcome: a goal that ends when met, with a schedule", () => {
    const plan = planRoutine({ ...base, doneWhen: "The release ships" }, "UTC");
    if (plan.kind !== "goal") throw new Error("expected a goal");
    expect(plan.goal.title).toBe("Send the numbers");
    expect(plan.goal.successCriteria).toBe("The release ships");
    expect(plan.goal.endsWhenMet).toBe(true);
    expect(plan.goal.recurring).toBe(false);
    expect(plan.goal.subscriptions).toEqual([]);
    expect(plan.schedule).toEqual({ cron: "0 9 * * 1-5", timezone: "UTC" });
    expect(plan.runNow).toBe(false);
  });

  test("act, event, no outcome: a recurring goal", () => {
    const plan = planRoutine(
      { ...base, starts: "event", eventType: "issues.opened" },
      "UTC",
    );
    if (plan.kind !== "goal") throw new Error("expected a goal");
    expect(plan.goal.recurring).toBe(true);
    expect(plan.goal.endsWhenMet).toBe(false);
    expect(plan.goal.successCriteria).toBe("");
    expect(plan.goal.subscriptions).toEqual([
      { source: "github", eventType: "issues.opened" },
    ]);
    expect(plan.schedule).toBeNull();
    expect(plan.runNow).toBe(false);
  });

  test("act, event, an outcome: ends when met", () => {
    const plan = planRoutine(
      {
        ...base,
        starts: "event",
        eventType: "issues.opened",
        doneWhen: "Triaged",
      },
      "UTC",
    );
    if (plan.kind !== "goal") throw new Error("expected a goal");
    expect(plan.goal.recurring).toBe(false);
    expect(plan.goal.endsWhenMet).toBe(true);
    expect(plan.goal.successCriteria).toBe("Triaged");
    expect(plan.goal.subscriptions).toHaveLength(1);
    expect(plan.schedule).toBeNull();
  });

  test("act, now: a goal run at once", () => {
    const plan = planRoutine({ ...base, starts: "now" }, "UTC");
    if (plan.kind !== "goal") throw new Error("expected a goal");
    expect(plan.runNow).toBe(true);
    expect(plan.schedule).toBeNull();
    expect(plan.goal.recurring).toBe(false);
    expect(plan.goal.endsWhenMet).toBe(false);
    expect(plan.goal.subscriptions).toEqual([]);
    expect(plan.goal.successCriteria).toBe("");
    const withOutcome = planRoutine(
      { ...base, starts: "now", doneWhen: "Done" },
      "UTC",
    );
    if (withOutcome.kind !== "goal") throw new Error("expected a goal");
    expect(withOutcome.goal.successCriteria).toBe("Done");
  });

  // A Now goal with a Done when that later gains a schedule or a trigger must still end when met.
  // It went in with endsWhenMet false, so the server read it as repeating and no run could end it.
  test("act, now, an outcome: ends when met", () => {
    const plan = planRoutine(
      { ...base, starts: "now", doneWhen: "The report is sent" },
      "UTC",
    );
    if (plan.kind !== "goal") throw new Error("expected a goal");
    expect(plan.runNow).toBe(true);
    expect(plan.goal.recurring).toBe(false);
    expect(plan.goal.endsWhenMet).toBe(true);
    expect(plan.goal.successCriteria).toBe("The report is sent");
  });

  test("tell: a check-in", () => {
    expect(
      planRoutine(
        { ...base, does: "tell", interval: "240", title: "Launch brief" },
        "UTC",
      ),
    ).toEqual({
      kind: "check-in",
      checkIn: {
        agentId: "bot",
        channelId: "c1",
        focus: "Send the numbers",
        subject: "Launch brief",
        intervalMinutes: 240,
      },
    });
  });

  test("tell ignores a stale event and outcome", () => {
    expect(
      planRoutine(
        {
          ...base,
          does: "tell",
          starts: "event",
          eventType: "x",
          doneWhen: "y",
        },
        "UTC",
      ),
    ).toEqual({
      kind: "check-in",
      checkIn: {
        agentId: "bot",
        channelId: "c1",
        focus: "Send the numbers",
        subject: "Send the numbers",
        intervalMinutes: 1440,
      },
    });
  });

  test("an unnamed check-in is called by its instruction, on one line, within 120 UTF-16 units", () => {
    // A Bot's default check-in has no subject, and the server counts the same subject as the same one.
    const plan = planRoutine(
      { ...base, does: "tell", instruction: `  Watch\n${"😀".repeat(70)}` },
      "UTC",
    );
    if (plan.kind !== "check-in") throw new Error("Expected a check-in.");
    expect(plan.checkIn.subject).toBe(`Watch ${"😀".repeat(57)}`);
    expect(plan.checkIn.subject.length).toBeLessThanOrEqual(120);
  });

  test("a schedule ignores a stale event type", () => {
    const plan = planRoutine(
      { ...base, starts: "schedule", eventType: "x" },
      "UTC",
    );
    expect(plan.kind).toBe("routine");
    expect(JSON.stringify(plan)).not.toContain("subscriptions");
  });

  test("a goal's title is the name, else the instruction cut to 160 characters", () => {
    const long = "é".repeat(200);
    const plan = planRoutine(
      { ...base, instruction: long, doneWhen: "x" },
      "UTC",
    );
    if (plan.kind !== "goal") throw new Error("expected a goal");
    expect(Array.from(plan.goal.title)).toHaveLength(160);
    const named = planRoutine(
      { ...base, instruction: long, title: "  Weekly  ", doneWhen: "x" },
      "UTC",
    );
    if (named.kind !== "goal") throw new Error("expected a goal");
    expect(named.goal.title).toBe("Weekly");
  });

  test("an unnamed goal's title stays within 160 UTF-16 units", () => {
    const plan = planRoutine(
      { ...base, instruction: "😀".repeat(200), doneWhen: "x" },
      "UTC",
    );
    if (plan.kind !== "goal") throw new Error("expected a goal");
    expect(plan.goal.title.length).toBeLessThanOrEqual(160);
    expect(plan.goal.title).toBe("😀".repeat(80));
  });

  test("an unnamed goal's title is the instruction on one line", () => {
    const plan = planRoutine(
      {
        ...base,
        instruction: "Send the numbers\n\nand the chart",
        doneWhen: "x",
      },
      "UTC",
    );
    if (plan.kind !== "goal") throw new Error("expected a goal");
    expect(plan.goal.title).toBe("Send the numbers and the chart");
    expect(plan.goal.instruction).toBe("Send the numbers\n\nand the chart");
  });

  test("collapsing happens before the 160-unit cut, which stays whole", () => {
    const spaced = planRoutine(
      { ...base, instruction: `${"a\n\n\n".repeat(100)}`, doneWhen: "x" },
      "UTC",
    );
    if (spaced.kind !== "goal") throw new Error("expected a goal");
    expect(spaced.goal.title).not.toMatch(/\s\s|\n/);
    expect(spaced.goal.title.length).toBe(159);
    const emoji = planRoutine(
      { ...base, instruction: "😀\n".repeat(200), doneWhen: "x" },
      "UTC",
    );
    if (emoji.kind !== "goal") throw new Error("expected a goal");
    expect(emoji.goal.title.length).toBeLessThanOrEqual(160);
    expect(emoji.goal.title).toBe(`${"😀 ".repeat(52)}😀`);
  });

  test("the event type is trimmed", () => {
    const plan = planRoutine(
      { ...base, starts: "event", eventType: "  issues.opened  " },
      "UTC",
    );
    if (plan.kind !== "goal") throw new Error("expected a goal");
    expect(plan.goal.subscriptions).toEqual([
      { source: "github", eventType: "issues.opened" },
    ]);
  });

  test("a new conversation passes through into a routine and a check-in", () => {
    const routine = planRoutine(
      { ...base, channelId: NEW_CONVERSATION },
      "UTC",
    );
    if (routine.kind !== "routine") throw new Error("expected a routine");
    expect(routine.routine.channelId).toBe(NEW_CONVERSATION);
    const checkIn = planRoutine(
      { ...base, does: "tell", channelId: NEW_CONVERSATION },
      "UTC",
    );
    if (checkIn.kind !== "check-in") throw new Error("expected a check-in");
    expect(checkIn.checkIn.channelId).toBe(NEW_CONVERSATION);
  });

  test("answers are trimmed", () => {
    const plan = planRoutine(
      { ...base, instruction: "  Send  ", doneWhen: "  done  " },
      "UTC",
    );
    if (plan.kind !== "goal") throw new Error("expected a goal");
    expect(plan.goal.instruction).toBe("Send");
    expect(plan.goal.successCriteria).toBe("done");
  });
});

describe("runGoalInstruction", () => {
  test("the routine that runs a goal names it by id", () => {
    expect(runGoalInstruction("Ship it", "g1")).toBe(
      'Run the goal "Ship it" (g1) with run_goal.',
    );
  });
});

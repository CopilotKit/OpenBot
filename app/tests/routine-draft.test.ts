import { describe, expect, test } from "bun:test";
import type { RoutineDraft } from "../src/lib/api/generated/model";
import { draftValues } from "../src/lib/routines/draft";
import {
  NEW_CONVERSATION,
  ROUTINE_FORM_DEFAULTS,
} from "../src/lib/routines/form";

const ready: RoutineDraft = {
  does: "act",
  instruction: "Send the numbers",
  title: "Numbers",
  starts: "schedule",
  cron: "0 9 * * 1-5",
  timezone: "UTC",
  doneWhen: "",
  conversationId: null,
  intervalMinutes: null,
};

describe("draftValues", () => {
  test("a ready draft fills New routine's answers", () => {
    expect(draftValues(ready, "bot")).toEqual({
      ...ROUTINE_FORM_DEFAULTS,
      agentId: "bot",
      channelId: NEW_CONVERSATION,
      instruction: "Send the numbers",
      title: "Numbers",
      repeat: "weekdays",
      time: "09:00",
      starts: "schedule",
    });
  });

  test("a conversation in the draft is kept", () => {
    expect(
      draftValues({ ...ready, conversationId: "c1" }, "bot").channelId,
    ).toBe("c1");
  });

  test("a schedule the picker cannot say keeps the defaults", () => {
    const values = draftValues({ ...ready, cron: "0 9 * * 2/2" }, "bot");
    expect(values.repeat).toBe(ROUTINE_FORM_DEFAULTS.repeat);
    expect(values.time).toBe(ROUTINE_FORM_DEFAULTS.time);
  });

  test("a start the sentence does not give becomes a schedule", () => {
    expect(
      draftValues({ ...ready, starts: "unsaid", cron: null }, "bot").starts,
    ).toBe("schedule");
  });

  test("an event stays an event", () => {
    expect(
      draftValues({ ...ready, starts: "event", cron: null }, "bot").starts,
    ).toBe("event");
  });

  test("a check-in's interval is written as the form holds it", () => {
    const values = draftValues(
      { ...ready, does: "tell", cron: null, intervalMinutes: 240 },
      "bot",
    );
    expect(values.does).toBe("tell");
    expect(values.interval).toBe("240");
  });

  test("no interval keeps the default", () => {
    expect(draftValues(ready, "bot").interval).toBe(
      ROUTINE_FORM_DEFAULTS.interval,
    );
  });
});

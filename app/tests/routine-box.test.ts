import { describe, expect, test } from "bun:test";
import type {
  CheckIn,
  RoutineDraft,
  RoutineReading,
} from "../src/lib/api/generated/model";
import { ClientError } from "../src/lib/client";
import {
  describeDraftWhen,
  lineForMade,
  lineForReading,
  lineForWriteError,
} from "../src/lib/routines/box";
import { draftValues } from "../src/lib/routines/draft";
import { SavedButRefused } from "../src/lib/routines/mutations";

const draft: RoutineDraft = {
  does: "act",
  instruction: "Send the numbers",
  title: "Weekly numbers",
  starts: "schedule",
  cron: "0 9 * * 1-5",
  timezone: "Europe/Amsterdam",
  doneWhen: "",
  conversationId: null,
  intervalMinutes: null,
};

const tellDraft: RoutineDraft = {
  ...draft,
  does: "tell",
  title: "Inbox",
  starts: "unsaid",
  cron: null,
  intervalMinutes: 240,
};

const ctx = {
  botId: "b1",
  botName: "Ada",
  allowed: true,
  checkIns: undefined as CheckIn[] | undefined,
};

const needsMore = (missing: string, from = draft): RoutineReading => ({
  outcome: "needsMore",
  draft: from,
  missing,
});

describe("describeDraftWhen", () => {
  test("a check-in says how often it looks", () => {
    expect(describeDraftWhen(tellDraft)).toBe("Checks every 4 hours");
  });

  test("a check-in with no interval looks daily", () => {
    expect(describeDraftWhen({ ...tellDraft, intervalMinutes: null })).toBe(
      "Checks once a day",
    );
  });

  test("a schedule the form can say is said as the form says it", () => {
    expect(describeDraftWhen(draft)).toBe("Every weekday at 9:00 AM");
  });

  test("a schedule the form cannot say is the cron", () => {
    expect(describeDraftWhen({ ...draft, cron: "*/5 * * * *" })).toBe(
      "*/5 * * * *",
    );
  });

  test("no schedule says nothing", () => {
    expect(describeDraftWhen({ ...draft, starts: "now", cron: null })).toBe("");
  });
});

describe("lineForReading", () => {
  test("notRoutine: use the form with no draft", () => {
    expect(lineForReading({ outcome: "notRoutine" }, ctx)).toEqual({
      kind: "useForm",
      botId: "b1",
      text: "Couldn't read that as a routine.",
      draft: null,
    });
  });

  test("refused: the reading's detail and its fix", () => {
    expect(
      lineForReading(
        {
          outcome: "refused",
          detail: "Gmail isn't connected.",
          fix: "connectApp",
        },
        ctx,
      ),
    ).toEqual({
      kind: "refused",
      botId: "b1",
      text: "Gmail isn't connected.",
      fix: "connectApp",
    });
  });

  test("refused: an unknown fix becomes null", () => {
    expect(
      lineForReading(
        { outcome: "refused", detail: "No.", fix: "somethingNew" },
        ctx,
      ),
    ).toEqual({ kind: "refused", botId: "b1", text: "No.", fix: null });
  });

  test("refused: no fix is null", () => {
    expect(
      lineForReading({ outcome: "refused", detail: "No.", fix: null }, ctx),
    ).toEqual({ kind: "refused", botId: "b1", text: "No.", fix: null });
  });

  test("needsMore, time", () => {
    expect(lineForReading(needsMore("time"), ctx)).toEqual({
      kind: "finish",
      botId: "b1",
      text: "Ada needs to know when for “Weekly numbers”",
      draft,
    });
  });

  test("needsMore, event", () => {
    expect(lineForReading(needsMore("event"), ctx)).toEqual({
      kind: "finish",
      botId: "b1",
      text: "Ada needs to know which event starts “Weekly numbers”",
      draft,
    });
  });

  test("needsMore, once", () => {
    expect(lineForReading(needsMore("once"), ctx)).toEqual({
      kind: "finish",
      botId: "b1",
      text: "“Weekly numbers” is something to do once, now. Finish it on the form.",
      draft,
    });
  });

  test("needsMore, an unknown missing: use the form with the draft", () => {
    expect(lineForReading(needsMore("somethingNew"), ctx)).toEqual({
      kind: "useForm",
      botId: "b1",
      text: "Couldn't read that as a routine.",
      draft,
    });
  });

  test("ready, no rule broken: write, with the draft's cron and timezone", () => {
    expect(lineForReading({ outcome: "ready", draft }, ctx)).toEqual({
      kind: "write",
      values: draftValues(draft, "b1"),
      cron: "0 9 * * 1-5",
      timezone: "Europe/Amsterdam",
    });
  });

  test("ready, a check-in while check-ins are off: refused, nothing to fix", () => {
    expect(
      lineForReading(
        { outcome: "ready", draft: tellDraft },
        { ...ctx, allowed: false },
      ),
    ).toEqual({
      kind: "refused",
      botId: "b1",
      text: "Your admin turned check-ins off, so Ada can only act for you.",
      fix: null,
    });
  });

  test("ready, a check-in the Bot already has: refused, naming the subject", () => {
    const existing: CheckIn = {
      id: "ci1",
      botId: "b1",
      conversationId: "c1",
      focus: "",
      subject: "inbox",
      sourceLink: null,
      enabled: true,
      intervalMinutes: 1440,
      nextRunAt: "2026-11-27T09:00:00.000Z",
      lastRunAt: null,
    } as CheckIn;
    expect(
      lineForReading(
        { outcome: "ready", draft: tellDraft },
        { ...ctx, checkIns: [existing] },
      ),
    ).toEqual({
      kind: "refused",
      botId: "b1",
      text: "Ada already checks in on “Inbox”.",
      fix: null,
    });
  });

  test("ready, a check-in with no title names its instruction", () => {
    const untitled = {
      ...tellDraft,
      title: "",
      instruction: "Look at the inbox",
    };
    const existing = {
      id: "ci1",
      botId: "b1",
      conversationId: "c1",
      focus: "",
      subject: "look at the inbox",
      sourceLink: null,
      enabled: true,
      intervalMinutes: 1440,
      nextRunAt: "2026-11-27T09:00:00.000Z",
      lastRunAt: null,
    } as CheckIn;
    expect(
      lineForReading(
        { outcome: "ready", draft: untitled },
        { ...ctx, checkIns: [existing] },
      ),
    ).toMatchObject({
      kind: "refused",
      text: "Ada already checks in on “Look at the inbox”.",
    });
  });

  test("ready, any other broken rule: use the form with the draft and its message", () => {
    const empty = { ...draft, instruction: "   " };
    const line = lineForReading({ outcome: "ready", draft: empty }, ctx);
    expect(line).toMatchObject({ kind: "useForm", botId: "b1", draft: empty });
    if (line.kind !== "useForm") throw new Error("expected useForm");
    expect(line.text.length).toBeGreaterThan(0);
  });
});

describe("lineForMade", () => {
  test("says who took what, and when", () => {
    const made = { kind: "routine", id: "r1" } as const;
    expect(lineForMade(made, draft, "b1", "Ada")).toEqual({
      kind: "made",
      botId: "b1",
      text: "Ada took “Weekly numbers” · Every weekday at 9:00 AM",
      open: made,
    });
  });
});

describe("lineForWriteError", () => {
  test("a write that may have landed: maybeMade", () => {
    expect(lineForWriteError(new SavedButRefused("maybe"), "b1")).toEqual({
      kind: "maybeMade",
      botId: "b1",
      text: "It may have been made. Check the list before sending it again.",
    });
  });

  test("any other error says its message", () => {
    expect(lineForWriteError(new Error("Name is taken."), "b1")).toEqual({
      kind: "refused",
      botId: "b1",
      text: "Name is taken.",
      fix: null,
    });
  });

  test("an error with no message says the fallback", () => {
    expect(lineForWriteError(new Error(""), "b1")).toEqual({
      kind: "refused",
      botId: "b1",
      text: "Couldn't set up that routine. Try again.",
      fix: null,
    });
  });

  test("a held 503 says the server's sentence", () => {
    const said = "OpenBot is moving this organization. Try again in a moment.";
    const held = new ClientError(said, 503, undefined, { error: said }, 1000);
    expect(lineForWriteError(held, "b1")).toMatchObject({
      kind: "refused",
      text: "OpenBot is moving this organization. Try again in a moment.",
    });
  });
});

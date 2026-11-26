import { describe, expect, test } from "bun:test";
import type {
  CheckIn,
  RoutineDraft,
  RoutineReading,
} from "../src/lib/api/generated/model";
import { ClientError } from "../src/lib/client";
import {
  lineForMade,
  lineForReadError,
  lineForReading,
  lineForRoutingRefusal,
  lineForUndo,
  lineForWriteError,
} from "../src/lib/routines/box";
import { draftValues } from "../src/lib/routines/draft";
import {
  type MadeRoutine,
  SavedButRefused,
} from "../src/lib/routines/mutations";

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

describe("lineForReading", () => {
  test("notRoutine: unread, with no draft and no action", () => {
    expect(lineForReading({ outcome: "notRoutine" }, ctx)).toEqual({
      kind: "unread",
      botId: "b1",
      text: "Couldn't read that as a routine.",
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

  test("needsMore, an unknown missing: unread", () => {
    expect(lineForReading(needsMore("somethingNew"), ctx)).toEqual({
      kind: "unread",
      botId: "b1",
      text: "Couldn't read that as a routine.",
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

  test("ready, any other broken rule: finish, with the draft and the rule's message", () => {
    const empty = { ...draft, instruction: "   " };
    const line = lineForReading({ outcome: "ready", draft: empty }, ctx);
    expect(line).toMatchObject({ kind: "finish", botId: "b1", draft: empty });
    if (line.kind !== "finish") throw new Error("expected finish");
    expect(line.text.length).toBeGreaterThan(0);
  });
});

describe("lineForMade", () => {
  test("says who took what, and when, in the row's words", () => {
    const made: MadeRoutine = {
      kind: "routine",
      id: "r1",
      when: "Weekdays at 09:00",
      startedConversationId: null,
    };
    expect(lineForMade(made, draft, "b1", "Ada")).toEqual({
      kind: "made",
      botId: "b1",
      text: "Ada took “Weekly numbers” · Weekdays at 09:00",
      open: made,
    });
  });

  test("a check-in says how often it looks", () => {
    const made: MadeRoutine = {
      kind: "check-in",
      id: "ci1",
      when: "Checks every 4 hours",
      startedConversationId: null,
    };
    expect(lineForMade(made, tellDraft, "b1", "Ada")).toMatchObject({
      text: "Ada took “Inbox” · Checks every 4 hours",
    });
  });

  test("a goal that nothing starts says no when, and no dot", () => {
    const made: MadeRoutine = {
      kind: "goal",
      id: "g1",
      when: "",
      routineId: null,
      startedConversationId: null,
    };
    expect(lineForMade(made, draft, "b1", "Ada")).toMatchObject({
      text: "Ada took “Weekly numbers”",
    });
  });
});

describe("lineForReadError", () => {
  test("a failed read says the error's sentence, with no action", () => {
    expect(lineForReadError(new Error("Model is down."), "b1")).toEqual({
      kind: "unread",
      botId: "b1",
      text: "Model is down.",
    });
  });

  test("an error with no message says the fallback", () => {
    expect(lineForReadError(new Error(""), "b1")).toEqual({
      kind: "unread",
      botId: "b1",
      text: "Couldn't read that. Try again.",
    });
  });

  test("a held 503 says the server's sentence", () => {
    const said = "OpenBot is moving this organization. Try again in a moment.";
    const held = new ClientError(said, 503, undefined, { error: said }, 1000);
    expect(lineForReadError(held, "b1")).toMatchObject({
      kind: "unread",
      text: said,
    });
  });
});

describe("lineForUndo", () => {
  test("says Removed.", () => {
    expect(lineForUndo("b1")).toEqual({
      kind: "removed",
      botId: "b1",
      text: "Removed.",
    });
  });
});

describe("lineForRoutingRefusal", () => {
  test("is a refusal with the message and nothing to fix", () => {
    expect(
      lineForRoutingRefusal("Two Bots are called Ada. Pick one.", "b1"),
    ).toEqual({
      kind: "refused",
      botId: "b1",
      text: "Two Bots are called Ada. Pick one.",
      fix: null,
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

import { describe, expect, test } from "bun:test";
import type { CheckIn } from "../src/lib/api/generated/model/checkIn";
import {
  NEW_CONVERSATION,
  ROUTINE_FORM_DEFAULTS,
} from "../src/lib/routines/form";
import {
  brokenRules,
  SAME_CHECK_IN,
  TELL_OFF,
} from "../src/lib/routines/rules";

const base = {
  ...ROUTINE_FORM_DEFAULTS,
  agentId: "a1",
  channelId: NEW_CONVERSATION,
  instruction: "Look at the inbox",
};

const inboxCheckIn: CheckIn = {
  id: "ci1",
  botId: "a1",
  conversationId: "c1",
  focus: "",
  subject: "inbox",
  sourceLink: null,
  enabled: true,
  intervalMinutes: 1440,
  nextRunAt: "2026-11-27T09:00:00.000Z",
  lastRunAt: null,
  lastStatus: "",
  lastError: null,
  lastRun: null,
  createdAt: "2026-11-26T09:00:00.000Z",
  updatedAt: "2026-11-26T09:00:00.000Z",
};

describe("brokenRules", () => {
  test("only tell you while an admin has check-ins off breaks Does", () => {
    expect(brokenRules({ ...base, does: "tell" }, false, [])).toEqual({
      does: TELL_OFF,
    });
  });

  test("only tell you that lands on a check-in the Bot already has breaks Name", () => {
    expect(
      brokenRules({ ...base, does: "tell", title: "Inbox" }, true, [
        inboxCheckIn,
      ]),
    ).toEqual({ title: SAME_CHECK_IN });
  });

  test("valid act-on-a-schedule answers break nothing", () => {
    expect(brokenRules(base, true, [])).toEqual({});
  });
});

import { describe, expect, test } from "bun:test";
import {
  parseDesktopNotificationsPreference,
  requestDesktopNotifications,
} from "@/lib/notifications/desktop";
import {
  type BotNotification,
  parseWaitingBots,
  withoutWaitingBot,
  withWaitingBot,
} from "@/lib/notifications/waiting";

function notification(overrides: Partial<BotNotification> = {}) {
  return {
    id: "notification-1",
    kind: "help_requested",
    botId: "risk-analyst",
    headline: "needs you at the keyboard",
    detail: "This page is asking for a code sent to your phone.",
    at: "2026-08-15T10:00:00.000Z",
    ...overrides,
  } satisfies BotNotification;
}

describe("the record of which Bots are waiting", () => {
  test("keeps one entry per Bot, so asking twice does not accumulate", () => {
    const first = withWaitingBot({}, notification());
    const again = withWaitingBot(
      first,
      notification({ id: "notification-2", detail: "Still waiting." }),
    );

    expect(Object.keys(again)).toEqual(["risk-analyst"]);
    expect(again["risk-analyst"]?.detail).toBe("Still waiting.");
  });

  test("returns the same object for an event it has already recorded", () => {
    const waiting = withWaitingBot({}, notification());

    // The roster renders from this. A repeated event that produced a new object would re-render
    // every row for a marker that has not changed.
    expect(withWaitingBot(waiting, notification())).toBe(waiting);
    expect(withoutWaitingBot(waiting, "somebody-else")).toBe(waiting);
  });

  test("forgets a Bot that has been opened, and only that one", () => {
    const waiting = withWaitingBot(
      withWaitingBot({}, notification()),
      notification({ id: "notification-2", botId: "expense-manager" }),
    );

    expect(Object.keys(withoutWaitingBot(waiting, "risk-analyst"))).toEqual([
      "expense-manager",
    ]);
  });

  test("survives being written down and read back", () => {
    const waiting = withWaitingBot({}, notification());

    // The marker outliving a reload is the whole reason this is stored rather than held in state:
    // refreshing a tab is not an answer to a Bot's question.
    expect(parseWaitingBots(JSON.stringify(waiting))).toEqual(waiting);
  });

  test("treats anything it cannot read as nothing waiting", () => {
    // A value from an older shape, or one somebody edited by hand. Throwing over it would take the
    // sidebar down over a decoration.
    expect(parseWaitingBots(null)).toEqual({});
    expect(parseWaitingBots("not json")).toEqual({});
    expect(parseWaitingBots("[]")).toEqual({});
    expect(parseWaitingBots('{"risk-analyst":{"id":"x"}}')).toEqual({});
  });
});

describe("desktop notifications", () => {
  test("are off unless this browser was explicitly turned on", () => {
    expect(parseDesktopNotificationsPreference("on")).toBe(true);
    expect(parseDesktopNotificationsPreference("off")).toBe(false);
    expect(parseDesktopNotificationsPreference(null)).toBe(false);
    expect(parseDesktopNotificationsPreference("true")).toBe(false);
  });

  test("do not prompt a browser that has already granted permission", async () => {
    let asked = 0;
    const answer = await requestDesktopNotifications({
      permission: "granted",
      requestPermission: async () => {
        asked += 1;
        return "granted";
      },
    });

    expect(answer).toBe("granted");
    expect(asked).toBe(0);
  });

  test("report a refusal rather than storing an opt-in the browser will not honour", async () => {
    const answer = await requestDesktopNotifications({
      permission: "default",
      requestPermission: async () => "denied",
    });

    expect(answer).toBe("denied");
  });

  test("tell a browser without notifications apart from one that said no", async () => {
    // Different sentences: denied is a decision somebody can revisit in their browser, unsupported
    // sends them looking for a control that is not there.
    expect(await requestDesktopNotifications(null)).toBe("unsupported");
  });
});

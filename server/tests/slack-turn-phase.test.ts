import { describe, expect, test } from "bun:test";
import {
  runSlackPhase,
  SLACK_TURN_PHASES,
  type SlackTurnFailureEvent,
} from "../src/slack/turn-phase";

describe("Slack turn phase diagnostics", () => {
  test("logs only the fixed event type and phase for every allowed phase", async () => {
    for (const phase of SLACK_TURN_PHASES) {
      const events: SlackTurnFailureEvent[] = [];
      const original = new Error("sensitive failure");

      await expect(
        runSlackPhase(
          phase,
          async () => {
            throw original;
          },
          (event) => events.push(event),
        ),
      ).rejects.toBe(original);

      expect(events).toEqual([{ type: "slack-turn-failed", phase }]);
      expect(Object.keys(events[0] ?? {}).sort()).toEqual(["phase", "type"]);
      expect(JSON.stringify(events)).not.toContain("sensitive");
    }
  });

  test("successful operations are silent", async () => {
    const events: SlackTurnFailureEvent[] = [];
    await expect(
      runSlackPhase(
        "identity.resolve",
        () => "linked",
        (event) => events.push(event),
      ),
    ).resolves.toBe("linked");
    expect(events).toEqual([]);
  });

  test("logs only allowlisted identity failure codes", async () => {
    const events: SlackTurnFailureEvent[] = [];
    const coded = Object.assign(new Error("sensitive database detail"), {
      code: "slack_identity_link_lookup_failed",
    });

    await expect(
      runSlackPhase(
        "identity.resolve",
        async () => {
          throw coded;
        },
        (event) => events.push(event),
      ),
    ).rejects.toBe(coded);

    expect(events).toEqual([
      {
        type: "slack-turn-failed",
        phase: "identity.resolve",
        reason: "slack_identity_link_lookup_failed",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("sensitive");

    const untrustedEvents: SlackTurnFailureEvent[] = [];
    await expect(
      runSlackPhase(
        "identity.resolve",
        async () => {
          throw Object.assign(new Error("secret"), { code: "secret" });
        },
        (event) => untrustedEvents.push(event),
      ),
    ).rejects.toThrow("secret");
    expect(untrustedEvents).toEqual([
      { type: "slack-turn-failed", phase: "identity.resolve" },
    ]);
  });

  test("logger failure cannot replace the application error", async () => {
    const original = new Error("application failure");
    await expect(
      runSlackPhase(
        "agent.run",
        async () => {
          throw original;
        },
        () => {
          throw new Error("logger failure");
        },
      ),
    ).rejects.toBe(original);
  });
});

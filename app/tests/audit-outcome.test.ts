import { describe, expect, test } from "bun:test";
import {
  DID_NOT_HAPPEN_EVENT_TYPES,
  eventTypeFilter,
  outcomeOf,
  REFUSED_EVENT_TYPES,
} from "../src/lib/audit/outcome";

/**
 * What the audit page says about a row, which for a refusal has exactly one wrong answer.
 *
 * The page falls back to "Allowed" for anything it does not recognise, which is right for the many
 * rows that are neither a refusal nor a failure. For a refusal it is the opposite of what happened,
 * on the screen somebody opens to find out what happened.
 */

describe("what the trail says a row was", () => {
  test("names a hop a boundary refused as a refusal", () => {
    expect(outcomeOf("agent.handoff_refused")).toBe("refused");
  });

  test("names a sign-in turned away as a refusal", () => {
    expect(outcomeOf("session.refused")).toBe("refused");
  });

  test("names a rotation the vault refused as a refusal", () => {
    expect(outcomeOf("credential.rotation_refused")).toBe("refused");
  });

  test("names an endpoint this deployment would not dial as a refusal", () => {
    expect(outcomeOf("agent.dial_refused")).toBe("refused");
  });

  test("keeps the refusals that were already named", () => {
    for (const eventType of [
      "computer.action_refused",
      "component.refused",
      "component.function_refused",
      "mcp.call_rejected",
      "mcp.callback_refused",
      "routines.dispatch_refused",
    ]) {
      expect(outcomeOf(eventType)).toBe("refused");
    }
  });

  test("tells a hop that never landed from one that was refused", () => {
    // Nothing was refused: the hop was accepted, tried, and ran out of attempts.
    expect(outcomeOf("agent.handoff_failed")).toBe("did-not-happen");
    // And a question that reached nobody, which nothing else anywhere records.
    expect(outcomeOf("agent.escalation_failed")).toBe("did-not-happen");
    expect(outcomeOf("computer.action_failed")).toBe("did-not-happen");
    expect(outcomeOf("agent.stream_stalled")).toBe("did-not-happen");
  });

  test("still calls something that went through allowed", () => {
    for (const eventType of [
      "computer.action_allowed",
      "mcp.call_succeeded",
      "agent.handoff_delivered",
      "agent.escalated",
      "credential.created",
      "session.signed_in",
    ]) {
      expect(outcomeOf(eventType)).toBe("allowed");
    }
  });

  test("does not call an unknown row a refusal", () => {
    // The fallback has to stay open: a row type this build has never heard of is not a refusal, and
    // claiming otherwise would be the same fault in the other direction.
    expect(outcomeOf("something.nobody.has.written.yet")).toBe("allowed");
  });
});

describe("the saved views ask the same question the rows do", () => {
  /*
   * The drift this exists to stop. Two hand-written lists meant a refusal could be drawn correctly
   * on the row and be absent from the view somebody clicks to ask what this deployment refused —
   * which is the harder failure to notice, because the view is not empty, it is just short.
   */
  test("Blocked filters by every event type drawn as a refusal", () => {
    const filtered = eventTypeFilter(REFUSED_EVENT_TYPES)
      .replace("?eventType=", "")
      .split(",");

    expect(filtered).toEqual([...REFUSED_EVENT_TYPES]);
    for (const eventType of filtered) {
      expect(outcomeOf(eventType)).toBe("refused");
    }
  });

  test("Did not happen filters by every event type drawn that way", () => {
    const filtered = eventTypeFilter(DID_NOT_HAPPEN_EVENT_TYPES)
      .replace("?eventType=", "")
      .split(",");

    expect(filtered).toEqual([...DID_NOT_HAPPEN_EVENT_TYPES]);
    for (const eventType of filtered) {
      expect(outcomeOf(eventType)).toBe("did-not-happen");
    }
  });

  test("no event type is in both families", () => {
    const refused = new Set<string>(REFUSED_EVENT_TYPES);
    for (const eventType of DID_NOT_HAPPEN_EVENT_TYPES) {
      expect(refused.has(eventType)).toBe(false);
    }
  });
});

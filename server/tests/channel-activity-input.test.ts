import { describe, expect, test } from "bun:test";
import { parseActivityInput } from "../src/channels/routes";

/**
 * The moment a browser says a message arrived is the browser's clock, and the row it lands on is
 * compared against by every other clock in the deployment: the routine runner's, a relayed
 * handoff answer's, and every other member's browser. `recordActivity` only moves forwards, so a
 * report stamped in the future is not the report that gets lost — every correct one after it is.
 */
describe("parsing a reported message", () => {
  const now = new Date("2026-09-03T10:00:00.000Z");

  test("keeps a timestamp that is not ahead of the server", () => {
    const at = "2026-09-03T09:59:30.000Z";
    const parsed = parseActivityInput(
      { text: "hello", agentId: null, at },
      now,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.at.toISOString()).toBe(at);
  });

  test("clamps a timestamp from a clock that runs ahead to now", () => {
    const parsed = parseActivityInput(
      { text: "hello", agentId: null, at: "2026-09-03T10:07:00.000Z" },
      now,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.at.toISOString()).toBe(now.toISOString());
  });

  test("still refuses a timestamp that is not a date", () => {
    const parsed = parseActivityInput(
      { text: "hello", agentId: null, at: "yesterday" },
      now,
    );
    expect(parsed).toEqual({
      ok: false,
      error: "Timestamp must be an ISO-8601 date.",
    });
  });

  test("keeps the rest of the report as it was", () => {
    const parsed = parseActivityInput(
      { text: "hello", agentId: " agent-1 ", at: "2026-09-03T09:00:00.000Z" },
      now,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.text).toBe("hello");
    expect(parsed.value.agentId).toBe("agent-1");
  });

  test("refuses a whitespace-only agent ID rather than looking it up", () => {
    // "   " used to trim to "" and fall through to a 404 "Agent not found";
    // a malformed field is a 400 naming the field.
    const parsed = parseActivityInput(
      { text: "hello", agentId: "   ", at: "2026-09-03T09:00:00.000Z" },
      now,
    );
    expect(parsed).toEqual({
      ok: false,
      error: "Agent ID must be a string or null.",
    });
  });
});

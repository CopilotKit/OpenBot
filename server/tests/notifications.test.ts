import { describe, expect, test } from "bun:test";
import {
  isWorthInterrupting,
  NOTIFICATION_DETAIL_LIMIT,
  notificationFor,
  notificationKinds,
  summarize,
} from "../src/notifications";

/**
 * What the rule must guarantee, and none of it is visible from a green typecheck.
 *
 * The four that matter:
 *  - a Bot blocked on a person earns an interruption
 *  - a person who has silenced a Bot is not interrupted by it, whatever it is doing
 *  - what the model said is flattened to one line before it is put in front of anybody
 *  - the frame carries the Bot, so a click on it lands somewhere useful
 */

const BLOCKED = {
  kind: "help_requested",
  botId: "risk-analyst",
  userId: "user-1",
  detail: "This page is asking for a code sent to your phone.",
} as const;

const HEARD = { muted: false };
const SILENCED = { muted: true };

describe("what is worth interrupting somebody for", () => {
  test("a Bot waiting on a person is", () => {
    expect(isWorthInterrupting("help_requested")).toBe(true);
    expect(isWorthInterrupting("secret_requested")).toBe(true);
  });

  test("every kind in the vocabulary has an answer", () => {
    expect(notificationKinds.length).toBeGreaterThan(0);
    for (const kind of notificationKinds) {
      expect(typeof isWorthInterrupting(kind)).toBe("boolean");
    }
  });

  test("a Bot this person has silenced is not, whatever it is asking for", () => {
    expect(notificationFor(BLOCKED, SILENCED)).toBeNull();
    expect(
      notificationFor({ ...BLOCKED, kind: "secret_requested" }, SILENCED),
    ).toBeNull();
  });

  test("the preference is read here rather than trusted to a surface downstream", () => {
    // One place decides, so anything that renders whatever it is handed is correct by construction.
    // A rule that returned a notification marked "do not show this" would put the decision in every
    // surface instead, and the first one to forget it would page somebody who had opted out.
    expect(notificationFor(BLOCKED, HEARD)).not.toBeNull();
    expect(notificationFor(BLOCKED, SILENCED)).toBeNull();
  });
});

describe("the frame a notification carries", () => {
  test("names the Bot, so a click can be routed to the one that is waiting", () => {
    const raised = notificationFor(BLOCKED, HEARD);

    expect(raised?.botId).toBe("risk-analyst");
    expect(raised?.kind).toBe("help_requested");
  });

  test("says what happened in the product's words and what the Bot said in its own", () => {
    const raised = notificationFor(BLOCKED, HEARD);

    // The headline is fixed text, so a model that has just failed to log in is not the author of the
    // sentence describing its own failure.
    expect(raised?.headline).toBe("needs you at the keyboard");
    expect(raised?.detail).toBe(
      "This page is asking for a code sent to your phone.",
    );
  });

  test("is stamped with the moment it was raised, and is individually identifiable", () => {
    const at = new Date("2026-08-15T10:00:00.000Z");
    const first = notificationFor(BLOCKED, HEARD, at);
    const second = notificationFor(BLOCKED, HEARD, at);

    expect(first?.at).toBe("2026-08-15T10:00:00.000Z");
    // Two raisings of the same thing are two notifications. A surface keys a toast on the id, and
    // sharing one would silently swallow the second time a Bot asked for help.
    expect(first?.id).not.toBe(second?.id);
  });
});

describe("summarize", () => {
  test("flattens a model's paragraphs into one line", () => {
    expect(summarize("The login page\nwants a code.\n\nPlease help.")).toBe(
      "The login page wants a code. Please help.",
    );
  });

  test("unwraps a fenced block rather than dropping what is inside it", () => {
    // A Bot that puts the whole of what it needs inside backticks would otherwise produce an empty
    // notification, which is the one outcome worse than an untidy one.
    expect(summarize("Run this:\n```bash\nnpm login\n```\nthen tell me.")).toBe(
      "Run this: npm login then tell me.",
    );
    expect(summarize("```\nsign in here\n```")).toBe("sign in here");
  });

  test("removes control characters a page could have put in front of the model", () => {
    expect(summarize("Sign in now\u001b[31m.")).toBe("Sign in now [31m.");
  });

  test("clips with an ellipsis at the limit, and leaves shorter text alone", () => {
    const long = "a".repeat(NOTIFICATION_DETAIL_LIMIT + 40);
    const clipped = summarize(long);

    expect(Array.from(clipped)).toHaveLength(NOTIFICATION_DETAIL_LIMIT);
    expect(clipped.endsWith("…")).toBe(true);

    const exact = "b".repeat(NOTIFICATION_DETAIL_LIMIT);
    expect(summarize(exact)).toBe(exact);
  });

  test("counts what it clips in code points, not UTF-16 units", () => {
    // Sliced by string index, a clip lands between the halves of a surrogate pair and leaves a
    // replacement character in front of somebody.
    const clipped = summarize("🙂".repeat(20), 10);

    expect(Array.from(clipped)).toHaveLength(10);
    expect(clipped.includes("�")).toBe(false);
  });

  test("survives a Bot that said nothing useful", () => {
    expect(summarize("   \n\n  ")).toBe("");
    expect(summarize("```")).toBe("");
  });
});

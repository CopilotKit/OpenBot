import { describe, expect, test } from "bun:test";
import {
  type ApprovalSubject,
  createApprovalRegistry,
  fingerprintOf,
} from "../src/computer/approvals";

/**
 * What an approval has to mean, tested as properties rather than as a call sequence.
 *
 * A registry that only remembered ids would pass a naive test and be worthless: the failure it
 * exists to prevent is a person allowing one thing and a model spending that permission on another,
 * and nothing about that is visible from a green typecheck. So the cases here are the four ways a
 * grant can be stretched beyond what somebody agreed to, plus the two ways it stops being valid.
 */

const CLICK: ApprovalSubject = {
  botId: "sales-bot",
  toolName: "computer_click",
  ref: "e9",
  pageUrl: "https://example.com/order",
};

function registry(clock?: { at: number }) {
  return createApprovalRegistry(clock ? { now: () => clock.at } : {});
}

function ask(
  approvals: ReturnType<typeof registry>,
  subject: ApprovalSubject = CLICK,
) {
  return approvals.request({
    botId: subject.botId,
    actor: "someone@example.test",
    rule: 'contains(element.name, "submit")',
    question: "The Bot wants to press “Submit order” on example.com.",
    fingerprint: fingerprintOf(subject),
    target: { type: "computer", id: subject.botId },
  });
}

/** Answering, on the Bot the question was asked about, which is the ordinary case. */
function answer(
  approvals: ReturnType<typeof registry>,
  id: string,
  who: string,
  granted: boolean,
  botId = CLICK.botId,
) {
  return approvals.answer(id, botId, who, granted);
}

describe("an approval", () => {
  test("is spendable on the action it was granted for", () => {
    const approvals = registry();
    const pending = ask(approvals);
    answer(approvals, pending.id, "manager@example.test", true);

    const spent = approvals.consume(pending.id, fingerprintOf(CLICK));
    expect(spent.ok).toBe(true);
    if (spent.ok)
      expect(spent.approval.answeredBy).toBe("manager@example.test");
  });

  test("is refused for a DIFFERENT action, which is the whole point of it", () => {
    // "Yes, click Place order" must not be replayable as "yes, click Delete account". Without this
    // the feature is a dialog box that returns a token good for anything.
    const approvals = registry();
    const pending = ask(approvals);
    answer(approvals, pending.id, "manager@example.test", true);

    const elsewhere = approvals.consume(
      pending.id,
      fingerprintOf({ ...CLICK, ref: "e42" }),
    );
    expect(elsewhere.ok).toBe(false);
    if (!elsewhere.ok) expect(elsewhere.reason).toBe("a different action");
  });

  test("survives a failed replay, so the person's answer is not lost with it", () => {
    // A mismatch leaves the approval alone. Burning it would let a model that reached for the wrong
    // button take away permission for the one somebody actually meant.
    const approvals = registry();
    const pending = ask(approvals);
    answer(approvals, pending.id, "manager@example.test", true);
    approvals.consume(pending.id, fingerprintOf({ ...CLICK, ref: "e42" }));

    expect(approvals.consume(pending.id, fingerprintOf(CLICK)).ok).toBe(true);
  });

  test("is good exactly once", () => {
    const approvals = registry();
    const pending = ask(approvals);
    answer(approvals, pending.id, "manager@example.test", true);

    expect(approvals.consume(pending.id, fingerprintOf(CLICK)).ok).toBe(true);
    const again = approvals.consume(pending.id, fingerprintOf(CLICK));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe("unknown");
  });

  test("cannot be spent before anybody has answered", () => {
    const approvals = registry();
    const pending = ask(approvals);

    const early = approvals.consume(pending.id, fingerprintOf(CLICK));
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.reason).toBe("unanswered");
  });

  test("a No is an answer, and it is final", () => {
    const approvals = registry();
    const pending = ask(approvals);
    answer(approvals, pending.id, "manager@example.test", false);

    const declined = approvals.consume(pending.id, fingerprintOf(CLICK));
    expect(declined.ok).toBe(false);
    if (!declined.ok) expect(declined.reason).toBe("declined");
  });

  test("cannot be answered twice, so a decision cannot be quietly overturned", () => {
    const approvals = registry();
    const pending = ask(approvals);
    answer(approvals, pending.id, "manager@example.test", false);

    const second = answer(approvals, pending.id, "somebody@example.test", true);
    expect(second.ok).toBe(false);
    expect(approvals.consume(pending.id, fingerprintOf(CLICK)).ok).toBe(false);
  });

  test("runs out, and stops being answerable when it does", () => {
    const clock = { at: Date.parse("2026-01-01T09:00:00.000Z") };
    const approvals = createApprovalRegistry({
      now: () => clock.at,
      ttlMs: 60_000,
    });
    const pending = ask(approvals);
    expect(approvals.pending("sales-bot")).toHaveLength(1);

    clock.at += 60_001;
    // Swept on the way past rather than on a timer, so a question nobody answered leaves no trace
    // that could later be mistaken for one somebody did.
    expect(approvals.pending("sales-bot")).toHaveLength(0);
    expect(answer(approvals, pending.id, "late@example.test", true).ok).toBe(
      false,
    );
    expect(approvals.consume(pending.id, fingerprintOf(CLICK)).ok).toBe(false);
  });

  test("an already-granted approval expires too", () => {
    const clock = { at: Date.parse("2026-01-01T09:00:00.000Z") };
    const approvals = createApprovalRegistry({
      now: () => clock.at,
      ttlMs: 60_000,
    });
    const pending = ask(approvals);
    answer(approvals, pending.id, "manager@example.test", true);

    clock.at += 60_001;
    // Consent to something that was going to happen now is not consent to it happening in an hour.
    expect(approvals.consume(pending.id, fingerprintOf(CLICK)).ok).toBe(false);
  });
});

describe("an approval belongs to one Bot", () => {
  const SAME_ACTION_OTHER_BOT: ApprovalSubject = {
    ...CLICK,
    botId: "research-bot",
  };

  test("cannot be spent by another Bot doing the identical thing", () => {
    // The Bot id is inside the fingerprint, so two Bots clicking the same ref on the same page
    // produce two different bindings. Otherwise a permission given on one computer would carry over
    // to a computer with different logins and a different person's session in it.
    const approvals = registry();
    const pending = ask(approvals);
    answer(approvals, pending.id, "manager@example.test", true);

    const elsewhere = approvals.consume(
      pending.id,
      fingerprintOf(SAME_ACTION_OTHER_BOT),
    );
    expect(elsewhere.ok).toBe(false);
    if (!elsewhere.ok) expect(elsewhere.reason).toBe("a different action");
  });

  test("cannot be answered from another Bot's address", () => {
    // The id is enough to find the question, so this is not authorisation, it is the trail: the row
    // an answer writes says which Bot it was about, and it is taken from the request. Without this
    // check a grant lands under one Bot and the action it pays for under another, and filtering the
    // audit page by either shows half the story.
    const approvals = registry();
    const pending = ask(approvals);

    const elsewhere = approvals.answer(
      pending.id,
      "research-bot",
      "mallory@example.test",
      true,
    );
    expect(elsewhere.ok).toBe(false);
    // Still open, and still answerable by somebody who arrived at the right address.
    expect(answer(approvals, pending.id, "manager@example.test", true).ok).toBe(
      true,
    );
  });

  test("does not show up in another Bot's pending list", () => {
    const approvals = registry();
    ask(approvals);
    expect(approvals.pending("research-bot")).toEqual([]);
    expect(approvals.pending("sales-bot")).toHaveLength(1);
  });
});

describe("the fingerprint", () => {
  test("is the same for the same action and different for every changed part", () => {
    expect(fingerprintOf(CLICK)).toBe(fingerprintOf({ ...CLICK }));
    for (const changed of [
      { ...CLICK, botId: "other" },
      { ...CLICK, toolName: "computer_key" },
      { ...CLICK, ref: "e10" },
      { ...CLICK, key: "Enter" },
      { ...CLICK, filePath: "notes.md" },
      { ...CLICK, pageUrl: "https://example.com/other" },
      // Typing into a field and typing into it then pressing Enter are two different actions, and
      // the second one submits the form. An approval for one must not be spendable as the other.
      { ...CLICK, submit: true },
      { ...CLICK, arguments: { channel: "#general" } },
    ]) {
      expect(fingerprintOf(changed)).not.toBe(fingerprintOf(CLICK));
    }
  });

  test("reads the same arguments the same way whatever order they arrive in", () => {
    // A tool call goes through a parse between being asked about and being retried, and an approval
    // that stopped fitting because a client wrote its fields in another order would send somebody a
    // second question about the call they just allowed.
    expect(
      fingerprintOf({
        botId: "b",
        toolName: "t",
        arguments: { channel: "#general", text: "shipped" },
      }),
    ).toBe(
      fingerprintOf({
        botId: "b",
        toolName: "t",
        arguments: { text: "shipped", channel: "#general" },
      }),
    );
  });

  test("tells one set of arguments from another", () => {
    // The reason arguments are in here at all: "post the release note in the team channel" is not
    // permission to post something else somewhere else.
    expect(
      fingerprintOf({
        botId: "b",
        toolName: "t",
        arguments: { channel: "#general", text: "shipped" },
      }),
    ).not.toBe(
      fingerprintOf({
        botId: "b",
        toolName: "t",
        arguments: { channel: "#board", text: "shipped" },
      }),
    );
  });

  test("cannot be made to collide by shuffling where a boundary falls", () => {
    // The parts are joined with a separator no field can contain, so a ref of "ab" with no key is a
    // different action from a ref of "a" with a key of "b".
    expect(fingerprintOf({ botId: "b", toolName: "t", ref: "ab" })).not.toBe(
      fingerprintOf({ botId: "b", toolName: "t", ref: "a", key: "b" }),
    );
  });
});

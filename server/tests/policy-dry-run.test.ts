import { describe, expect, test } from "bun:test";
import type { AuditEvent } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import {
  contextFromAuditPayload,
  dryRunAgainstHistory,
} from "../src/computer/policy-dry-run";

/**
 * The replay must judge a recorded action exactly as the gateway judged it live. Every case here is
 * a divergence that would make the feature lie: a field stored beside the element instead of inside
 * it, an intent that is derived rather than stored, a row that predates a field.
 */

const PERMIT_EVERYTHING: ActionPolicy = {
  mode: "enforce",
  deny: [],
  allow: ["true"],
};

function event(
  overrides: Partial<AuditEvent> & { payload: Record<string, unknown> },
): AuditEvent {
  return {
    id: overrides.id ?? "evt-1",
    actorUserId: null,
    eventType: overrides.eventType ?? "computer.action_allowed",
    targetType: "computer",
    targetId: "general-assistant",
    createdAt: overrides.createdAt ?? "2026-08-01T00:00:00.000Z",
    payload: overrides.payload,
  };
}

const CLICK_SUBMIT = {
  action: "computer_click",
  bot: "general-assistant",
  actor: "user:dev",
  page: "https://shop.example/checkout",
  ref: "e12",
  element: { role: "button", name: "Submit order" },
};

describe("the initiator a replayed row carries", () => {
  test("a row with no initiator replays as a person, not as an unbound identifier", () => {
    // Every computer row written before this field existed. A rule naming the initiator has to judge
    // them rather than throw, which fails closed and would report a boundary far stricter than the
    // one being tested.
    expect(contextFromAuditPayload(CLICK_SUBMIT)?.initiator).toEqual({
      kind: "person",
      id: "",
    });
  });

  test("a row that names a routine replays as that routine", () => {
    expect(
      contextFromAuditPayload({
        ...CLICK_SUBMIT,
        initiator: { kind: "routine", id: "nightly-summary" },
      })?.initiator,
    ).toEqual({ kind: "routine", id: "nightly-summary" });
  });

  test("a shape this version does not recognise reads as a person rather than as itself", () => {
    // A row from a later version, or one inserted by hand. Guessing at it would replay a rule
    // against a kind no branch here knows, so it is read as absent and neutralised.
    for (const initiator of [
      { kind: "wat", id: "x" },
      { kind: "routine" },
      "routine",
      null,
    ]) {
      expect(
        contextFromAuditPayload({ ...CLICK_SUBMIT, initiator })?.initiator,
      ).toEqual({ kind: "person", id: "" });
    }
  });
});

describe("contextFromAuditPayload", () => {
  test("rebuilds the element with the ref that is stored beside it", () => {
    const context = contextFromAuditPayload(CLICK_SUBMIT);
    expect(context?.element).toEqual({
      ref: "e12",
      role: "button",
      name: "Submit order",
      type: "",
    });
    expect(context?.page.host).toBe("shop.example");
  });

  test("derives intent the way the gateway does, including Enter as activation", () => {
    expect(contextFromAuditPayload(CLICK_SUBMIT)?.intent).toBe("activate");
    const enter = contextFromAuditPayload({
      action: "computer_key",
      bot: "b",
      key: "Enter",
    });
    expect(enter?.intent).toBe("activate");
    const letter = contextFromAuditPayload({
      action: "computer_key",
      bot: "b",
      key: "a",
    });
    expect(letter?.intent).toBe("type");
  });

  test("an unidentifiable element replays as the neutral element, not a throw", () => {
    // The gateway records the sentence "not in the current snapshot" for these rows.
    const context = contextFromAuditPayload({
      action: "computer_click",
      bot: "b",
      element: "not in the current snapshot",
    });
    expect(context?.element).toEqual({ ref: "", role: "", name: "", type: "" });
  });

  test("a row without the facts to replay is skipped, not guessed at", () => {
    expect(contextFromAuditPayload({ bot: "b" })).toBeNull();
    expect(contextFromAuditPayload({ action: 7, bot: "b" })).toBeNull();
  });

  test("a folder action on the person's own computer is not this policy's to replay", () => {
    // Recorded as a computer action so Activity reads it as one; its folder grant and the desktop's
    // own asking decide it, so a policy for the cloud computer must not count it.
    expect(
      contextFromAuditPayload({
        action: "host/run_command",
        bot: "b",
        command: "dir",
      }),
    ).toBeNull();
  });
});

describe("dryRunAgainstHistory", () => {
  test("a new deny reports the allowed actions it would now refuse, with the rule", () => {
    const candidate: ActionPolicy = {
      mode: "enforce",
      deny: ['contains(element.name, "Submit")'],
      allow: ["true"],
    };
    const report = dryRunAgainstHistory(candidate, [
      event({ id: "a", payload: CLICK_SUBMIT }),
      event({
        id: "b",
        payload: { ...CLICK_SUBMIT, element: { role: "link", name: "Help" } },
      }),
    ]);
    expect(report.scanned).toBe(2);
    expect(report.wouldRefuse).toBe(1);
    expect(report.unchanged).toBe(1);
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]?.id).toBe("a");
    expect(report.changes[0]?.was).toBe("allowed");
    expect(report.changes[0]?.would).toBe("refused");
    expect(report.changes[0]?.rule).toBe('contains(element.name, "Submit")');
  });

  test("a loosened policy reports refusals it would now allow", () => {
    const report = dryRunAgainstHistory(PERMIT_EVERYTHING, [
      event({
        id: "r",
        eventType: "computer.action_refused",
        payload: CLICK_SUBMIT,
      }),
    ]);
    expect(report.wouldAllow).toBe(1);
    expect(report.changes[0]?.was).toBe("refused");
    expect(report.changes[0]?.would).toBe("allowed");
  });

  test("a permitted action that failed is counted once, from its decision row", () => {
    // The gateway records a permitted-but-failed action twice: the decision row written before the
    // attempt, and a failure row written when it did not succeed. Both carry the same action, and
    // both are returned by the trail query, so scoring the failure row too would count the action a
    // second time. Its baseline is still "allowed" — from the decision row that permitted it.
    const deny: ActionPolicy = {
      mode: "enforce",
      deny: ['tool.name == "computer_click"'],
      allow: ["true"],
    };
    const report = dryRunAgainstHistory(deny, [
      event({
        id: "dec",
        eventType: "computer.action_allowed",
        payload: CLICK_SUBMIT,
      }),
      event({
        id: "fail",
        eventType: "computer.action_failed",
        payload: CLICK_SUBMIT,
      }),
    ]);
    expect(report.scanned).toBe(1);
    expect(report.wouldRefuse).toBe(1);
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]?.id).toBe("dec");
    expect(report.changes[0]?.was).toBe("allowed");
  });

  test("a dry-run refusal that was carried out and then failed invents no change", () => {
    // In dry-run mode a refused action is still carried out, so a refused action can also fail. The
    // decision row says "refused"; the failure row, read on its own, would read as "allowed" and a
    // candidate that refuses the same action would then look like a new refusal. Skipping the failure
    // row leaves only the honest baseline: it was refused, a policy that refuses it changes nothing.
    const denyClicks: ActionPolicy = {
      mode: "enforce",
      deny: ['tool.name == "computer_click"'],
      allow: ["true"],
    };
    const report = dryRunAgainstHistory(denyClicks, [
      event({
        id: "dec",
        eventType: "computer.action_refused",
        payload: CLICK_SUBMIT,
      }),
      event({
        id: "fail",
        eventType: "computer.action_failed",
        payload: CLICK_SUBMIT,
      }),
    ]);
    expect(report.scanned).toBe(1);
    expect(report.wouldRefuse).toBe(0);
    expect(report.unchanged).toBe(1);
  });

  test("a rule naming a command does not refuse a click, because absent facts are neutral", () => {
    const candidate: ActionPolicy = {
      mode: "enforce",
      deny: ['contains(command, "rm -rf")'],
      allow: ["true"],
    };
    const report = dryRunAgainstHistory(candidate, [
      event({ payload: CLICK_SUBMIT }),
    ]);
    // The honest answer to "is this click running rm -rf" is no. A replay that failed closed here
    // would report the boundary as far stricter than the one proposed.
    expect(report.wouldRefuse).toBe(0);
    expect(report.unchanged).toBe(1);
  });

  test("a routine's command replays as the routine's, read from the row's columns where the gateway writes it", () => {
    // The gateway records the initiator in `initiator_kind` and `initiator_id`, never in the payload.
    // Read from the payload only, every routine's action replayed as a person's, and the design's own
    // example rule previewed as stopping nothing.
    const candidate: ActionPolicy = {
      mode: "enforce",
      deny: ['initiator.kind == "routine" && intent == "run_command"'],
      allow: ["true"],
    };
    const report = dryRunAgainstHistory(candidate, [
      {
        id: "nightly",
        actorUserId: "user-1",
        initiatorKind: "routine",
        initiatorId: "nightly-cleanup",
        eventType: "computer.action_allowed",
        targetType: "computer",
        targetId: "general-assistant",
        createdAt: "2026-08-01T03:00:00.000Z",
        payload: {
          action: "computer_run_command",
          bot: "general-assistant",
          actor: "user-1",
          page: "",
          command: "rm -rf tmp",
          attempt: "a-1",
          decision: { allowed: true, mode: "enforce", rule: "true" },
        },
      },
    ]);
    expect(report.wouldRefuse).toBe(1);
    expect(report.changes[0]).toMatchObject({
      kind: "computer",
      initiator: { kind: "routine", id: "nightly-cleanup" },
    });
  });

  test("an app call from before rows carried an attempt is still scored once, from its decision row", () => {
    // A trial-mode refusal writes the refusal and then the outcome of the call it let through, both
    // with the refused decision. Rows written before `attempt` existed are paired by which one is the
    // decision: the refusal with no `refusal` reason of its own.
    const decided = {
      actor: "user-1",
      bot: "general-assistant",
      server: "salesforce",
      tool: "update_record",
      effect: "write",
      reachedAs: "person:user-1",
      decision: {
        allowed: false,
        mode: "dry-run",
        rule: 'mcp.server == "salesforce"',
        source: "deny",
        carriedOut: true,
      },
    };
    const row = (id: string, eventType: string, extra = {}): AuditEvent => ({
      id,
      actorUserId: null,
      initiatorKind: "person",
      initiatorId: null,
      eventType,
      targetType: "mcp_tool",
      targetId: "salesforce/update_record",
      createdAt: "2026-08-01T00:00:00.000Z",
      payload: { ...decided, ...extra },
    });
    const history = [
      row("outcome", "mcp.call_succeeded"),
      row("refusal", "mcp.call_rejected"),
      // Refused again afterwards by the content check; still the same call.
      row("later", "mcp.call_rejected", {
        refusal: "sensitive_tool_arguments",
        decision: { ...decided.decision, carriedOut: false },
      }),
    ];
    const lifted = dryRunAgainstHistory(PERMIT_EVERYTHING, history);
    expect(lifted.scanned).toBe(1);
    expect(lifted.wouldAllow).toBe(1);
    expect(lifted.changes.map((change) => change.id)).toEqual(["refusal"]);
    expect(lifted.changes[0]).toMatchObject({
      kind: "app",
      action: "salesforce/update_record",
      was: "refused",
      would: "allowed",
    });
  });

  test("an app call refused before the boundary was asked is not the boundary's to replay", () => {
    const report = dryRunAgainstHistory(PERMIT_EVERYTHING, [
      {
        id: "not-granted",
        actorUserId: null,
        initiatorKind: "person",
        initiatorId: null,
        eventType: "mcp.call_rejected",
        targetType: "mcp_tool",
        targetId: "salesforce/update_record",
        createdAt: "2026-08-01T00:00:00.000Z",
        payload: {
          actor: "user-1",
          bot: "general-assistant",
          server: "salesforce",
          tool: "update_record",
          refusal: "not_granted",
        },
      },
    ]);
    expect(report.scanned).toBe(0);
  });

  test("counts cover every scanned row even past the detail cap", () => {
    const candidate: ActionPolicy = {
      mode: "enforce",
      deny: ["true"],
      allow: ["true"],
    };
    const events = Array.from({ length: 60 }, (_, index) =>
      event({ id: `evt-${index}`, payload: CLICK_SUBMIT }),
    );
    const report = dryRunAgainstHistory(candidate, events);
    expect(report.scanned).toBe(60);
    expect(report.wouldRefuse).toBe(60);
    expect(report.changes).toHaveLength(50);
  });
});

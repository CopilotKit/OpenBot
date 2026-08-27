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

  test("a failed action was permitted first, so it counts as allowed", () => {
    const deny: ActionPolicy = {
      mode: "enforce",
      deny: ['tool.name == "computer_click"'],
      allow: ["true"],
    };
    const report = dryRunAgainstHistory(deny, [
      event({
        id: "f",
        eventType: "computer.action_failed",
        payload: CLICK_SUBMIT,
      }),
    ]);
    expect(report.wouldRefuse).toBe(1);
    expect(report.changes[0]?.was).toBe("allowed");
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

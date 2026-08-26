import { describe, expect, test } from "bun:test";
import type { AuditEvent } from "../src/audit";
import { attentionItemsFrom } from "../src/attention/view";

/**
 * The inbox must show exactly the trail rows that mean "a Bot is waiting on a person", minus what
 * has been handled — and must drop rather than guess when a row cannot say whose trouble it is.
 */

function event(overrides: Partial<AuditEvent>): AuditEvent {
  return {
    id: overrides.id ?? "evt-1",
    actorUserId: null,
    eventType: overrides.eventType ?? "computer.action_refused",
    targetType: overrides.targetType ?? "computer",
    targetId:
      overrides.targetId === undefined
        ? "general-assistant"
        : overrides.targetId,
    payload: overrides.payload ?? {},
    createdAt: overrides.createdAt ?? "2026-08-25T00:00:00.000Z",
  };
}

describe("attentionItemsFrom", () => {
  test("a computer refusal carries the gateway's own reason, whole", () => {
    const items = attentionItemsFrom(
      [
        event({
          payload: {
            decision: { reason: "“Submit order” on shop.example is blocked." },
          },
        }),
      ],
      new Set(),
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("refused");
    expect(items[0]?.sentence).toBe(
      "“Submit order” on shop.example is blocked.",
    );
    expect(items[0]?.botId).toBe("general-assistant");
  });

  test("a tool rejection's Bot is the payload's, never the tool ref in targetId", () => {
    // The real row shape: targetType mcp_tool, targetId the tool ref, the Bot in the payload.
    const items = attentionItemsFrom(
      [
        event({
          eventType: "mcp.call_rejected",
          targetType: "mcp_tool",
          targetId: "jira/jira_create_issue",
          payload: {
            bot: "risk-analyst",
            tool: "jira_create_issue",
            reason: "This Bot holds no grant for that tool.",
          },
        }),
      ],
      new Set(),
    );
    expect(items[0]?.kind).toBe("tool_rejected");
    expect(items[0]?.botId).toBe("risk-analyst");
    // The decision's own sentence, whole.
    expect(items[0]?.sentence).toBe("This Bot holds no grant for that tool.");
  });

  test("a tool rejection without a payload Bot is dropped, not attributed to the tool", () => {
    const items = attentionItemsFrom(
      [
        event({
          eventType: "mcp.call_rejected",
          targetType: "mcp_tool",
          targetId: "jira/jira_create_issue",
          payload: { tool: "jira_create_issue" },
        }),
      ],
      new Set(),
    );
    expect(items).toHaveLength(0);
  });

  test("a stall is one plain sentence", () => {
    const items = attentionItemsFrom(
      [event({ eventType: "agent.stream_stalled", targetType: "agent" })],
      new Set(),
    );
    expect(items[0]?.kind).toBe("stalled");
    expect(items[0]?.sentence).toContain("quiet");
  });

  test("a resolved row is subtracted", () => {
    const items = attentionItemsFrom(
      [event({ id: "handled" }), event({ id: "pending" })],
      new Set(["handled"]),
    );
    expect(items.map((item) => item.id)).toEqual(["pending"]);
  });

  test("a row that cannot name its Bot is dropped, not shown to everybody", () => {
    const items = attentionItemsFrom(
      [event({ targetId: null, payload: {} })],
      new Set(),
    );
    expect(items).toHaveLength(0);
  });

  test("event types outside the three are ignored even if handed in", () => {
    const items = attentionItemsFrom(
      [event({ eventType: "computer.action_allowed" })],
      new Set(),
    );
    expect(items).toHaveLength(0);
  });
});

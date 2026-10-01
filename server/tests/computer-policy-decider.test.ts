import { describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import {
  ActionRefusedError,
  createComputerGateway,
} from "../src/computer/gateway";
import type {
  ActionPolicy,
  PolicyContext,
  PolicyDecider,
  PolicyDecision,
} from "../src/computer/policy";
import type { ComputerProvider } from "../src/computer/provider";

const ACTOR = { id: "dev-local-user" };
const PERMISSIVE: ActionPolicy = {
  mode: "enforce",
  deny: [],
  allow: ["true"],
};

function decision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
  return {
    allowed: true,
    mode: "enforce",
    matched: "custom",
    source: "allow",
    forward: true,
    reason: "Permitted by the custom decider.",
    ...overrides,
  };
}

function harness(options: {
  policy?: () => ActionPolicy | undefined;
  decide?: PolicyDecider;
}) {
  const calls: string[] = [];
  const rows: AuditEventInput[] = [];
  const provider: ComputerProvider = {
    name: "test",
    isolation: "per-bot",
    locate: async () => "http://agent-computer:4100",
    status: async (botId) => ({ botId, state: "ready" }),
    stop: async () => ({ wasRunning: true }),
    reset: async () => ({ cleared: true }),
    list: async () => [],
  };
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path !== "/navigate") {
      throw new Error(`unexpected computer request: ${path}`);
    }
    calls.push("navigate");
    return Response.json({
      url: "https://example.com/",
      title: "Example",
      elapsedMs: 1,
    });
  }) as typeof fetch;

  const gateway = createComputerGateway({
    provider,
    fetchImpl,
    auditStore,
    policy: options.policy ?? (() => PERMISSIVE),
    ...(options.decide ? { decide: options.decide } : {}),
  });

  return { gateway, calls, rows };
}

describe("the computer policy decision point", () => {
  test("uses the built-in evaluator when no custom decider is injected", async () => {
    const { gateway, calls, rows } = harness({});

    await gateway.navigate("bot-1", ACTOR, "https://example.com/order");

    expect(calls).toEqual(["navigate"]);
    expect(rows[0]?.eventType).toBe("computer.action_allowed");
    expect(rows[0]?.payload.decision).toMatchObject({
      allowed: true,
      source: "allow",
      rule: "true",
    });
  });

  test("awaits an injected decider and gives it the resolved policy context", async () => {
    let seen: PolicyContext | undefined;
    const { gateway, calls, rows } = harness({
      policy: () => {
        throw new Error("the built-in policy must not be read");
      },
      decide: async (context) => {
        seen = context;
        return decision();
      },
    });

    await gateway.navigate("bot-1", ACTOR, "https://example.com/order");

    expect(seen).toMatchObject({
      tool: { name: "computer_navigate" },
      bot: { id: "bot-1" },
      actor: { id: ACTOR.id },
      page: { url: "https://example.com/order", host: "example.com" },
    });
    expect(calls).toEqual(["navigate"]);
    expect(rows[0]?.eventType).toBe("computer.action_allowed");
  });

  test("records a custom refusal and never reaches the computer", async () => {
    const { gateway, calls, rows } = harness({
      decide: () =>
        decision({
          allowed: false,
          forward: false,
          matched: "custom-deny",
          source: "deny",
          reason: "Refused by the custom decider.",
        }),
    });

    const error = await gateway
      .navigate("bot-1", ACTOR, "https://example.com/order")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ActionRefusedError);
    expect((error as ActionRefusedError).rule).toBe("custom-deny");
    expect(calls).toEqual([]);
    expect(rows[0]?.eventType).toBe("computer.action_refused");
  });

  test("propagates a decider error and does not carry out the action", async () => {
    const failure = new Error("policy service unavailable");
    const { gateway, calls, rows } = harness({
      decide: () => {
        throw failure;
      },
    });

    await expect(
      gateway.navigate("bot-1", ACTOR, "https://example.com/order"),
    ).rejects.toBe(failure);
    expect(calls).toEqual([]);
    expect(rows).toEqual([]);
  });

  test("the default evaluator still fails closed when no rules permit the action", async () => {
    const { gateway, calls, rows } = harness({ policy: () => undefined });

    await expect(
      gateway.navigate("bot-1", ACTOR, "https://example.com/order"),
    ).rejects.toThrow(ActionRefusedError);

    expect(calls).toEqual([]);
    expect(rows[0]?.eventType).toBe("computer.action_refused");
    expect(rows[0]?.payload.decision).toMatchObject({
      allowed: false,
      carriedOut: false,
      source: "default",
      rule: null,
    });
  });
});

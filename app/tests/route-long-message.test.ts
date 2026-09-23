import { afterEach, expect, test } from "bun:test";
import type { AgentProfileStore } from "../../server/src/agents/profile-store";
import type { AuditStore } from "../../server/src/audit";
import type { IntentRouter } from "../../server/src/routing/classify";
import { createRoutingRoutes } from "../../server/src/routing/routes";
import { routeMessage } from "../src/lib/channels/route";

/**
 * A long message still finds its coworker, and the trail still says how.
 *
 * `POST /api/route` refuses a message over 10,000 characters, so the model prompt it builds stays
 * bounded. The composer has no such limit: a pasted email thread or log is one message. Both callers
 * of `routeMessage` carry on past a failed routing on purpose, so the refusal said nothing on
 * screen. The home composer sent the message to the default coworker instead of the one it is for,
 * and a coworker the person chose was started without its `channel.routed` row.
 *
 * The route itself answers here, not a stub of it, so the cap these hold against is the server's own.
 */

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const ROSTER = [
  {
    id: "general-assistant",
    name: "General Assistant",
    roleDescription: "everyday work",
    visibility: "public",
  },
  {
    id: "risk-analyst",
    name: "Risk Analyst",
    roleDescription: "regulatory and compliance questions",
    visibility: "public",
  },
];

function serve() {
  /** What the router was asked to read, so the text it saw is an assertion. */
  const asked: string[] = [];
  const written: { eventType: string; payload: Record<string, unknown> }[] = [];

  const asActor: Parameters<typeof createRoutingRoutes>[2] = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: "u1",
      email: "person@openbot.test",
      role: "user",
    });
    await next();
  };
  const store = { list: async () => ROSTER } as unknown as AgentProfileStore;
  const router = {
    route: async (text: string) => {
      asked.push(text);
      return {
        agentId: "risk-analyst",
        name: "Risk Analyst",
        reason: "matches what it is for",
        fallback: false,
        undecided: null,
      };
    },
  } as unknown as IntentRouter;
  const auditStore = {
    insert: async (event: {
      eventType: string;
      payload: Record<string, unknown>;
    }) => {
      written.push(event);
    },
  } as unknown as AuditStore;

  const routes = createRoutingRoutes(store, router, asActor, auditStore);
  globalThis.fetch = Object.assign(
    async (
      path: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (path !== "/api/route") throw new Error(`unexpected ${String(path)}`);
      return routes.request("http://openbot.test/", init);
    },
    { preconnect: originalFetch.preconnect },
  );
  return { asked, written };
}

test("a message longer than the route reads is routed to the coworker it is for, and recorded", async () => {
  const { asked, written } = serve();

  const decision = await routeMessage(
    `Which of these clauses breach the policy?\n${"clause ".repeat(4_000)}`,
  );

  expect(decision.agentId).toBe("risk-analyst");
  expect(asked).toHaveLength(1);
  expect(asked[0]?.startsWith("Which of these clauses")).toBe(true);
  expect(written.map((row) => row.eventType)).toEqual(["channel.routed"]);
});

test("a long message to a coworker the person chose is recorded as their choice", async () => {
  const { asked, written } = serve();

  const decision = await routeMessage("x".repeat(25_000), "risk-analyst");

  expect(decision).toMatchObject({
    agentId: "risk-analyst",
    viaMention: true,
  });
  expect(asked).toEqual([]);
  expect(written).toHaveLength(1);
  expect(written[0]?.payload).toMatchObject({
    chosen: "risk-analyst",
    viaMention: true,
  });
});

test("the opening is cut between characters, not through an emoji", async () => {
  const { asked } = serve();

  // The emoji's two halves straddle the 10,000th unit.
  await routeMessage(`${"a".repeat(9_999)}😀${"b".repeat(50)}`);

  expect(asked).toEqual(["a".repeat(9_999)]);
});

test("a message that fits is sent as it was written", async () => {
  const { asked } = serve();

  await routeMessage("Is this contract compliant? 😀");

  expect(asked).toEqual(["Is this contract compliant? 😀"]);
});

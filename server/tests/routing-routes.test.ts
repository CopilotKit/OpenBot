import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import type { IntentRouter, RoutingUndecided } from "../src/routing/classify";
import { createRoutingRoutes } from "../src/routing/routes";

/**
 * Why a conversation went where it went, for every conversation.
 *
 * `channel.routed` carries a `viaMention` field that was hardcoded false at the only place the row
 * was written, so it could never be true. The reason was structural rather than a typo: naming a
 * coworker with `@` short-circuited the router in the composer, so that code never ran and no row
 * was written at all.
 *
 * Four routings in a validation pass, every one `viaMention=false`, and a conversation sent to Risk
 * Analyst through the picker that produced tool calls recorded against `bot=risk-analyst` with no
 * `channel.routed` row anywhere near it. The mention worked; the trail could not say so, and a
 * missing row is indistinguishable from one that failed to write.
 *
 * So the choice is recorded too, and these hold both halves: the field earns its place, and the
 * model is never asked a question the person already answered.
 */

const ACTOR = { id: "u1", email: "person@openbot.test", role: "user" } as const;

const ROSTER = [
  {
    id: "risk-analyst",
    name: "Risk Analyst",
    roleDescription: "regulatory and compliance questions",
    visibility: "public",
  },
  {
    id: "knowledge",
    name: "Knowledge",
    roleDescription: "company knowledge",
    visibility: "public",
  },
];

type Recorded = {
  eventType: string;
  targetId: string | null;
  payload: Record<string, unknown>;
};

function app(options: { routed?: string; undecided?: RoutingUndecided } = {}) {
  const written: Recorded[] = [];
  /** Every call the router was asked to make, so "never asked" is an assertion and not a hope. */
  const asked: string[] = [];

  const asActor: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { ...ACTOR });
    await next();
  };

  const store = {
    list: async () => ROSTER,
  } as unknown as AgentProfileStore;

  const router = {
    route: async (text: string) => {
      asked.push(text);
      const chosen = options.routed ?? "knowledge";
      return {
        agentId: chosen,
        name: ROSTER.find((a) => a.id === chosen)?.name ?? chosen,
        reason: "matches what it is for",
        fallback: options.undecided !== undefined,
        undecided: options.undecided ?? null,
      };
    },
  } as unknown as IntentRouter;

  const auditStore = {
    insert: async (event: Recorded) => {
      written.push(event);
    },
  } as unknown as AuditStore;

  const server = new Hono<{ Variables: AppVariables }>();
  server.route(
    "/api/route",
    createRoutingRoutes(store, router, asActor, auditStore),
  );
  return { server, written, asked };
}

async function post(
  server: Hono<{ Variables: AppVariables }>,
  body: unknown,
): Promise<Response> {
  return server.request("/api/route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("recording which coworker a message went to", () => {
  test("a named coworker is recorded as the person's own choice", async () => {
    const { server, written } = app();

    const response = await post(server, {
      text: "what is the SAR filing deadline",
      agentId: "risk-analyst",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      agentId: "risk-analyst",
      name: "Risk Analyst",
      viaMention: true,
      fallback: false,
    });

    expect(written).toHaveLength(1);
    expect(written[0]?.eventType).toBe("channel.routed");
    expect(written[0]?.targetId).toBe("risk-analyst");
    expect(written[0]?.payload).toMatchObject({
      chosen: "risk-analyst",
      viaMention: true,
      fallback: false,
    });
    // Third person: an administrator reading this row is not the person who chose.
    expect(written[0]?.payload.reason).toBe("named by the person asking");
  });

  test("naming a coworker never asks the model", async () => {
    // The person already decided. A model call here would be spend and latency for a question with
    // an answer, and a chance to disagree with it.
    const { server, asked } = app();

    await post(server, { text: "anything", agentId: "risk-analyst" });

    expect(asked).toEqual([]);
  });

  test("an inferred choice is still recorded as inferred", async () => {
    const { server, written, asked } = app({ routed: "knowledge" });

    const response = await post(server, { text: "what is our PTO policy" });

    expect(await response.json()).toMatchObject({
      agentId: "knowledge",
      viaMention: false,
    });
    expect(asked).toEqual(["what is our PTO policy"]);
    expect(written[0]?.payload).toMatchObject({
      chosen: "knowledge",
      viaMention: false,
    });
  });

  test("a coworker who is not on the roster is refused, not redirected", async () => {
    /*
     * The dangerous answer is the quiet one. Turning a name the person typed by hand into somebody
     * else, because the first was not reachable, sends their message to a coworker they did not
     * choose and says nothing. Refusing is worse for that one request and better for everything.
     */
    const { server, written } = app();

    const response = await post(server, {
      text: "hello",
      agentId: "not-on-the-roster",
    });

    expect(response.status).toBe(404);
    expect(written).toEqual([]);
  });

  test("a blank agentId is a message with no mention, not a broken one", async () => {
    // The composer sends the field only when the draft named somebody, but a caller that sends it
    // empty means the same thing and must not be answered with a 404.
    const { server, asked } = app();

    const response = await post(server, { text: "hello", agentId: "   " });

    expect(response.status).toBe(200);
    expect(asked).toEqual(["hello"]);
  });
});

/**
 * Why it was not decided, on the row rather than only in the sentence.
 *
 * The reason is prose for a person. This is the field a deployment counts, and counting is the point:
 * a router that has been unreachable for a week is invisible until somebody can ask how often.
 */
describe("recording why a message was not routed", () => {
  test("an unreachable router is on the row, not only in the sentence", async () => {
    const { server, written } = app({ undecided: "unreachable" });

    await post(server, { text: "what is our PTO policy" });

    expect(written[0]?.payload).toMatchObject({
      chosen: "knowledge",
      fallback: true,
      undecided: "unreachable",
    });
  });

  test("a decided routing records no cause", async () => {
    const { server, written } = app();

    await post(server, { text: "what is our PTO policy" });

    expect(written[0]?.payload).toMatchObject({
      fallback: false,
      undecided: null,
    });
  });

  test("a coworker the person named records no cause either", async () => {
    // Nothing was left to the router, so there is nothing about it to have failed. Recording a cause
    // here would count a person's own choice as a routing failure.
    const { server, written } = app();

    await post(server, { text: "hello", agentId: "risk-analyst" });

    expect(written[0]?.payload).toMatchObject({
      viaMention: true,
      undecided: null,
    });
  });
});

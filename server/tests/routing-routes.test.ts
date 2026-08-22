import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import type { IntentRouter } from "../src/routing/classify";
import { createRoutingRoutes } from "../src/routing/routes";

/**
 * The `/api/route` decision, and the row it leaves behind.
 *
 * `channel.routed` carried a `viaMention` field hardcoded `false`, because choosing a coworker with
 * `@` short-circuited the router and wrote no row at all. So the trail answered "why did this go
 * here" for model-chosen conversations and was silent for mentioned ones — indistinguishable from a
 * row that failed to write. The mention now goes through here too, and these tests hold the line on
 * both shapes: a model choice, and a mention that is honoured as-is and recorded as `viaMention`.
 */

const ACTOR = {
  id: "u1",
  email: "member@openbot.test",
  name: "Dana Reader",
  role: "user",
} as const;

const ROSTER = [
  {
    id: "knowledge",
    name: "Knowledge",
    roleDescription: "Docs",
    visibility: "public",
  },
  {
    id: "risk-analyst",
    name: "Risk Analyst",
    roleDescription: "Risk",
    visibility: "public",
  },
];

function harness(overrides: { route?: IntentRouter["route"] } = {}) {
  const rows: AuditEventInput[] = [];
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };

  const store = {
    list: async () => ROSTER,
  } as unknown as AgentProfileStore;

  const router = {
    route:
      overrides.route ??
      (async () => ({
        agentId: "knowledge",
        name: "Knowledge",
        reason: "matches Knowledge",
        fallback: true,
      })),
  } as unknown as IntentRouter;

  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", ACTOR as never);
    await next();
  };

  const routes = createRoutingRoutes(store, router, requireUser, auditStore);
  return { rows, hono: new Hono().route("/api/route", routes) };
}

const post = (body: unknown) =>
  new Request("http://test/api/route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/route", () => {
  test("a message with no @ is routed by the model and recorded viaMention=false", async () => {
    const { rows, hono } = harness();

    const response = await hono.request(post({ text: "help with the docs" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      agentId: "knowledge",
      name: "Knowledge",
      reason: "matches Knowledge",
      fallback: true,
    });

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.eventType).toBe("channel.routed");
    expect(row.targetId).toBe("knowledge");
    expect(row.actorUserId).toBe("u1");
    expect(row.payload).toMatchObject({
      chosen: "knowledge",
      viaMention: false,
      fallback: true,
      candidates: ["knowledge", "risk-analyst"],
    });
  });

  test("an @-named coworker is honoured as-is and recorded viaMention=true, no model call", async () => {
    let modelCalled = false;
    const { rows, hono } = harness({
      route: async () => {
        modelCalled = true;
        return {
          agentId: "knowledge",
          name: "Knowledge",
          reason: "should not run",
          fallback: true,
        };
      },
    });

    const response = await hono.request(
      post({ text: "look at this exposure", agentId: "risk-analyst" }),
    );
    expect(response.status).toBe(200);
    const decision = await response.json();
    expect(decision.agentId).toBe("risk-analyst");
    expect(decision.name).toBe("Risk Analyst");
    expect(decision.fallback).toBe(false);
    expect(modelCalled).toBe(false);

    expect(rows).toHaveLength(1);
    expect(rows[0].targetId).toBe("risk-analyst");
    expect(rows[0].payload).toMatchObject({
      chosen: "risk-analyst",
      viaMention: true,
      fallback: false,
      candidates: ["knowledge", "risk-analyst"],
    });
    // The person is the reason, so the trail can say who named the coworker.
    expect(rows[0].payload.reason).toContain("Dana Reader");
  });

  test("an @ naming a coworker off the roster falls through to model routing, never honoured blind", async () => {
    const { rows, hono } = harness();

    const response = await hono.request(
      post({ text: "help", agentId: "not-on-roster" }),
    );
    expect(response.status).toBe(200);
    // The unreachable id is ignored; the model picks and the row says viaMention=false.
    expect((await response.json()).agentId).toBe("knowledge");
    expect(rows[0].payload).toMatchObject({ viaMention: false });
  });

  test("an empty message is rejected before any routing", async () => {
    const { rows, hono } = harness();
    const response = await hono.request(post({ text: "   " }));
    expect(response.status).toBe(400);
    expect(rows).toHaveLength(0);
  });
});

import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { AgentProfile } from "../src/agents/profile-types";
import { createAgentRoutes } from "../src/agents/routes";
import type { AppVariables } from "../src/auth/guards";

/**
 * A Bot that runs on a server of its own is sent every conversation it is in, and the run assertion
 * that lets it call tools as the person. Opening one to everybody is an administrator's decision.
 */

const MANAGED = "http://agent-bot:4200/ag-ui";

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "agent-1",
    name: "Sales",
    title: "Sales assistant",
    roleDescription: "Helps with sales questions.",
    avatarSeed: "sales",
    visibility: "private",
    ownerUserId: "user-1",
    systemOwned: false,
    hidden: false,
    pinned: false,
    deletedAt: null,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    isolated: false,
    ...overrides,
  };
}

function signedIn(
  role: "admin" | "user",
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", { id: "user-1", email: "p@openbot.test", role });
    await next();
  };
}

function appFor(role: "admin" | "user", stored: Partial<AgentProfile> = {}) {
  const written: string[] = [];
  const store = {
    async get(_actor: unknown, id: string) {
      return profile({ id, ...stored });
    },
    async create(_actor: unknown, input: Partial<AgentProfile>) {
      written.push("create");
      return profile({ ...input });
    },
    async update(_actor: unknown, id: string, input: Partial<AgentProfile>) {
      written.push("update");
      return profile({ id, ...stored, ...input });
    },
  } as unknown as AgentProfileStore;
  const app = new Hono<{ Variables: AppVariables }>().route(
    "/",
    createAgentRoutes(
      store,
      signedIn(role),
      false,
      undefined,
      new Set(),
      undefined,
      false,
      MANAGED,
    ),
  );
  return { app, written };
}

const body = (input: Record<string, unknown>) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    name: "Sales",
    title: "Sales assistant",
    roleDescription: "Helps with sales questions.",
    ...input,
  }),
});

describe("a public Bot on a server of its own", () => {
  test("a member cannot create one", async () => {
    const { app, written } = appFor("user");
    const response = await app.request("http://t/", {
      method: "POST",
      ...body({
        visibility: "public",
        endpoint: "https://agents.example.com/ag-ui",
      }),
    });
    expect(response.status).toBe(403);
    expect(written).toEqual([]);
  });

  test("a member cannot make their remote Bot public", async () => {
    const { app, written } = appFor("user", {
      endpoint: "https://agents.example.com/ag-ui",
    });
    const response = await app.request("http://t/agent-1", {
      method: "PATCH",
      ...body({ visibility: "public" }),
    });
    expect(response.status).toBe(403);
    expect(written).toEqual([]);
  });

  test("a member may still create a private one", async () => {
    const { app, written } = appFor("user");
    const response = await app.request("http://t/", {
      method: "POST",
      ...body({
        visibility: "private",
        endpoint: "https://agents.example.com/ag-ui",
      }),
    });
    expect(response.status).toBe(201);
    expect(written).toEqual(["create"]);
  });

  test("an admin may create one", async () => {
    const { app } = appFor("admin");
    const response = await app.request("http://t/", {
      method: "POST",
      ...body({
        visibility: "public",
        endpoint: "https://agents.example.com/ag-ui",
      }),
    });
    expect(response.status).toBe(201);
  });

  test("a member may make public a Bot that runs on this deployment", async () => {
    const { app } = appFor("user", { endpoint: MANAGED });
    const response = await app.request("http://t/agent-1", {
      method: "PATCH",
      ...body({ visibility: "public" }),
    });
    expect(response.status).toBe(200);
  });
});

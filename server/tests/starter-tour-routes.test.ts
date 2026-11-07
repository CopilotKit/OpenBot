import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createChannelRoutes, type ChannelStore } from "../src/channels/routes";

function fixture(failCreate = false, failClaim = false) {
  const claims: [string, string][] = [];
  const channel = {
    id: "new-channel",
    name: "Starter",
    agentIds: ["picked-harness"],
    threadId: "thread",
    active: true,
    lastMessageAt: null,
  };
  const store = {
    async create(_actor: unknown, agentIds: string[]) {
      if (failCreate) throw new Error("create failed");
      return { ...channel, agentIds };
    },
    async get() {
      return channel;
    },
    async workIn() {
      return new Map();
    },
  } as unknown as ChannelStore;
  const app = new Hono<{ Variables: AppVariables }>().route(
    "/",
    createChannelRoutes(
      store,
      async (context, next) => {
        context.set("actor", {
          id: "alice",
          email: "alice@example.com",
          role: "user",
        });
        await next();
      },
      undefined,
      undefined,
      {
        async claimStarterTour(userId, channelId) {
          if (failClaim) throw new Error("claim failed");
          claims.push([userId, channelId]);
        },
      },
    ),
  );
  return { app, claims };
}

function create(agentIds: readonly string[]) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentIds }),
  };
}

test.each(["picked-harness", "personal-assistant"])(
  "new single starter %s claims for the authenticated account",
  async (id) => {
    const { app, claims } = fixture();
    expect((await app.request("/", create([id]))).status).toBe(201);
    expect(claims).toEqual([["alice", "new-channel"]]);
  },
);

test.each([
  { ids: ["other"] },
  { ids: ["picked-harness", "personal-assistant"] },
  { ids: ["picked-harness", "other"] },
])("unrelated and group conversations do not claim: %j", async ({ ids }) => {
  const { app, claims } = fixture();
  expect((await app.request("/", create(ids))).status).toBe(201);
  expect(claims).toEqual([]);
});

test("reading an existing starter conversation does not consume the tour", async () => {
  const { app, claims } = fixture();
  expect((await app.request("/old-channel")).status).toBe(200);
  expect(claims).toEqual([]);
});

test("failed creation cannot consume the tour", async () => {
  const { app, claims } = fixture(true);
  expect((await app.request("/", create(["picked-harness"]))).status).toBe(500);
  expect(claims).toEqual([]);
});

test("a claim failure is logged without reporting successful creation as failed", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const { app } = fixture(false, true);
    expect((await app.request("/", create(["picked-harness"]))).status).toBe(
      201,
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("starter-tour-claim-failed"),
    );
  } finally {
    log.mockRestore();
  }
});

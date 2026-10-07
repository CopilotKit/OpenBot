import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { SharedUseStore } from "../src/plugins/shared-use-store";
import type { ResponsibilityEngine } from "../src/responsibilities/engine";
import { createResponsibilityRoutes } from "../src/responsibilities/routes";
import type {
  TriggerRecord,
  TriggerStore,
} from "../src/responsibilities/triggers";
import type { ResponsibilityStore } from "../src/responsibilities/types";

const trigger: TriggerRecord = {
  id: "trig1",
  responsibilityId: "goal1",
  kind: "email",
  config: { kind: "email", allowedSenders: [], filter: { eventTypes: [] } },
  hasSecret: false,
  enabled: true,
  createdAt: new Date("2026-10-07T00:00:00.000Z"),
  updatedAt: new Date("2026-10-07T00:00:00.000Z"),
};

const store = {} as unknown as ResponsibilityStore;
const engine = { ingest: async () => ({}) } as unknown as Pick<
  ResponsibilityEngine,
  "ingest"
>;
const triggers = {
  store: {
    create: async () => ({ trigger, secret: null }),
  } as unknown as TriggerStore,
};
const sharedUse = {
  botForResponsibility: async () => "bot1",
  shortfall: async () => [{ serverId: "gh", title: "Team GitHub" }],
} as unknown as SharedUseStore;

function as(role: "admin" | "user", id: string) {
  const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id, email: `${id}@example.test`, role } as never);
    await next();
  };
  return new Hono().route(
    "/api/responsibilities",
    createResponsibilityRoutes(
      store,
      engine,
      signedIn,
      undefined,
      triggers,
      sharedUse,
    ),
  );
}

describe("responsibilities and shared accounts", () => {
  test("responsibilities: adding an email trigger to a Bot that uses a shared app says what needs approval", async () => {
    const response = await as("user", "u1").request(
      "/api/responsibilities/goal1/triggers",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          config: { kind: "email", allowedSenders: [] },
        }),
      },
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      sharedApps: { needsApproval: { serverId: string; title: string }[] };
    };
    expect(body.sharedApps.needsApproval).toEqual([
      { serverId: "gh", title: "Team GitHub" },
    ]);
  });
});

import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { personSeat } from "../src/computer/computer-key";
import type { ComputerGateway } from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";

/**
 * The fleet is a fact about the deployment, not about a Bot. This is the same bug as the boundary
 * one in computer-policy-route.test.ts, a second time.
 *
 * Admin listed the fleet by calling `/:botId/computers` with a placeholder id, on the reasoning that
 * the endpoint answers with every computer whatever the path says. True when it was written. Then
 * the bot-access middleware arrived, the placeholder was not a Bot, `canUseBot` said so, and
 * `/admin/computers` answered 404 for everybody including an administrator. The screen renders
 * nothing at all while the list is null, so it did not even look broken: it looked like a
 * deployment with no computers, while two containers were running.
 *
 * The middleware's own comment asked for this: "a second deployment-wide route added later should
 * have to think about this line." It was added later and did not. So the fleet has a route of its
 * own now, and this holds it there.
 *
 * Found by driving the screen against a deployment that had computers, not by reading the diff.
 */

const ADMIN = { id: "u1", email: "admin@openbot.test", role: "admin" } as const;

/** What the administrator's buttons reached, in order. */
let acted: unknown[] = [];

function app(role: "admin" | "user" = "admin") {
  const asActor: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { ...ADMIN, role });
    await next();
  };

  const gateway = {
    seatFor: async (botId: string, personId: string) =>
      personSeat(personId, botId),
    stopTarget: async (target: unknown) => {
      acted.push(["stop", target]);
      return { wasRunning: true };
    },
    resetTarget: async (target: unknown) => {
      acted.push(["reset", target]);
      return { cleared: true };
    },
    computers: async () => ({
      isolation: "per-person",
      computers: [
        { botId: "risk-analyst", running: true, startedAt: null },
        { botId: "general-assistant", running: false, startedAt: null },
      ],
    }),
  } as unknown as ComputerGateway;

  const policyStore = {
    get: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    set: async () => undefined,
  } as unknown as PolicyStore;

  const routes = createComputerRoutes(
    gateway,
    policyStore,
    asActor,
    // No Bot is reachable, which is the deployment the bug showed up in: listing the fleet must not
    // depend on the caller having access to a Bot that happens to share the collection's name.
    async () => false,
  );

  return new Hono<{ Variables: AppVariables }>().route(
    "/api/computers",
    routes,
  );
}

describe("listing every computer in the deployment", () => {
  test("an administrator gets the fleet, whatever Bots they can reach", async () => {
    const response = await app().request("http://t/api/computers/fleet");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      isolation: "per-person",
      computers: [{ botId: "risk-analyst" }, { botId: "general-assistant" }],
    });
  });

  test("it is still administrator-only", async () => {
    // The exemption is from the bot-access check, not from the admin check. The fleet names every
    // Bot in the deployment, which is exactly what a plain user must not be handed.
    const response = await app("user").request("http://t/api/computers/fleet");

    expect(response.status).toBe(403);
  });

  test("a Bot route is still gated", async () => {
    // One named path, not a hole.
    const response = await app().request(
      "http://t/api/computers/some-bot/status",
    );

    expect(response.status).toBe(404);
  });
});

/**
 * Stopping or resetting a computer from the list.
 *
 * Addressed by whose computer it is, because the one on the list is somebody else's: the Bot routes
 * act on the asker's own seat, so an administrator pressing Reset on Ada's computer through them
 * would have reset their own.
 */
describe("acting on a computer from the list", () => {
  const post = (body: unknown, role: "admin" | "user" = "admin") =>
    app(role).request("http://t/api/computers/fleet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("an administrator resets a person's whole computer by naming it", async () => {
    acted = [];
    const response = await post({ action: "reset", computer: "person:ada" });
    expect(response.status).toBe(200);
    expect(acted).toEqual([
      ["reset", { key: { kind: "person", personId: "ada" } }],
    ]);
  });

  test("one seat on the shared computer is named by its Bot as well", async () => {
    acted = [];
    await post({ action: "stop", computer: "person:ada", botId: "sales" });
    expect(acted).toEqual([
      ["stop", { key: { kind: "person", personId: "ada" }, botId: "sales" }],
    ]);
  });

  test("it is administrator-only, and refuses what is not a computer", async () => {
    acted = [];
    expect(
      (await post({ action: "reset", computer: "person:ada" }, "user")).status,
    ).toBe(403);
    expect((await post({ action: "reset", computer: "ada" })).status).toBe(400);
    expect(
      (await post({ action: "explode", computer: "person:ada" })).status,
    ).toBe(400);
    expect(acted).toEqual([]);
  });
});

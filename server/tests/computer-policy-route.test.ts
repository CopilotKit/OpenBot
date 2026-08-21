import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { PolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";

/**
 * The boundary is a fact about the deployment, not about a Bot.
 *
 * `/api/computers/policy` lives on the same router as the acting routes, which are all
 * `/:botId/...`. The bot-access middleware matches `/:botId/*`, and Hono matches `/*` against zero
 * segments, so `/policy` arrived at it as a Bot called "policy". `canUseBot` correctly answered that
 * there is no such Bot, and the Boundaries screen returned 404 for everybody including an
 * administrator: the whole surface for writing rules, gone, with a message about a Bot.
 *
 * Found by driving the screen rather than by reading the diff, which is the only way this was ever
 * going to turn up: every test of both features passed.
 */

const ADMIN = { id: "u1", email: "admin@openbot.test", role: "admin" } as const;

function app(role: "admin" | "user" = "admin") {
  const asActor: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { ...ADMIN, role });
    await next();
  };

  const policyStore = {
    get: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    set: async () => undefined,
  } as unknown as PolicyStore;

  const routes = createComputerRoutes(
    {} as never,
    policyStore,
    asActor,
    // Nothing is a usable Bot here, which is exactly the deployment where the bug showed: the policy
    // route must not depend on the caller having access to a Bot that happens to be named "policy".
    async () => false,
  );

  return new Hono<{ Variables: AppVariables }>().route(
    "/api/computers",
    routes,
  );
}

describe("reading and writing the deployment's boundary", () => {
  test("an administrator can read it, whatever Bots they can reach", async () => {
    const response = await app().request("http://t/api/computers/policy");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      policy: { mode: "enforce" },
    });
  });

  test("an administrator can write it", async () => {
    const response = await app().request("http://t/api/computers/policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "enforce", deny: [], allow: ["true"] }),
    });

    expect(response.status).toBeLessThan(300);
  });

  test("it is still administrator-only", async () => {
    // The exemption is from the bot-access check, not from the admin check. Letting a plain user
    // rewrite the boundary would be a far worse bug than the one being fixed.
    const response = await app("user").request(
      "http://t/api/computers/policy",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "enforce", deny: [], allow: [] }),
      },
    );

    expect(response.status).toBe(403);
  });

  test("a Bot route is still gated", async () => {
    // The exemption is one named path, not a hole. Everything else under this router still asks.
    const response = await app().request(
      "http://t/api/computers/some-bot/status",
    );

    expect(response.status).toBe(404);
  });
});

import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentProfileStore } from "../src/agents/profile-store";
import { createAgentRoutes } from "../src/agents/routes";
import type { AppVariables } from "../src/auth/guards";

/**
 * The page a remote agent's OAuth consent popup lands on.
 *
 * Its whole contract is to be inert: no session, no store, and above all no reflection — the
 * authorization code and state arrive in the query string, and the page must carry them to its
 * opener via its own `location` without the server ever printing them into markup.
 */

/** The route touches nothing, and a store that proves it by exploding is the cheapest fake. */
const untouchedStore = new Proxy({} as AgentProfileStore, {
  get(_target, property) {
    throw new Error(
      `The callback page must not touch the store (${String(property)}).`,
    );
  },
});

const noSession: MiddlewareHandler<{ Variables: AppVariables }> = async () => {
  throw new Error("The callback page must not require a session.");
};

function app() {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.route("/", createAgentRoutes(untouchedStore, noSession));
  return routes;
}

describe("the agent OAuth callback page", () => {
  test("answers without a session and without the store", async () => {
    const response = await app().request(
      "/oauth/callback?code=secret-code&state=xyz-123",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  test("reflects nothing from the query string", async () => {
    const marker = "<script>alert(1)</script>";
    const response = await app().request(
      `/oauth/callback?code=secret-code-value&state=${encodeURIComponent(marker)}`,
    );
    const page = await response.text();
    expect(page).not.toContain(marker);
    expect(page).not.toContain("secret-code-value");
  });

  test("posts to its opener, and only to its own origin", async () => {
    const page = await (await app().request("/oauth/callback?code=c")).text();
    expect(page).toContain("window.opener.postMessage");
    expect(page).toContain("openbot:agent-oauth-callback");
    // The origin argument is the page's own, never *: a foreign opener hears nothing.
    expect(page).toContain("window.location.origin");
    expect(page).not.toMatch(/postMessage\([^)]*"\*"/);
  });

  test("does not shadow fetching an agent by id", async () => {
    // "/:agentId" and "/oauth/callback" share a prefix; the static path must win only for itself.
    const routes = new Hono<{ Variables: AppVariables }>();
    const anyStore = {
      async get() {
        return null;
      },
    } as unknown as AgentProfileStore;
    const allowAnyone: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", {
        id: "user-1",
        email: "member@openbot.test",
        role: "user",
      });
      await next();
    };
    routes.route("/", createAgentRoutes(anyStore, allowAnyone));
    const response = await routes.request("/some-agent");
    expect(response.status).toBe(404);
  });
});

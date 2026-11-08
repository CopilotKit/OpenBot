import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { Edition } from "../src/edition";
import { createEditionGate } from "../src/edition-routes";
import { testEnvironment } from "./support/environment";

function appFor(edition: Edition) {
  const app = new Hono();
  app.use("*", createEditionGate(edition));
  app.all("*", (context) => context.text("reached"));
  return app;
}

const closed = [
  // No memory in the personal edition: OpenBot Desktop's local Intelligence isn't licensed for it.
  "/api/memory",
  "/api/memory/sources",
  "/api/memory/sources/available/expenses",
  "/api/memory/m1",
  "/api/admin/people",
  "/api/admin/people/abc/role",
  "/api/admin/identity-providers",
  "/api/admin/identity-providers/abc",
  "/api/admin/enterprise/settings/ssoRequired",
  "/api/admin/proactive",
  "/api/admin/learning",
  "/api/auth/scim/v2/Users",
  "/api/auth/sso/register",
  // Percent-encoded, as the router decodes it before matching a handler.
  "/api/admin/%70eople",
];

// What the pages that move to Settings call, and what every person uses.
const open = [
  "/api/admin/credentials",
  "/api/admin/audit-events",
  "/api/admin/package",
  "/api/admin/status",
  "/api/plugins",
  "/api/computers",
  "/api/components",
  "/api/approvals",
  "/api/auth/get-session",
  // What a person's own screens still read, under or beside a closed prefix.
  "/api/admin/enterprise/me",
  "/api/approvals/shared-use",
  "/api/groups",
  "/api/team-bots",
  // Prefixes, not substrings: a sibling that merely starts the same way stays open.
  "/api/admin/peoplex",
  "/api/memoryx",
];

describe("the personal edition", () => {
  test.each(closed)("closes %s", async (path) => {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      const response = await appFor("personal").request(path, { method });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
    }
  });

  test.each(open)("leaves %s open", async (path) => {
    expect((await appFor("personal").request(path)).status).toBe(200);
  });
});

describe("the app", () => {
  // Mounted ahead of the routes it closes, including the auth handler's SSO routes.
  test("a personal deployment answers 404 before any handler runs", async () => {
    const app = createApp(
      loadConfig(
        testEnvironment({
          GOOGLE_OAUTH_CLIENT_ID: undefined,
          GOOGLE_OAUTH_CLIENT_SECRET: undefined,
          BETTER_AUTH_SECRET: undefined,
          BETTER_AUTH_URL: undefined,
          INITIAL_ADMIN_EMAILS: undefined,
          OPENBOT_EDITION: "personal",
          OPENBOT_SINGLE_USER: "true",
          AGENT_COMPUTER_URL: "http://127.0.0.1:7000",
        }),
      ),
    );
    for (const path of ["/api/admin/people", "/api/auth/sso/register"]) {
      expect((await app.request(path, { method: "POST" })).status).toBe(404);
    }
  });
});

describe("the team edition", () => {
  test.each(closed)("leaves %s open", async (path) => {
    expect((await appFor("team").request(path)).status).toBe(200);
  });
});

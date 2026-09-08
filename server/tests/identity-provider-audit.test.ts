import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

const ADMIN = { id: "admin", email: "admin@openbot.test" };

function app(role = "admin") {
  const rows: AuditEventInput[] = [];
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };
  const hono = createApp(
    loadConfig(testEnvironment()),
    {
      /*
       * Reads the body, as the real sign-in library does. A handler that leaves the stream
       * untouched hides the ordering this depends on: a clone taken after the handler has run is of
       * a consumed request, and the row would name no provider.
       */
      handler: async (request: Request) => {
        await request.json().catch(() => null);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    { rolesForUser: async () => [role] },
    // Positions 4-12 are the other stores; auditStore is 13.
    ...(Array.from({ length: 9 }) as never[]),
    auditStore as never,
  );
  return { rows, hono };
}

const REGISTER_BODY = {
  providerId: "acme",
  issuer: "https://login.acme.test",
  domain: "acme.test",
};

describe("the trail says how an identity provider came to exist", () => {
  test("records the registration of an identity provider", async () => {
    const { rows, hono } = app();
    const response = await hono.request("/api/auth/sso/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(REGISTER_BODY),
    });
    expect(response.status).toBe(200);
    expect(rows.map((row) => row.eventType)).toContain(
      "identity_provider.registered",
    );
  });

  test("names who registered it and which provider", async () => {
    const { rows, hono } = app();
    await hono.request("/api/auth/sso/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(REGISTER_BODY),
    });
    const row = rows.find(
      (candidate) => candidate.eventType === "identity_provider.registered",
    );
    expect(row?.targetId).toBe("acme");
    expect(row?.actorUserId).toBe("admin");
  });

  test("records a removal made through the library's own endpoint", async () => {
    const { rows, hono } = app();
    await hono.request("/api/auth/sso/delete-provider", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "acme" }),
    });
    expect(rows.map((row) => row.eventType)).toContain(
      "identity_provider.removed",
    );
  });

  test("writes nothing when the library refuses the change", async () => {
    const rows: AuditEventInput[] = [];
    const hono = createApp(
      loadConfig(testEnvironment()),
      {
        handler: async (request: Request) => {
          await request.json().catch(() => null);
          return new Response("no", { status: 400 });
        },
        api: { getSession: async () => ({ user: ADMIN }) },
      } as never,
      { rolesForUser: async () => ["admin"] },
      ...(Array.from({ length: 9 }) as never[]),
      { insert: async (event) => void rows.push(event) } as never,
    );
    await hono.request("/api/auth/sso/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(REGISTER_BODY),
    });
    expect(rows).toEqual([]);
  });

  test("writes nothing when a non-administrator is refused", async () => {
    const { rows, hono } = app("user");
    const response = await hono.request("/api/auth/sso/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(REGISTER_BODY),
    });
    expect(response.status).toBe(403);
    expect(rows).toEqual([]);
  });
});

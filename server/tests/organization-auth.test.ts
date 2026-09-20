import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { electron } from "@better-auth/electron";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { Hono } from "hono";
import { desktopAuthPage } from "../src/auth/native-browser";
import { createOrganizationAuth } from "../src/auth/organization";
import {
  clearDesktopConnectionFailure,
  mountDesktopConnectionFailure,
} from "../src/desktop-connection-failure";

const employee = {
  id: "employee-1",
  email: "employee@example.com",
  name: "Employee",
  image: null,
  role: "user" as const,
};

test("missing local cookie requests focused refresh; transient authority failure and refused sign-out remain retryable", async () => {
  const authority = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 503 }),
  });
  const auth = createOrganizationAuth({
    authorityUrl: authority.url.origin,
    materializeUser: async (user) => user,
  });
  const app = new Hono();
  mountDesktopConnectionFailure(app, "fixture-host-token");
  const failure = async () =>
    (
      await app.request("/api/desktop/connection-failure", {
        headers: { "x-openbot-desktop-host-token": "fixture-host-token" },
      })
    ).json();
  try {
    clearDesktopConnectionFailure("organization");
    expect(await auth.api.getSession({ headers: new Headers() })).toBeNull();
    expect(await failure()).toEqual({
      connection: "organization",
      code: "organization_authentication_failed",
    });
    clearDesktopConnectionFailure("organization");
    const handoff = await auth.handler(
      new Request("http://localhost:3001/api/auth/organization/session", {
        method: "POST",
        headers: {
          origin: "http://localhost:3010",
          "content-type": "application/json",
        },
        body: JSON.stringify({ cookie: "better-auth.session_token=fixture" }),
      }),
    );
    expect(handoff.status).toBe(503);
    expect(await failure()).toBeNull();
    const cookie =
      "openbot.organization-session=" +
      Buffer.from(
        JSON.stringify({
          authority: authority.url.origin,
          cookie: "better-auth.session_token=fixture",
        }),
      ).toString("base64url");
    const signout = await auth.handler(
      new Request("http://localhost:3001/api/auth/sign-out", {
        method: "POST",
        headers: { origin: "http://localhost:3010", cookie },
      }),
    );
    expect(signout.status).toBe(503);
    expect(signout.headers.get("set-cookie")).toBeNull();
    expect(await failure()).toBeNull();
  } finally {
    clearDesktopConnectionFailure("organization");
    authority.stop(true);
  }
});

test("organization identity and current role come from the authority; expiry and revocation fail closed", async () => {
  let status = 200;
  let role: "admin" | "user" = "user";
  const saved: string[] = [];
  const authority = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(request.headers.get("cookie")).toBe(
        "better-auth.session_token=fixture-session",
      );
      expect(new URL(request.url).pathname).toBe("/api/me");
      return Response.json({ user: { ...employee, role } }, { status });
    },
  });
  try {
    const auth = createOrganizationAuth({
      authorityUrl: authority.url.origin,
      materializeUser: async (user) => {
        saved.push(user.id);
        return user;
      },
    });
    const start = await auth.handler(
      new Request("http://127.0.0.1:3010/api/auth/organization/session", {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:3010",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          cookie: "better-auth.session_token=fixture-session",
        }),
      }),
    );
    expect(start.status).toBe(200);
    const { ticket } = await start.json();
    const consume = () =>
      auth.handler(
        new Request(
          `http://127.0.0.1:3010/api/auth/organization/session?ticket=${ticket}`,
        ),
      );
    const response = await consume();
    expect(response.status).toBe(303);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect((await consume()).status).toBe(401);
    const headers = new Headers({ cookie: cookie ?? "" });
    expect(
      await auth.api.getSession({
        headers,
        query: { disableCookieCache: true },
      }),
    ).toEqual({ user: employee });
    role = "admin";
    expect(
      (
        await auth.api.getSession({
          headers,
          query: { disableCookieCache: true },
        })
      )?.user.role,
    ).toBe("admin");
    status = 401;
    expect(
      await auth.api.getSession({
        headers,
        query: { disableCookieCache: true },
      }),
    ).toBeNull();
    status = 403;
    expect(
      await auth.api.getSession({
        headers,
        query: { disableCookieCache: true },
      }),
    ).toBeNull();
    expect(saved).toContain(employee.id);
  } finally {
    authority.stop(true);
  }
});

test("organization sessions reject cross-origin delivery, malformed authority and authority redirects", async () => {
  expect(() =>
    createOrganizationAuth({
      authorityUrl: "http://customer.example",
      materializeUser: async (user) => user,
    }),
  ).toThrow();
  const authority = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.redirect("https://other.example/api/me"),
  });
  try {
    const auth = createOrganizationAuth({
      authorityUrl: authority.url.origin,
      materializeUser: async (user) => user,
    });
    const request = (origin: string) =>
      new Request("http://127.0.0.1:3010/api/auth/organization/session", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ cookie: "better-auth.session_token=fixture" }),
      });
    expect((await auth.handler(request("https://other.example"))).status).toBe(
      403,
    );
    expect((await auth.handler(request("http://127.0.0.1:3010"))).status).toBe(
      401,
    );
  } finally {
    authority.stop(true);
  }
});

describe("official Better Auth desktop exchange", () => {
  const origin = "http://localhost:39091";
  const auth = betterAuth({
    baseURL: origin,
    secret: "a-fixed-test-fixture-secret-at-least-32-characters",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    emailAndPassword: { enabled: true },
    plugins: [electron({ clientID: "openbot-desktop" })],
  });
  async function issue() {
    const signup = await auth.api.signUpEmail({
      body: {
        email: `employee-${crypto.randomUUID()}@example.com`,
        password: "test-fixture-password",
        name: "Employee",
      },
      asResponse: true,
    });
    const cookie = signup.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const verifier = "a".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const response = await auth.handler(
      new Request(
        `${origin}/api/auth/electron/transfer-user?client_id=openbot-desktop&state=fixture-state&code_challenge=${challenge}`,
        {
          method: "POST",
          headers: { origin, cookie, "content-type": "application/json" },
          body: "{}",
        },
      ),
    );
    expect(response.status).toBe(200);
    const { electron_authorization_code: token } = await response.json();
    return { token, state: "fixture-state", code_verifier: verifier };
  }
  const exchange = (body: {
    token: string;
    state: string;
    code_verifier: string;
  }) =>
    auth.handler(
      new Request(`${origin}/api/auth/electron/token`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  test("valid code creates a session once; replay is rejected", async () => {
    const grant = await issue();
    expect((await exchange(grant)).status).toBe(200);
    expect((await exchange(grant)).status).toBe(404);
  });
  test("wrong state and wrong verifier cannot create a session", async () => {
    expect(
      (await exchange({ ...(await issue()), state: "wrong" })).status,
    ).toBe(400);
    expect(
      (await exchange({ ...(await issue()), code_verifier: "b".repeat(43) }))
        .status,
    ).toBe(400);
  });
});

test.each(["google", "microsoft", "okta"])(
  "native browser handoff reuses configured %s provider",
  async (provider) => {
    const params = new URLSearchParams({
      provider,
      state: "fixture-state-long",
      code_challenge: "a".repeat(43),
      redirect_uri: "http://127.0.0.1:43123/organization-auth/callback",
    });
    const response = desktopAuthPage(
      new Request(`https://customer.example/api/auth/desktop?${params}`),
      ["google", "microsoft", "okta"],
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`"provider":"${provider}"`);
    expect(html).toContain("/api/auth/electron/transfer-user");
  },
);

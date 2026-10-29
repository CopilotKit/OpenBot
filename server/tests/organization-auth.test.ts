import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { electron } from "@better-auth/electron";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { Hono } from "hono";
import { desktopAuthPage } from "../src/auth/native-browser";
import {
  AuthorityUnavailable,
  createOrganizationAuth,
  organizationCookieExpiresAt,
  SIGN_OUT_UNFINISHED,
} from "../src/auth/organization";
import {
  clearDesktopConnectionFailure,
  mountDesktopConnectionFailure,
} from "../src/desktop-connection-failure";

// The native status store is process-wide and survives between test files.
const clearOrganizationFailure = () =>
  clearDesktopConnectionFailure("organization");
beforeEach(clearOrganizationFailure);
afterEach(clearOrganizationFailure);

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

test("signing out ends the person's Recorders first, and does not sign out when they could not be ended", async () => {
  const happened: string[] = [];
  const authority = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/me") return Response.json({ user: employee });
      if (path === "/api/auth/sign-out") {
        happened.push("organization signed out");
        return Response.json({ success: true });
      }
      return new Response(null, { status: 404 });
    },
  });
  const app = "http://127.0.0.1:3010";
  const signOut = async (
    signOutRecorders: (userId: string, ending: string) => Promise<void>,
  ) => {
    const auth = createOrganizationAuth({
      authorityUrl: authority.url.origin,
      materializeUser: async (user) => user,
      signOutRecorders,
    });
    const start = await auth.handler(
      new Request(`${app}/api/auth/organization/session`, {
        method: "POST",
        headers: { origin: app, "content-type": "application/json" },
        body: JSON.stringify({
          cookie: "better-auth.session_token=fixture-session",
        }),
      }),
    );
    const { ticket } = await start.json();
    const consumed = await auth.handler(
      new Request(`${app}/api/auth/organization/session?ticket=${ticket}`),
    );
    const cookie = consumed.headers.get("set-cookie")?.split(";")[0] ?? "";
    return auth.handler(
      new Request(`${app}/api/auth/sign-out`, {
        method: "POST",
        headers: { origin: app, cookie },
      }),
    );
  };
  try {
    const signedOut = await signOut(async (userId, ending) => {
      happened.push(`Recorders of ${userId} ended by ${ending}`);
    });
    expect(signedOut.status).toBe(200);
    expect(signedOut.headers.get("set-cookie")).toContain("Max-Age=0");
    // The Recorders before the organization's session: never a sign-out answered with a Recorder still signed in.
    expect(happened).toEqual([
      `Recorders of ${employee.id} ended by organization-sign-out`,
      "organization signed out",
    ]);

    // When they could not be ended, nothing is: the organization's session and the cookie stay, and the person is told.
    happened.length = 0;
    const refused = await signOut(async () => {
      throw new Error("the database is unavailable");
    });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: SIGN_OUT_UNFINISHED });
    expect(refused.headers.get("set-cookie")).toBeNull();
    expect(happened).toEqual([]);
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

describe("quiet verification of a forwarded cookie", () => {
  let status = 200;
  let body: unknown = null;
  let authority: ReturnType<typeof Bun.serve>;
  let auth: ReturnType<typeof createOrganizationAuth>;
  let cookieHeader: string;
  const materialized: string[] = [];

  beforeEach(() => {
    status = 200;
    body = null;
    materialized.length = 0;
    authority = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        status === 302
          ? new Response(null, {
              status,
              headers: { location: "https://elsewhere.example.test/" },
            })
          : status === 200
            ? Response.json(body)
            : new Response("answer", { status }),
    });
    auth = createOrganizationAuth({
      authorityUrl: authority.url.origin,
      // The local store upserts by email and can answer with its own id.
      materializeUser: async (user) => {
        materialized.push(user.id);
        return { ...user, id: `local-${user.id}` };
      },
    });
    const value = Buffer.from(
      JSON.stringify({
        authority: authority.url.origin,
        cookie: "better-auth.session_token=abc",
      }),
    ).toString("base64url");
    cookieHeader = `openbot.organization-session=${value}`;
  });
  afterEach(() => {
    authority.stop(true);
  });

  test.each([400, 404, 408, 429, 302])(
    "an authority answering %d is unavailable, never a sign-out",
    async (answer) => {
      status = answer;
      await expect(
        auth.verifySessionQuietly(cookieHeader),
      ).rejects.toBeInstanceOf(AuthorityUnavailable);
    },
  );

  test("a 2xx whose body is not an actor is unavailable", async () => {
    body = { user: null };
    await expect(
      auth.verifySessionQuietly(cookieHeader),
    ).rejects.toBeInstanceOf(AuthorityUnavailable);
  });

  test.each([401, 403])(
    "a %d from the authority is a sign-out",
    async (answer) => {
      status = answer;
      expect(await auth.verifySessionQuietly(cookieHeader)).toBeNull();
    },
  );

  test("a malformed cookie is a sign-out", async () => {
    expect(
      await auth.verifySessionQuietly("openbot.organization-session=x"),
    ).toBeNull();
  });

  test("a valid actor comes back as the local user", async () => {
    body = { user: employee };
    const user = await auth.verifySessionQuietly(cookieHeader);
    expect(user?.id).toBe("local-employee-1");
    expect(materialized).toEqual(["employee-1"]);
  });
});

describe("the organization session cookie's own expiry", () => {
  const record = (fields: Record<string, unknown>) =>
    Buffer.from(
      JSON.stringify({
        authority: "http://127.0.0.1:1",
        cookie: "better-auth.session_token=fixture",
        ...fields,
      }),
    ).toString("base64url");
  const now = Date.parse("2026-10-28T12:00:00.000Z");
  const week = 7 * 24 * 60 * 60_000;

  test("is the expiry the cookie carries, never later than its Max-Age from now", () => {
    const inTwoDays = now + 2 * 24 * 60 * 60_000;
    expect(
      organizationCookieExpiresAt(record({ expiresAt: inTwoDays }), now),
    ).toEqual(new Date(inTwoDays));
    // The record is the browser's to edit: a later expiry than any cookie set now could have is not believed.
    expect(
      organizationCookieExpiresAt(record({ expiresAt: now + 10 * week }), now),
    ).toEqual(new Date(now + week));
    // A cookie set before the expiry was written into it lasts no longer than one set now would.
    expect(organizationCookieExpiresAt(record({}), now)).toEqual(
      new Date(now + week),
    );
  });

  test("the handoff writes it into the cookie, and a cookie past it signs nobody in", async () => {
    const authority = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ user: employee }),
    });
    try {
      const auth = createOrganizationAuth({
        authorityUrl: authority.url.origin,
        materializeUser: async (user) => user,
      });
      const app = "http://127.0.0.1:3010";
      const start = await auth.handler(
        new Request(`${app}/api/auth/organization/session`, {
          method: "POST",
          headers: { origin: app, "content-type": "application/json" },
          body: JSON.stringify({
            cookie: "better-auth.session_token=fixture-session",
          }),
        }),
      );
      const { ticket } = await start.json();
      const issuedAt = Date.now();
      const consumed = await auth.handler(
        new Request(`${app}/api/auth/organization/session?ticket=${ticket}`),
      );
      const [cookie = ""] = (consumed.headers.get("set-cookie") ?? "").split(
        ";",
      );
      const value = cookie.slice("openbot.organization-session=".length);
      const written = JSON.parse(
        Buffer.from(value, "base64url").toString(),
      ) as { expiresAt: number };
      expect(written.expiresAt).toBeGreaterThanOrEqual(issuedAt + week);
      expect(written.expiresAt).toBeLessThanOrEqual(Date.now() + week);
      const session = (cookieValue: string) =>
        auth.api.getSession({
          headers: new Headers({
            cookie: `openbot.organization-session=${cookieValue}`,
          }),
          query: { disableCookieCache: true },
        });
      expect((await session(value))?.user.id).toBe(employee.id);
      const expired = Buffer.from(
        JSON.stringify({
          ...JSON.parse(Buffer.from(value, "base64url").toString()),
          expiresAt: Date.now() - 1,
        }),
      ).toString("base64url");
      expect(await session(expired)).toBeNull();
    } finally {
      authority.stop(true);
    }
  });
});

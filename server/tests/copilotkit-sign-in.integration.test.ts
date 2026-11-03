import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { COPILOTKIT_SESSION_SECONDS, createAuth } from "../src/auth";
import { setRole } from "../src/auth/roles";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { accounts, sessions, userRoles, users } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Signing in through a CopilotKit organization, through the real routes: Better Auth's handler, the
 * real database, and the configuration loaded from environment variables the way a deployment does.
 *
 * CopilotKit's Ops API is the one stand-in, and it holds to the real one's contract
 * (`POST /internal/openbot/handoffs/exchange` in the Intelligence repo): the token header, one use
 * per code, the code bound to the exact callback URL it was issued for, the success body (the
 * managed handoff exchange plus `organizationRole`), and the error envelope and statuses Ops sends:
 * 401 HANDOFF_INVALID, 409 HANDOFF_REPLAYED, 403 HANDOFF_MEMBERSHIP_REVOKED, 401
 * INTERNAL_AUTH_REQUIRED.
 */

const ORGANIZATION = { id: "org_acme", slug: "acme", name: "Acme" };
const OTHER = { id: "org_other", slug: "other", name: "Other Co" };
const OPS_TOKEN = "openbot-ops-token-0123456789abcdef";
const APP_URL = "http://127.0.0.1:3010";
const AUTH_URL = "http://127.0.0.1:3001";

type Issued = {
  subjectId: string;
  email: string;
  organization: { id: string; slug: string; name: string };
  targetUrl: string;
  consumed: boolean;
};

/** A stand-in for CopilotKit's Ops API, keeping its contract. See the note at the top. */
function startOps() {
  const codes = new Map<string, Issued>();
  const roles = new Map<string, string>();
  const opsError = (status: number, code: string, message: string) =>
    Response.json(
      {
        error: { code, message, category: "auth", retryable: false },
        requestId: randomUUID(),
        traceId: randomBytes(16).toString("hex"),
      },
      { status },
    );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (
        request.method !== "POST" ||
        url.pathname !== "/internal/openbot/handoffs/exchange"
      )
        return new Response("Not found", { status: 404 });
      if (request.headers.get("x-ops-internal-token") !== OPS_TOKEN)
        return opsError(
          401,
          "INTERNAL_AUTH_REQUIRED",
          "A valid internal service token is required.",
        );
      const body = (await request.json()) as {
        code: string;
        targetUrl: string;
      };
      const issued = codes.get(body.code);
      if (!issued || issued.targetUrl !== body.targetUrl)
        return opsError(401, "HANDOFF_INVALID", "The handoff code is invalid.");
      if (issued.consumed)
        return opsError(
          409,
          "HANDOFF_REPLAYED",
          "The handoff code has already been consumed.",
        );
      const role = roles.get(`${issued.organization.id}:${issued.subjectId}`);
      if (!role)
        return opsError(
          403,
          "HANDOFF_MEMBERSHIP_REVOKED",
          "The person is no longer a member of the handoff organization.",
        );
      issued.consumed = true;
      const now = new Date();
      return Response.json({
        handoffId: randomUUID(),
        subjectId: issued.subjectId,
        clerkOrganizationId: issued.organization.id,
        clerkOrganization: issued.organization,
        actor: {
          subjectId: issued.subjectId,
          email: issued.email,
          displayName: "Test Person",
          avatarUrl: "https://img.clerk.com/test",
        },
        entitlement: null,
        destinationApp: "openbot",
        targetUrl: issued.targetUrl,
        returnToUrl: null,
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        consumedAt: now.toISOString(),
        organizationRole: role,
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    /** What the CopilotKit dashboard does once the person has signed in there. */
    issue(input: Omit<Issued, "consumed">) {
      const code = randomBytes(32).toString("hex");
      codes.set(code, { ...input, consumed: false });
      return code;
    },
    member(organizationId: string, subjectId: string, role: string | null) {
      const key = `${organizationId}:${subjectId}`;
      if (role) roles.set(key, role);
      else roles.delete(key);
    },
    stop: () => server.stop(true),
  };
}

const ops = startOps();
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const revoked = new Set<string>();
let auth: ReturnType<typeof createAuth>;

beforeAll(() => {
  const config = loadConfig({
    DATABASE_URL: testDatabaseUrl(),
    KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    BETTER_AUTH_SECRET: "a-long-enough-local-development-auth-secret",
    BETTER_AUTH_URL: AUTH_URL,
    TRUSTED_ORIGINS: APP_URL,
    INTELLIGENCE_API_URL: "http://127.0.0.1:7100",
    INTELLIGENCE_GATEWAY_WS_URL: "ws://127.0.0.1:7103",
    INTELLIGENCE_API_KEY: "tenant-api-key",
    COPILOTKIT_ORGANIZATION_ID: ORGANIZATION.id,
    COPILOTKIT_DASHBOARD_URL: "http://127.0.0.1:7066",
    COPILOTKIT_OPS_API_URL: ops.url,
    COPILOTKIT_OPS_API_TOKEN: OPS_TOKEN,
  });
  auth = createAuth(config, database, async (email) => revoked.has(email));
});

afterAll(async () => {
  ops.stop();
  await database.$client.end({ timeout: 5 });
});

/** The `name=value` pairs a response set, ready to send back as a Cookie header. */
function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .filter((pair) => !pair?.endsWith("="))
    .join("; ");
}

/** Press "Continue with CopilotKit": the redirect to CopilotKit and the state cookie it set. */
async function start() {
  const response = await auth.handler(
    new Request(`${AUTH_URL}/api/auth/copilotkit/start`),
  );
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  expect(`${location.origin}${location.pathname}`).toBe(
    "http://127.0.0.1:7066/intelligence/handoff",
  );
  expect(location.searchParams.get("destinationApp")).toBe("openbot");
  const targetUrl = location.searchParams.get("targetUrl") ?? "";
  expect(targetUrl).toStartWith(
    `${AUTH_URL}/api/auth/copilotkit/callback?state=`,
  );
  return { targetUrl, cookie: cookiesFrom(response) };
}

/** CopilotKit sends the browser back with a code, as `buildRedirectUrl` in Ops does. */
async function callback(targetUrl: string, code: string, cookie: string) {
  const url = new URL(targetUrl);
  url.searchParams.set("handoffCode", code);
  return auth.handler(new Request(url, { headers: { cookie } }));
}

/** A person's whole sign-in, start to finish, as one browser. */
async function signIn(person: {
  subjectId: string;
  email: string;
  organization?: typeof ORGANIZATION;
}) {
  const { targetUrl, cookie } = await start();
  const code = ops.issue({
    subjectId: person.subjectId,
    email: person.email,
    organization: person.organization ?? ORGANIZATION,
    targetUrl,
  });
  const response = await callback(targetUrl, code, cookie);
  return { response, code, targetUrl, cookie };
}

function person() {
  const id = randomUUID().slice(0, 8);
  return {
    subjectId: `user_${id}`,
    email: `person-${id}@acme.example.test`,
  };
}

async function roleOf(email: string) {
  const [user] = await database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email));
  if (!user) return undefined;
  const rows = await database
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, user.id));
  return rows.map((row) => row.role).sort();
}

async function sessionFor(response: Response) {
  return auth.api.getSession({
    headers: new Headers({ cookie: cookiesFrom(response) }),
    query: { disableCookieCache: true },
  });
}

test("an admin of the bound organization signs in as an OpenBot admin", async () => {
  const admin = person();
  ops.member(ORGANIZATION.id, admin.subjectId, "org:admin");

  const { response } = await signIn(admin);

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(`${APP_URL}/`);
  const session = await sessionFor(response);
  expect(session?.user.email).toBe(admin.email);
  expect(await roleOf(admin.email)).toEqual(["admin"]);
  const [account] = await database
    .select({ providerId: accounts.providerId, issuer: accounts.issuer })
    .from(accounts)
    .where(
      and(
        eq(accounts.accountId, admin.subjectId),
        eq(accounts.providerId, "copilotkit"),
      ),
    );
  expect(account).toEqual({ providerId: "copilotkit", issuer: ops.url });
});

test("a plain member of the bound organization signs in as a user", async () => {
  const member = person();
  ops.member(ORGANIZATION.id, member.subjectId, "org:member");

  const { response } = await signIn(member);

  expect(response.headers.get("location")).toBe(`${APP_URL}/`);
  expect((await sessionFor(response))?.user.email).toBe(member.email);
  expect(await roleOf(member.email)).toEqual(["user"]);
});

test("a member of another organization is refused and nothing is written for them", async () => {
  const outsider = { ...person(), organization: OTHER };
  ops.member(OTHER.id, outsider.subjectId, "org:admin");

  const { response } = await signIn(outsider);

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(
    `${APP_URL}/sign?error=copilotkit_other_organization`,
  );
  expect(await sessionFor(response)).toBeNull();
  expect(await roleOf(outsider.email)).toBeUndefined();
});

test("a code already used is refused, and the second browser gets no session", async () => {
  const member = person();
  ops.member(ORGANIZATION.id, member.subjectId, "org:member");
  const first = await signIn(member);
  expect(first.response.headers.get("location")).toBe(`${APP_URL}/`);

  const replayed = await callback(first.targetUrl, first.code, first.cookie);

  expect(replayed.headers.get("location")).toBe(
    `${APP_URL}/sign?error=copilotkit_expired`,
  );
  expect(await sessionFor(replayed)).toBeNull();
});

test("a code without the state cookie of the browser that asked for it is refused", async () => {
  const member = person();
  ops.member(ORGANIZATION.id, member.subjectId, "org:member");
  const { targetUrl } = await start();
  const code = ops.issue({
    ...member,
    organization: ORGANIZATION,
    targetUrl,
  });
  // Somebody else's browser, with its own sign-in under way.
  const { cookie: otherBrowser } = await start();

  const planted = await callback(targetUrl, code, otherBrowser);

  expect(planted.headers.get("location")).toBe(
    `${APP_URL}/sign?error=copilotkit_expired`,
  );
  expect(await roleOf(member.email)).toBeUndefined();
});

test("the role is read again at every sign-in", async () => {
  const member = person();
  ops.member(ORGANIZATION.id, member.subjectId, "org:member");
  await signIn(member);
  expect(await roleOf(member.email)).toEqual(["user"]);

  ops.member(ORGANIZATION.id, member.subjectId, "org:admin");
  await signIn(member);
  expect(await roleOf(member.email)).toEqual(["admin"]);

  ops.member(ORGANIZATION.id, member.subjectId, "org:member");
  await signIn(member);
  expect(await roleOf(member.email)).toEqual(["user"]);
});

test("a role set in OpenBot does not outlast the next sign-in", async () => {
  const member = person();
  ops.member(ORGANIZATION.id, member.subjectId, "org:member");
  const { response } = await signIn(member);
  const userId = (await sessionFor(response))?.user.id ?? "";
  await setRole(database, userId, "admin");

  await signIn(member);

  expect(await roleOf(member.email)).toEqual(["user"]);
});

test("somebody removed from the organization cannot sign in again", async () => {
  const member = person();
  ops.member(ORGANIZATION.id, member.subjectId, "org:member");
  expect((await signIn(member)).response.headers.get("location")).toBe(
    `${APP_URL}/`,
  );

  ops.member(ORGANIZATION.id, member.subjectId, null);
  const { response } = await signIn(member);

  expect(response.headers.get("location")).toBe(
    `${APP_URL}/sign?error=copilotkit_not_member`,
  );
  expect(await sessionFor(response)).toBeNull();
});

test("somebody an admin removed here is refused even while still in the organization", async () => {
  const member = person();
  ops.member(ORGANIZATION.id, member.subjectId, "org:member");
  await signIn(member);
  revoked.add(member.email);

  const { response } = await signIn(member);

  expect(response.headers.get("location")).toBe(
    `${APP_URL}/sign?error=copilotkit_removed`,
  );
  expect(await sessionFor(response)).toBeNull();
});

test("a session lasts eight hours from sign-in, as a managed Intelligence session does", async () => {
  const member = person();
  ops.member(ORGANIZATION.id, member.subjectId, "org:member");

  const { response } = await signIn(member);

  const session = await sessionFor(response);
  const [row] = await database
    .select({ createdAt: sessions.createdAt, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(eq(sessions.id, session?.session.id ?? ""));
  expect(
    (row?.expiresAt.getTime() ?? 0) - (row?.createdAt.getTime() ?? 0),
  ).toBeWithin(
    COPILOTKIT_SESSION_SECONDS * 1000 - 5_000,
    COPILOTKIT_SESSION_SECONDS * 1000 + 5_000,
  );
});

test("there is no other way in: no social provider and no registered identity provider", async () => {
  const social = await auth.handler(
    new Request(`${AUTH_URL}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_URL },
      body: JSON.stringify({ provider: "google", callbackURL: APP_URL }),
    }),
  );
  expect(social.ok).toBe(false);
  const sso = await auth.handler(
    new Request(`${AUTH_URL}/api/auth/sign-in/sso`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_URL },
      body: JSON.stringify({ email: "a@acme.example.test" }),
    }),
  );
  expect(sso.status).toBe(404);
});

/**
 * The phone app reaches OpenBot's API through the client generated from api/openapi.yaml, and every call it makes goes
 * through its mutator (src/api/request.ts). There is no simulator here, so this drives the generated functions and the
 * mutator for real, over HTTP, against a stand-in deployment that answers only at the API's addresses and records what
 * reached it.
 *
 * What the phone's sign-in hands every request (src/auth.ts: the deployment's address and the signed-in session's
 * cookie) and expo-crypto's randomUUID are the platform here, so those two modules are stood in for with the values the
 * platform gives. Everything between a screen's call and the network is the app's own code.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fixture from "../../shared/fixtures/client-version/cases.json";
import appConfig from "../app.config";

type Seen = {
  method: string;
  path: string;
  query: string;
  cookie: string | null;
  key: string | null;
  contentType: string | null;
  body: unknown;
};
const seen: Seen[] = [];
/** Which organization each request named (the OpenBot-Organization header), by its method and path. */
const organizationNamed: { request: string; organization: string | null }[] =
  [];
/** Which organization each read of the deployment was asked of. */
const deploymentAsked: string[] = [];
/** What each read of the deployment was sent with: the session cookie, and the organization it named. */
const deploymentSentWith: {
  cookie: string | null;
  organization: string | null;
}[] = [];
/**
 * The signed-in person is not a member of `default`, as on a hosted or multi-organization OpenBot: their list holds
 * only org_work, and `default` is not found for their session, as an organization they are not in never is.
 */
let outsideDefault = false;
/**
 * The signed-in person was removed from org_work while the app was open: their list holds only default, and org_work
 * is not found for them, as an organization they are not in never is.
 */
let removedFromWork = false;
/** The signed-in person is in no organization here: never added, or removed from the last one. */
let inNone = false;
/** A hosted OpenBot's invitations: whether the admin's proof is good, what landed, and each POST's key. */
const hosted = {
  proofValid: true,
  /** The first POST lands even though it is answered for renewal (the answer came back on another hop). */
  landsAnyway: false,
  /** Whether renewing in the in-app browser renews the proof. */
  renewalWorks: true,
  invitations: [] as string[],
  answered: new Map<string, unknown>(),
  posts: [] as (string | null)[],
};
/** Each time the phone opened the hosted sign-in to renew. */
const renewed: string[] = [];
/** Which app each request named itself as (the OpenBot-Client header), in the order they arrived. */
const named: (string | null)[] = [];
/** What this stand-in answers at `deployment`: one of the fixture's real answers, or a status. */
let deploymentAnswer: { status: number; body: unknown } = {
  status: 200,
  body: fixture.deployments.current,
};
/** The OpenBot release this app is built from: the root package.json's version, read here on its own. */
const RELEASE = (
  JSON.parse(
    readFileSync(join(import.meta.dir, "../../package.json"), "utf8"),
  ) as { version: string }
).version;
/** The organization the signed-in person is working in: one of two they are in, and not the first. */
const ORG = "/api/v2/organizations/org_work";
const MINE = "/api/v2/people/me/organizations";
const ada = {
  id: "ada",
  name: "Ada",
  title: "",
  roleDescription: "Answers the phone.",
  mine: true,
  canManage: true,
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const text = await request.text();
    named.push(request.headers.get("openbot-client"));
    organizationNamed.push({
      request: `${request.method} ${url.pathname}`,
      organization: request.headers.get("openbot-organization"),
    });
    const deployment = /^\/api\/v2\/organizations\/([^/]+)\/deployment$/.exec(
      url.pathname,
    );
    if (deployment) {
      deploymentAsked.push(deployment[1] as string);
      deploymentSentWith.push({
        cookie: request.headers.get("cookie"),
        organization: request.headers.get("openbot-organization"),
      });
      if (
        outsideDefault &&
        deployment[1] === "default" &&
        request.headers.get("cookie")
      )
        return Response.json(
          {
            type: "https://open.bot/errors/organization-not-found",
            title: "Not found.",
            status: 404,
            detail: "Couldn't find that organization.",
            code: "ORGANIZATION_NOT_FOUND",
            category: "not_found",
            retryable: false,
            requestId: "req_example",
            traceId: "trace_example",
          },
          {
            status: 404,
            headers: { "content-type": "application/problem+json" },
          },
        );
      return Response.json(deploymentAnswer.body, {
        status: deploymentAnswer.status,
      });
    }
    if (url.pathname === `${ORG}/bots/insecure`)
      return Response.json(
        {
          type: "https://open.bot/errors/client-update-required",
          title: "This app is too old for this OpenBot.",
          status: 400,
          detail:
            "This version of OpenBot has a security problem. Update to keep using it.",
          code: "CLIENT_UPDATE_REQUIRED",
          category: "validation",
          retryable: false,
          requestId: "req_example",
          traceId: "trace_example",
          client: "mobile",
          minimumVersion: "1.2.0",
          security: true,
        },
        {
          status: 400,
          headers: { "content-type": "application/problem+json" },
        },
      );
    if (url.pathname === `${ORG}/invitations` && request.method === "POST") {
      const key = request.headers.get("idempotency-key");
      hosted.posts.push(key);
      const repeat = key ? hosted.answered.get(key) : undefined;
      if (repeat && hosted.proofValid)
        return Response.json(repeat, { status: 201 });
      const land = () => {
        const { email } = JSON.parse(text) as { email: string };
        hosted.invitations.push(email);
        const answer = {
          invitation: {
            id: `inv_${hosted.invitations.length}`,
            email,
            role: "member",
            status: "pending",
            invitedBy: { name: "Ada", email: "ada@example.test" },
            createdAt: "2026-11-20T09:00:00.000Z",
            expiresAt: "2026-11-27T09:00:00.000Z",
          },
          delivery: "emailed",
        };
        if (key) hosted.answered.set(key, answer);
        return answer;
      };
      if (!hosted.proofValid) {
        if (hosted.landsAnyway && !repeat) land();
        return Response.json(
          {
            type: "https://open.bot/errors/hosted-sign-in-renewal-required",
            title: "Your sign-in needs renewing.",
            status: 401,
            detail: "Your sign-in needs renewing.",
            code: "HOSTED_SIGN_IN_RENEWAL_REQUIRED",
            category: "auth",
            retryable: true,
            requestId: "req_example",
            traceId: "trace_example",
          },
          {
            status: 401,
            headers: {
              "content-type": "application/problem+json",
              "OpenBot-Sign-In": "/api/auth/hosted/sign-in",
            },
          },
        );
      }
      return Response.json(land(), { status: 201 });
    }
    if (url.pathname === `${ORG}/bots/proof-expired`)
      return Response.json(
        {
          type: "https://open.bot/errors/hosted-sign-in-renewal-required",
          title: "Your sign-in needs renewing.",
          status: 401,
          detail: "Your sign-in needs renewing.",
          code: "HOSTED_SIGN_IN_RENEWAL_REQUIRED",
          category: "auth",
          retryable: true,
          requestId: "req_example",
          traceId: "trace_example",
        },
        {
          status: 401,
          headers: {
            "content-type": "application/problem+json",
            "OpenBot-Sign-In": "/api/auth/hosted/sign-in",
          },
        },
      );
    if (url.pathname === `${ORG}/bots/too-old`)
      return Response.json(
        {
          type: "https://open.bot/errors/client-update-required",
          title: "This app is too old for this OpenBot.",
          status: 400,
          detail:
            "This OpenBot needs the OpenBot phone app 1.2.0 or later. Update OpenBot, then try again.",
          code: "CLIENT_UPDATE_REQUIRED",
          category: "validation",
          retryable: false,
          requestId: "req_example",
          traceId: "trace_example",
          client: "mobile",
          minimumVersion: "1.2.0",
        },
        {
          status: 400,
          headers: { "content-type": "application/problem+json" },
        },
      );
    seen.push({
      method: request.method,
      path: url.pathname,
      query: url.search,
      cookie: request.headers.get("cookie"),
      key: request.headers.get("idempotency-key"),
      contentType: request.headers.get("content-type"),
      body: text ? JSON.parse(text) : null,
    });
    const route = `${request.method} ${url.pathname}`;
    // A single-use ticket to link the company account, a new one for every request, as createCompanySignInTicket answers.
    if (route === `POST ${ORG}/people/me/company-sign-in/tickets`)
      return Response.json(
        {
          url: `${url.origin}/api/auth/company-sign-in/ticket/t${seen.length}`,
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
        },
        { status: 201 },
      );
    if (removedFromWork && url.pathname.startsWith(`${ORG}/`))
      return Response.json(
        {
          type: "https://open.bot/errors/organization-not-found",
          title: "Not found.",
          status: 404,
          detail: "Couldn't find that organization.",
          code: "ORGANIZATION_NOT_FOUND",
          category: "not_found",
          retryable: false,
          requestId: "req_example",
          traceId: "trace_example",
        },
        {
          status: 404,
          headers: { "content-type": "application/problem+json" },
        },
      );
    if (route === `GET ${MINE}` && inNone)
      return Response.json({
        organizations: [],
        canCreate: false,
        nextCursor: null,
      });
    if (route === `GET ${MINE}` && removedFromWork)
      return Response.json({
        organizations: [
          {
            id: "default",
            slug: "default",
            name: "Acme",
            role: "member",
            active: false,
            personal: false,
          },
        ],
        canCreate: false,
        nextCursor: null,
      });
    // Only a live session reads the person's organizations. A cookie sign-in left behind (an unfinished sign-in's
    // state, an expired session) is refused as OpenBot refuses it.
    if (
      route === `GET ${MINE}` &&
      !request.headers.get("cookie")?.includes("session_token=signed-in")
    )
      return Response.json(
        {
          type: "https://open.bot/errors/unauthenticated",
          title: "Authentication required.",
          status: 401,
          detail: "Authentication required.",
          code: "UNAUTHENTICATED",
          category: "auth",
          retryable: false,
          requestId: "req_example",
          traceId: "trace_example",
        },
        {
          status: 401,
          headers: { "content-type": "application/problem+json" },
        },
      );
    if (route === `GET ${MINE}` && outsideDefault)
      return Response.json({
        organizations: [
          {
            id: "org_work",
            slug: "work",
            name: "Work",
            role: "member",
            active: true,
            personal: false,
          },
        ],
        canCreate: false,
        nextCursor: null,
      });
    if (route === `GET ${MINE}`)
      return Response.json({
        organizations: [
          {
            id: "default",
            slug: "default",
            name: "Acme",
            role: "member",
            active: false,
          },
          {
            id: "org_work",
            slug: "work",
            name: "Work",
            role: "member",
            active: true,
          },
        ],
        canCreate: false,
        nextCursor: null,
      });
    if (route === `GET ${ORG}/bots`) {
      // Two pages, so a reader that stops at the first one is caught; the second hands its own cursor back.
      const cursor = url.searchParams.get("cursor");
      return Response.json(
        cursor
          ? {
              bots: [{ ...ada, id: "grace", name: "Grace" }],
              nextCursor: cursor,
            }
          : { bots: [ada], nextCursor: "bmV4dA" },
      );
    }
    if (
      route === `GET ${ORG}/bots/a%20b` ||
      route === "GET /api/v2/organizations/default/bots/a%20b"
    )
      return Response.json({ bot: { ...ada, id: "a b" } });
    if (route === "GET /api/v2/people/me/invitations")
      return Response.json({ invitations: [], nextCursor: null });
    if (route === `POST ${ORG}/bots/ada/pause`)
      return Response.json({ botId: "ada", paused: true });
    if (route === `PUT ${ORG}/people/me/devices/phone-1`)
      return Response.json({ device: { id: "phone-1" } });
    if (route === `DELETE ${ORG}/people/me/devices/gone`)
      return Response.json(
        {
          type: "https://open.bot/errors/device-not-found",
          title: "Not found",
          status: 404,
          detail: "That device is not registered.",
          code: "DEVICE_NOT_FOUND",
        },
        {
          status: 404,
          headers: { "content-type": "application/problem+json" },
        },
      );
    if (route === `DELETE ${ORG}/routines/r1`)
      return new Response(null, { status: 204 });
    if (route === `PUT ${ORG}/bots/ada/grants/skill%3Aresearch`)
      return Response.json({
        id: "skill:research",
        kind: "skill",
        ref: "research",
        action: null,
        skill: { slug: "research", title: "Research", summary: "Looks it up." },
      });
    return Response.json(
      { detail: "Not found.", code: "NOT_FOUND" },
      { status: 404 },
    );
  },
});
const serverUrl = `http://127.0.0.1:${server.port}`;
const COOKIE = "better-auth.session_token=signed-in";
/** The session the app holds: null before anybody has signed in. */
let cookie: string | null = COOKIE;
/** What the phone keeps in its secure store (src/auth.ts `organizationStore`). */
const secure = new Map<string, string>();

mock.module("../src/auth", () => ({
  serverUrl,
  authClient: { getCookie: () => cookie },
  // The in-app browser through the hosted sign-in, as OpenBot by CopilotKit answers somebody still signed in there.
  renewHostedSignIn: async (signIn: string) => {
    renewed.push(signIn);
    if (hosted.renewalWorks) hosted.proofValid = true;
  },
  // Each person's pick, kept by who they are, as src/auth.ts keeps it in the phone's secure store.
  organizationStore: {
    read: async (person: string) => secure.get(person) ?? null,
    write: async (person: string, id: string) => {
      secure.set(person, id);
    },
  },
}));
mock.module("expo-crypto", () => ({
  randomUUID: () => crypto.randomUUID(),
}));
// expo-constants gives the app the config app.config.ts evaluated to as it was built.
mock.module("expo-constants", () => ({
  default: { expoConfig: appConfig },
}));

const { getBot, pauseBot } = await import("../src/api/generated/bots/bots");
const { deleteDevice, registerDevice } = await import(
  "../src/api/generated/devices/devices"
);
const { deleteRoutine } = await import(
  "../src/api/generated/routines/routines"
);
const { replaceBotGrant } = await import(
  "../src/api/generated/bot-grants/bot-grants"
);
const {
  ApiError,
  chooseOrganization,
  everyBot,
  ME,
  ORGANIZATION_ID,
  organizationChoices,
  organizationsHeld,
  readDeployment,
  setSignedInPerson,
} = await import("../src/api");
const { homeView } = await import("../src/home-view");
const { listInvitations } = await import(
  "../src/api/generated/organizations/organizations"
);
const { NOT_IN_ORGANIZATION } = await import("../src/organization");
const { onSessionRefused } = await import("../src/session-refused");
const { onOrganizationGone } = await import("../src/organization-gone");
const { onRenewalNeedsClick } = await import("../src/renewal");
const { createOrganizationInvitation } = await import(
  "../src/api/generated/organizations/organizations"
);

const { checkVersion } = await import("../src/version-check");
const { onUpdateRequired } = await import("../src/client-version");

beforeEach(() => {
  seen.length = 0;
  named.length = 0;
  organizationNamed.length = 0;
  deploymentAsked.length = 0;
  deploymentSentWith.length = 0;
  outsideDefault = false;
  removedFromWork = false;
  inNone = false;
  hosted.proofValid = true;
  hosted.landsAnyway = false;
  hosted.renewalWorks = true;
  hosted.invitations = [];
  hosted.answered = new Map();
  hosted.posts = [];
  renewed.length = 0;
  setSignedInPerson("ada");
  cookie = COOKIE;
  deploymentAnswer = { status: 200, body: fixture.deployments.current };
});
afterAll(() => {
  server.stop(true);
});

test("a read goes to the deployment at the API's address, in the organization the person works in, with the session's cookie and no key", async () => {
  const original = globalThis.fetch;
  const inits: RequestInit[] = [];
  globalThis.fetch = ((
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    inits.push(init ?? {});
    return original(input, init);
  }) as typeof fetch;
  try {
    const answer = await getBot(ORGANIZATION_ID, "a b");
    expect(answer.bot.id).toBe("a b");
  } finally {
    globalThis.fetch = original;
  }
  // The person's organizations are asked for first, once for this sign-in, and the read goes to the
  // one they are working in. A Bot id with a space stays one path segment.
  const asked = {
    method: "GET",
    query: "",
    cookie: COOKIE,
    key: null,
    contentType: null,
    body: null,
  };
  expect(seen).toEqual([
    { ...asked, path: MINE, query: "?limit=100" },
    { ...asked, path: `${ORG}/bots/a%20b` },
  ]);
  // The session is the cookie the app holds, never the platform's own cookie jar.
  expect(inits.map((init) => init.credentials)).toEqual(["omit", "omit"]);

  // Asked once: the next request goes straight to the same organization.
  seen.length = 0;
  await getBot(ORGANIZATION_ID, "a b");
  expect(seen.map((request) => request.path)).toEqual([`${ORG}/bots/a%20b`]);
});

test("every write carries an Idempotency-Key of its own, and a retry's own key is kept", async () => {
  await pauseBot(ORGANIZATION_ID, "ada");
  await pauseBot(ORGANIZATION_ID, "ada");
  await registerDevice(
    ORGANIZATION_ID,
    ME,
    "phone-1",
    { token: "ExponentPushToken[x]", projectId: "p", platform: "ios" },
    { headers: { "Idempotency-Key": "retry-1" } },
  );
  const [first, second, device] = seen;
  expect(first?.key).toMatch(/^[0-9a-f-]{36}$/);
  expect(second?.key).toMatch(/^[0-9a-f-]{36}$/);
  expect(first?.key).not.toBe(second?.key);
  expect(device).toMatchObject({
    method: "PUT",
    path: `${ORG}/people/me/devices/phone-1`,
    cookie: COOKIE,
    key: "retry-1",
    contentType: "application/json",
    body: { token: "ExponentPushToken[x]", projectId: "p", platform: "ios" },
  });
});

test("Link your company account asks for a ticket where the person works, a new one with a key of its own on every tap, and opens each in the system browser", async () => {
  const { companySignInTicket } = await import("../src/company-sign-in-ticket");
  const { linkCompanyAccount, RETURN_ADDRESS } = await import(
    "../src/link-company"
  );
  const opened: string[] = [];
  const steps = {
    // The ticket call Home makes.
    ticket: companySignInTicket,
    open: async (url: string, returnTo: string) => {
      opened.push(url);
      expect(returnTo).toBe(RETURN_ADDRESS);
    },
  };
  expect(await linkCompanyAccount("harbor-okta", steps)).toBe("opened");
  expect(await linkCompanyAccount("harbor-okta", steps)).toBe("opened");
  const tickets = seen.filter(
    (request) => request.path === `${ORG}/people/me/company-sign-in/tickets`,
  );
  expect(tickets).toHaveLength(2);
  for (const ticket of tickets)
    expect(ticket).toMatchObject({
      method: "POST",
      cookie: COOKIE,
      contentType: "application/json",
      // returnTo app: once linked, OpenBot's page sends the browser back to the app.
      body: { providerId: "harbor-okta", returnTo: "app" },
    });
  // Never sent again with the same key: a replay is refused, so each tap is a request of its own.
  expect(tickets[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
  expect(tickets[0]?.key).not.toBe(tickets[1]?.key);
  expect(opened).toHaveLength(2);
  expect(opened[0]).not.toBe(opened[1]);
  expect(opened[0]).toContain("/api/auth/company-sign-in/ticket/");
});

test("a list is read page by page to its end, and a cursor handed back twice ends it", async () => {
  const bots = await everyBot();
  expect(bots.map((bot) => bot.id)).toEqual(["ada", "grace"]);
  expect(seen.map((request) => request.query)).toEqual([
    "?limit=100",
    "?limit=100&cursor=bmV4dA",
  ]);
});

test("a refusal arrives as ApiError with the server's sentence, status and code", async () => {
  const refused = await deleteDevice(ORGANIZATION_ID, ME, "gone").catch(
    (error: unknown) => error,
  );
  expect(refused).toBeInstanceOf(ApiError);
  expect(refused).toMatchObject({
    message: "That device is not registered.",
    status: 404,
    code: "DEVICE_NOT_FOUND",
  });
});

test("a 204 answers nothing", async () => {
  expect(await deleteRoutine(ORGANIZATION_ID, "r1")).toBeUndefined();
  expect(seen[0]).toMatchObject({
    method: "DELETE",
    path: `${ORG}/routines/r1`,
  });
  expect(seen[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
});

test("switching a skill on gives the Bot its grant, the grant's id one path segment", async () => {
  const grant = await replaceBotGrant(
    ORGANIZATION_ID,
    "ada",
    "skill:research",
    {},
  );
  expect(grant.skill?.slug).toBe("research");
  expect(seen).toEqual([
    {
      method: "PUT",
      path: `${ORG}/bots/ada/grants/skill%3Aresearch`,
      query: "",
      cookie: COOKIE,
      key: expect.stringMatching(/^[0-9a-f-]{36}$/),
      contentType: "application/json",
      body: {},
    },
  ]);
});

test("every request names the phone app and the OpenBot release it was built from, not Expo's own app version", async () => {
  // The release comes from the repository's root package.json as the app is built, never the store version.
  expect(appConfig.extra?.openbotRelease).toBe(RELEASE);
  expect(appConfig.version).not.toBe(RELEASE);
  await getBot(ORGANIZATION_ID, "a b");
  await pauseBot(ORGANIZATION_ID, "ada");
  await deleteRoutine(ORGANIZATION_ID, "r1");
  expect(named.length).toBeGreaterThanOrEqual(3);
  for (const header of named) expect(header).toBe(`mobile/${RELEASE}`);
});

test("before sign-in the app reads the deployment and decides: this release's OpenBot is fine, one that serves only newer phone apps says Update OpenBot", async () => {
  cookie = null;
  expect(await checkVersion()).toEqual({ kind: "ok" });
  expect(named).toEqual([`mobile/${RELEASE}`]);
  // Before sign-in nobody works anywhere: the deployment is asked of the organization every install has, and the
  // request names no organization of its own.
  expect(deploymentAsked).toEqual(["default"]);
  expect(organizationNamed[0]?.organization).toBeNull();

  deploymentAnswer = { status: 200, body: fixture.deployments["v1.1.0"] };
  expect(await checkVersion()).toEqual({ kind: "ok" });

  deploymentAnswer = { status: 200, body: fixture.deployments.raised };
  expect(await checkVersion()).toEqual({
    kind: "app",
    detail:
      "This OpenBot needs the OpenBot phone app 1.2.0 or later. Update OpenBot, then try again.",
  });

  deploymentAnswer = { status: 200, body: fixture.deployments["v3-only"] };
  expect(await checkVersion()).toEqual({
    kind: "app",
    detail:
      "This OpenBot needs a newer OpenBot phone app. Update OpenBot, then try again.",
  });
});

test("anything but an app too old for its OpenBot decides nothing: the app opens and its screens say what failed, as before", async () => {
  // No deployment answer at all.
  deploymentAnswer = {
    status: 404,
    body: { detail: "Not found.", code: "NOT_FOUND" },
  };
  expect(await checkVersion()).toEqual({ kind: "ok" });
  // An OpenBot that serves only an API older than any this app speaks: whoever runs it keeps it and their apps
  // matched, and the app adds nothing of its own for it.
  deploymentAnswer = {
    status: 200,
    body: { ...fixture.deployments.current, api: ["v1"] },
  };
  expect(await checkVersion()).toEqual({ kind: "ok" });
});

test("an OpenBot that raised the phone app's minimum for a security problem says so, from its deployment and from a refusal", async () => {
  deploymentAnswer = { status: 200, body: fixture.deployments.security };
  expect(await checkVersion()).toEqual({
    kind: "app",
    detail:
      "This version of OpenBot has a security problem. Update to keep using it.",
    security: true,
  });
  const heard: [string, boolean][] = [];
  const stop = onUpdateRequired((detail, security) =>
    heard.push([detail, security]),
  );
  try {
    await getBot(ORGANIZATION_ID, "insecure").catch(() => undefined);
    expect(heard).toEqual([
      [
        "This version of OpenBot has a security problem. Update to keep using it.",
        true,
      ],
    ]);
    deploymentAnswer = {
      status: 400,
      body: {
        detail:
          "This version of OpenBot has a security problem. Update to keep using it.",
        code: "CLIENT_UPDATE_REQUIRED",
        minimumVersion: "1.2.0",
        security: true,
      },
    };
    expect(await checkVersion()).toEqual({
      kind: "app",
      detail:
        "This version of OpenBot has a security problem. Update to keep using it.",
      security: true,
    });
  } finally {
    stop();
  }
});

test("a refusal of this app as too old, on any request, reaches the root layout as Update OpenBot with the server's sentence", async () => {
  const heard: string[] = [];
  const stop = onUpdateRequired((detail, security) => {
    heard.push(detail);
    expect(security).toBe(false);
  });
  try {
    const refused = await getBot(ORGANIZATION_ID, "too-old").catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({
      status: 400,
      code: "CLIENT_UPDATE_REQUIRED",
      message:
        "This OpenBot needs the OpenBot phone app 1.2.0 or later. Update OpenBot, then try again.",
    });
    expect(heard).toEqual([
      "This OpenBot needs the OpenBot phone app 1.2.0 or later. Update OpenBot, then try again.",
    ]);

    // The deployment read itself can be refused too; the gate says the same.
    deploymentAnswer = {
      status: 400,
      body: {
        detail:
          "This OpenBot needs the OpenBot phone app 1.2.0 or later. Update OpenBot, then try again.",
        code: "CLIENT_UPDATE_REQUIRED",
        minimumVersion: "1.2.0",
      },
    };
    expect(await checkVersion()).toEqual({
      kind: "app",
      detail:
        "This OpenBot needs the OpenBot phone app 1.2.0 or later. Update OpenBot, then try again.",
    });
  } finally {
    stop();
  }
});

test("signed in, every request names the organization it is for, and the deployment is asked of the person's own", async () => {
  await getBot(ORGANIZATION_ID, "a b");
  await listInvitations({ limit: 100 });
  await checkVersion(true);
  // Under the organization they work in, an address that names none, and the deployment read: each names org_work.
  // The list of their organizations names none, since it is how the one they work in is found.
  expect(organizationNamed).toEqual(
    expect.arrayContaining([
      { request: `GET ${ORG}/bots/a%20b`, organization: "org_work" },
      {
        request: "GET /api/v2/people/me/invitations",
        organization: "org_work",
      },
      { request: `GET ${ORG}/deployment`, organization: "org_work" },
    ]),
  );
  for (const { request, organization } of organizationNamed)
    if (request.startsWith(`GET ${MINE}`)) expect(organization).toBeNull();
    else expect(organization).toBe("org_work");
  // `default` is not one of the places a signed-in person's requests go.
  expect(deploymentAsked).toEqual(["org_work"]);
});

/*
 * REPORTED (fused end-to-end run, Android): the signed-out screen lost its sign-in buttons and read "Authentication
 * required" whenever the phone held a cookie that was not a live session: an unfinished sign-in's state, or an expired
 * or revoked session. The deployment, which says how people sign in, was read in the person's organization whenever
 * the phone held any cookie, which meant reading their organizations first, and that was refused.
 */
test("signed out with a cookie sign-in left behind, the deployment is still read in default, with its ways to sign in", async () => {
  cookie = "better-auth.state=unfinished-sign-in";
  expect(await checkVersion(false)).toEqual({ kind: "ok" });
  expect(deploymentAsked).toEqual(["default"]);
  const deployment = await readDeployment(false);
  expect(deployment.authProviders).toEqual(
    fixture.deployments.current.authProviders,
  );
  expect(deploymentAsked).toEqual(["default", "default"]);
  // Asked as nobody: nothing asked for the person's organizations, and no cookie or organization sent.
  expect(seen.map((request) => request.path)).not.toContain(MINE);
  expect(deploymentSentWith).toEqual([
    { cookie: null, organization: null },
    { cookie: null, organization: null },
  ]);
});

test("a session that ended without the phone knowing yet reads the deployment in default", async () => {
  cookie = "better-auth.session_token=expired";
  expect(await checkVersion(true)).toEqual({ kind: "ok" });
  expect(deploymentAsked).toEqual(["default"]);
  const deployment = await readDeployment(true);
  expect(deployment.authProviders).toEqual(
    fixture.deployments.current.authProviders,
  );
  // Each read asked for the person's organizations, was refused as signed out, and read default's.
  expect(deploymentAsked).toEqual(["default", "default"]);
});

/*
 * REPORTED (fused end-to-end run, Android): on every cold start of a signed-in person who is not a member of `default`,
 * Home said "Couldn't find that organization." in red and kept it. The session had not answered yet, so the signed-out
 * screen's deployment read went to `default` with the person's own cookie, and `default` is not found for somebody
 * who isn't in it.
 */
test("a cold start of a signed-in person outside default reads default's deployment as nobody, then their own", async () => {
  outsideDefault = true;
  cookie = "better-auth.session_token=signed-in-outside-default";
  // Signed out as far as the screen knows: `default`'s, sent with no cookie and no organization, and it answers.
  const signedOut = await readDeployment(false);
  expect(signedOut.authProviders).toEqual(
    fixture.deployments.current.authProviders,
  );
  expect(deploymentAsked).toEqual(["default"]);
  expect(deploymentSentWith).toEqual([{ cookie: null, organization: null }]);

  // Signed in: their own organization's, and their own organization's Bots, with nothing refused.
  expect(await checkVersion(true)).toEqual({ kind: "ok" });
  expect(deploymentAsked).toEqual(["default", "org_work"]);
  expect(deploymentSentWith[1]).toEqual({
    cookie: "better-auth.session_token=signed-in-outside-default",
    organization: "org_work",
  });
  const answer = await getBot(ORGANIZATION_ID, "a b");
  expect(answer.bot.id).toBe("a b");
  expect(seen.map((request) => request.path)).toContain(`${ORG}/bots/a%20b`);
});

test("a signed-in person whose organization's deployment isn't found reads default's as nobody", async () => {
  cookie = "better-auth.session_token=signed-in-not-found";
  deploymentAnswer = {
    status: 404,
    body: {
      detail: "Couldn't find that organization.",
      code: "ORGANIZATION_NOT_FOUND",
    },
  };
  await readDeployment(true).catch(() => undefined);
  expect(deploymentAsked).toEqual(["org_work", "default"]);
  expect(deploymentSentWith[1]).toEqual({ cookie: null, organization: null });
});

/*
 * REPORTED (fused end-to-end run, Android): with the app open, a session revoked elsewhere left Home on the signed-in
 * screen saying "Authentication required." until the app was opened again: nothing read the session again. A request
 * sent with the session and refused as signed out now says so (src/session-refused.ts), and the root layout reads the
 * session again on it, which takes the person back to the sign-in buttons.
 */
test("a signed-in request refused as signed out tells the app to read the session again; one sent as nobody doesn't", async () => {
  const heard: string[] = [];
  const stop = onSessionRefused(() => heard.push("refused"));
  try {
    cookie = "better-auth.session_token=revoked";
    const refused = await getBot(ORGANIZATION_ID, "a b").catch(
      (error: unknown) => error,
    );
    expect(refused).toMatchObject({ status: 401 });
    expect(heard.length).toBeGreaterThanOrEqual(1);

    // Nobody signed in: a refusal says nothing about a session.
    heard.length = 0;
    cookie = null;
    deploymentAnswer = {
      status: 401,
      body: { detail: "Authentication required.", code: "UNAUTHENTICATED" },
    };
    await readDeployment(false).catch(() => undefined);
    expect(heard).toEqual([]);
  } finally {
    stop();
  }
});

// Last: the pick it makes is the phone's from here on.
test("picking another organization sends every request after it there, and the phone keeps the pick for the next sign-in", async () => {
  expect((await organizationChoices()).currentId).toBe("org_work");
  const picked = await chooseOrganization("default");
  expect(picked.currentId).toBe("default");
  expect(picked.organizations.map((one) => one.id)).toEqual([
    "default",
    "org_work",
  ]);
  // Asked of the server first, so a pick is always one of the person's own.
  expect(seen.map((request) => request.path)).toContain(MINE);

  seen.length = 0;
  organizationNamed.length = 0;
  await getBot(ORGANIZATION_ID, "a b");
  expect(seen.map((request) => request.path)).toEqual([
    "/api/v2/organizations/default/bots/a%20b",
  ]);
  expect(organizationNamed).toEqual([
    {
      request: "GET /api/v2/organizations/default/bots/a%20b",
      organization: "default",
    },
  ]);
  expect([...secure.values()]).toEqual(["default"]);

  // The app opened again, signed in afresh: the server still says org_work is active, and the pick kept on the phone
  // wins while it is one of the person's.
  cookie = "better-auth.session_token=signed-in-again";
  seen.length = 0;
  await getBot(ORGANIZATION_ID, "a b");
  expect(seen.map((request) => request.path)).toEqual([
    MINE,
    "/api/v2/organizations/default/bots/a%20b",
  ]);

  // An organization the person is not in is refused, and nothing is addressed to it.
  await expect(chooseOrganization("org_elsewhere")).rejects.toThrow(
    NOT_IN_ORGANIZATION,
  );
  expect([...secure.values()]).toEqual(["default"]);
});

/*
 * REPORTED (fused end-to-end run, Android): removed from the organization they worked in while the app was open, the
 * person stayed in it, ticked, with "Couldn't find that organization.", and every list kept asking it until the app was
 * opened again. Now its "not found" makes the phone forget it: the next request reads their organizations again and
 * goes to another of theirs, and Home is told so it reads them again too.
 */
test("removed from the organization they work in, the next request goes to another of theirs, and Home is told", async () => {
  setSignedInPerson("cy");
  cookie = "better-auth.session_token=signed-in-then-removed";
  const heard: string[] = [];
  const stop = onOrganizationGone(() => heard.push("gone"));
  try {
    await getBot(ORGANIZATION_ID, "a b");
    expect(seen.at(-1)?.path).toBe(`${ORG}/bots/a%20b`);

    removedFromWork = true;
    const refused = await getBot(ORGANIZATION_ID, "a b").catch(
      (error: unknown) => error,
    );
    expect(refused).toMatchObject({
      status: 404,
      code: "ORGANIZATION_NOT_FOUND",
    });
    expect(heard).toEqual(["gone"]);

    seen.length = 0;
    const answer = await getBot(ORGANIZATION_ID, "a b");
    expect(answer.bot.id).toBe("a b");
    expect(seen.map((request) => request.path)).toEqual([
      MINE,
      "/api/v2/organizations/default/bots/a%20b",
    ]);
    expect((await organizationChoices()).currentId).toBe("default");
  } finally {
    stop();
  }
});

/*
 * REPORTED (fused end-to-end run): the pick was kept for the phone, not the person, so a phone two people share opened
 * in the last person's organization when the next one was a member of it too.
 */
test("on a phone two people share, each opens in their own pick, never the last person's", async () => {
  // Ada picks default.
  setSignedInPerson("ada");
  cookie = "better-auth.session_token=signed-in-ada";
  await chooseOrganization("default");
  expect(secure.get("ada")).toBe("default");

  // Ben signs in on the same phone. He is in default too, and works where the server says he does: org_work.
  setSignedInPerson("ben");
  cookie = "better-auth.session_token=signed-in-ben";
  seen.length = 0;
  await getBot(ORGANIZATION_ID, "a b");
  expect(seen.at(-1)?.path).toBe(`${ORG}/bots/a%20b`);

  // Ada again: her own pick.
  setSignedInPerson("ada");
  cookie = "better-auth.session_token=signed-in-ada-again";
  seen.length = 0;
  await getBot(ORGANIZATION_ID, "a b");
  expect(seen.at(-1)?.path).toBe("/api/v2/organizations/default/bots/a%20b");
});

/*
 * REPORTED (fused end-to-end run, Android): left in no organization, Home said so and still offered Needs you,
 * approvals, Bots, Memory, notifications and conversations, all of which act on an organization. Home for somebody in
 * no organization is now its own: the sentence, Try again and Sign out. Signing out still works there: there is no
 * organization to take the phone off.
 */
test("somebody signed in to no organization gets Home for nobody's organization, and can still sign out", async () => {
  setSignedInPerson("dee");
  cookie = "better-auth.session_token=signed-in-in-none";
  inNone = true;
  const failed = await organizationChoices().catch(
    (error: unknown) => (error as Error).message,
  );
  expect(failed).toBe(
    "You aren't a member of an organization here. Ask an admin to add you.",
  );
  expect(homeView(true, failed as string)).toBe("in-no-organization");
  expect(await organizationsHeld()).toEqual([]);

  // Anybody else: the app, or the sign-in.
  expect(homeView(true, undefined)).toBe("working");
  expect(homeView(true, "Couldn't load your organizations. Try again.")).toBe(
    "working",
  );
  expect(homeView(false, failed as string)).toBe("signed-out");

  // Added to one again: Try again reads the list afresh and they work there.
  inNone = false;
  expect((await organizationChoices()).currentId).toBe("org_work");
});

/*
 * A hosted OpenBot refuses an admin action whose proof ran out with 401 HOSTED_SIGN_IN_RENEWAL_REQUIRED. The session is
 * still signed in: the phone must never take it for being signed out and send the person back to sign in.
 */
test("a sign-in that needs renewing is not taken for being signed out", async () => {
  setSignedInPerson("eve");
  cookie = "better-auth.session_token=signed-in-eve";
  const heard: string[] = [];
  const stop = onSessionRefused(() => heard.push("refused"));
  try {
    const refused = await getBot(ORGANIZATION_ID, "proof-expired").catch(
      (error: unknown) => error,
    );
    expect(refused).toMatchObject({
      status: 401,
      code: "HOSTED_SIGN_IN_RENEWAL_REQUIRED",
      message: "Your sign-in needs renewing.",
    });
    expect(heard).toEqual([]);
  } finally {
    stop();
  }
});

/*
 * A hosted OpenBot's proof ran out under an admin's invite. The phone renews in the in-app browser and sends the invite
 * again, once, with the Idempotency-Key it was sent with: it lands exactly once, and a write that landed the first time
 * is answered as a repeat.
 */
describe("renewing a hosted OpenBot's sign-in", () => {
  const invite = () =>
    createOrganizationInvitation(ORGANIZATION_ID, {
      email: "kit@example.com",
      role: "member",
    });

  test("an invite refused for renewal is renewed in the in-app browser and sent again with the same key, landing once", async () => {
    setSignedInPerson("fay");
    cookie = "better-auth.session_token=signed-in-fay";
    hosted.proofValid = false;
    const answer = await invite();
    expect(answer.invitation.email).toBe("kit@example.com");
    expect(renewed).toEqual(["/api/auth/hosted/sign-in"]);
    expect(hosted.posts).toHaveLength(2);
    expect(hosted.posts[1]).toBe(hosted.posts[0] as string);
    expect(hosted.invitations).toEqual(["kit@example.com"]);
  });

  test("an invite that landed before the renewal is answered as a repeat when sent again, and lands once", async () => {
    setSignedInPerson("fay");
    cookie = "better-auth.session_token=signed-in-fay-2";
    hosted.proofValid = false;
    hosted.landsAnyway = true;
    const answer = await invite();
    expect(answer.invitation.id).toBe("inv_1");
    expect(hosted.posts).toHaveLength(2);
    expect(hosted.invitations).toEqual(["kit@example.com"]);
  });

  test("a renewal that doesn't take offers Sign in again, renewing once and never in a loop", async () => {
    setSignedInPerson("fay");
    cookie = "better-auth.session_token=signed-in-fay-3";
    hosted.proofValid = false;
    hosted.renewalWorks = false;
    const offered: string[] = [];
    const stop = onRenewalNeedsClick((signIn) => offered.push(signIn));
    try {
      const refused = await invite().catch((error: unknown) => error);
      expect(refused).toMatchObject({
        status: 401,
        code: "HOSTED_SIGN_IN_RENEWAL_REQUIRED",
      });
      expect(renewed).toHaveLength(1);
      expect(offered).toEqual(["/api/auth/hosted/sign-in"]);
      expect(hosted.invitations).toEqual([]);
    } finally {
      stop();
    }
  });
});

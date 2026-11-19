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
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
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
  organizationStore: {
    read: async () => secure.get("organization") ?? null,
    write: async (id: string) => {
      secure.set("organization", id);
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
} = await import("../src/api");
const { listInvitations } = await import(
  "../src/api/generated/organizations/organizations"
);
const { NOT_IN_ORGANIZATION } = await import("../src/organization");

const { checkVersion } = await import("../src/version-check");
const { onUpdateRequired } = await import("../src/client-version");

beforeEach(() => {
  seen.length = 0;
  named.length = 0;
  organizationNamed.length = 0;
  deploymentAsked.length = 0;
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
  await checkVersion();
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

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
const ORG = "/api/v2/organizations/default";
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
    if (route === `GET ${ORG}/bots/a%20b`)
      return Response.json({ bot: { ...ada, id: "a b" } });
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

mock.module("../src/auth", () => ({
  serverUrl,
  authClient: { getCookie: () => COOKIE },
}));
mock.module("expo-crypto", () => ({
  randomUUID: () => crypto.randomUUID(),
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
const { ApiError, everyBot, ME, ORGANIZATION_ID } = await import("../src/api");

beforeEach(() => {
  seen.length = 0;
});
afterAll(() => {
  server.stop(true);
});

test("a read goes to the deployment at the API's address, with the session's cookie and no key", async () => {
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
  // A Bot id with a space stays one path segment.
  expect(seen).toEqual([
    {
      method: "GET",
      path: `${ORG}/bots/a%20b`,
      query: "",
      cookie: COOKIE,
      key: null,
      contentType: null,
      body: null,
    },
  ]);
  // The session is the cookie the app holds, never the platform's own cookie jar.
  expect(inits.map((init) => init.credentials)).toEqual(["omit"]);
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

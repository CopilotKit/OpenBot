import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  deleteCurrentRecorderConnection,
  exchangeRecorderConnectCode,
  getDeleteCurrentRecorderConnectionUrl,
  getExchangeRecorderConnectCodeUrl,
  getGetRecorderIdentityUrl,
  getGetRecorderLearningUrl,
  getRecorderIdentity,
  getRecorderLearning,
  getReportRecorderActivityUrl,
  reportRecorderActivity,
} from "../src/shared/generated/recorder";
import {
  OpenBotError,
  type OpenBotRequestInit,
  DEFAULT_ORGANIZATION_ID,
  openbotRaw,
  openbotRequest,
} from "../src/shared/openbot-client";

type Seen = {
  auth: string | null;
  cookie: string | null;
  method: string;
  path: string;
  key: string | null;
  contentType: string | null;
  body: unknown;
  /** The OpenBot-Client header: which app is asking. */
  client: string | null;
};

/** The OpenBot release this Recorder is built from: the root package.json's version, read here on its own. */
const RELEASE = (
  JSON.parse(
    readFileSync(join(import.meta.dir, "../../package.json"), "utf8"),
  ) as { version: string }
).version;

/** A refusal as OpenBot's API answers one: problem details (RFC 9457). */
function problem(
  status: number,
  code: string,
  detail: string,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      type: `https://open.bot/errors/${code.toLowerCase().replaceAll("_", "-")}`,
      title: detail,
      status,
      detail,
      code,
      category: "auth",
      retryable: false,
      requestId: "req_test",
      traceId: "trace_test",
      ...extra,
    }),
    { status, headers: { "content-type": "application/problem+json" } },
  );
}
let seen: Seen | null = null;

/** The Recorder's addresses in OpenBot's API, written out here rather than taken from the client under test. */
const API = {
  connections: "/api/v2/organizations/default/recorder-connections",
  currentConnection:
    "/api/v2/organizations/default/recorder-connections/current",
  me: "/api/v2/organizations/default/recorder/me",
  learning: "/api/v2/organizations/default/recorder/learning",
  activity: "/api/v2/organizations/default/recorder/activity",
};

const ada = { id: "p1", name: "Ada", email: "ada@example.test" };

const json = (init: OpenBotRequestInit, body: unknown): OpenBotRequestInit => ({
  ...init,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function failure(path: string): Promise<OpenBotError> {
  try {
    await openbotRequest(path, { target: { openbotUrl, token: "t" } });
  } catch (error) {
    if (error instanceof OpenBotError) return error;
    throw error;
  }
  throw new Error(`${path} did not fail`);
}
let server: ReturnType<typeof Bun.serve>;
let openbotUrl = "";

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const text = await request.text();
      seen = {
        auth: request.headers.get("authorization"),
        cookie: request.headers.get("cookie"),
        method: request.method,
        path: url.pathname,
        key: request.headers.get("idempotency-key"),
        contentType: request.headers.get("content-type"),
        body: text ? JSON.parse(text) : null,
        client: request.headers.get("openbot-client"),
      };
      const route = `${request.method} ${url.pathname}`;
      // OpenBot's API, at its addresses and in its shapes, for the Recorder's own operations.
      if (route === `POST ${API.connections}`)
        return Response.json(
          {
            token: "obr_new",
            connection: {
              id: "c1",
              label: "Work laptop",
              via: "web",
              extensionId: "ext",
              installId: "0123456789abcdef0123456789abcdef",
              createdAt: "2026-11-14T00:00:00.000Z",
              lastUsedAt: null,
            },
            user: ada,
          },
          { status: 201 },
        );
      if (route === `DELETE ${API.currentConnection}`)
        return new Response(null, { status: 204 });
      if (route === `GET ${API.me}`)
        return Response.json({ user: ada, connectionId: "c1" });
      if (route === `GET ${API.learning}`)
        return Response.json({
          learning: { state: "assigned", containerId: "space-1" },
        });
      if (route === `POST ${API.activity}`)
        return new Response(null, { status: 204 });
      if (url.pathname === "/ok") {
        return Response.json({
          echoed: request.method === "POST" ? JSON.parse(text) : null,
        });
      }
      if (url.pathname === "/signed-out") {
        return problem(401, "RECORDER_SIGNED_OUT", "Sign in again.", {
          reason: "removed",
        });
      }
      if (url.pathname === "/identity") {
        return problem(401, "AUTH_UNAUTHENTICATED", "Identity required.");
      }
      if (url.pathname === "/plain-401") {
        return new Response("nope", { status: 401 });
      }
      if (url.pathname === "/bad") {
        return problem(400, "VALIDATION_ERROR", "Bad batch.");
      }
      if (url.pathname === "/older-shape") {
        return Response.json(
          { error: "Sign in again.", code: "RECORDER_SIGNED_OUT" },
          { status: 401 },
        );
      }
      if (url.pathname === "/redirect") {
        return new Response(null, {
          status: 302,
          headers: { location: "/ok" },
        });
      }
      if (url.pathname === "/no-content") {
        return new Response(null, { status: 204 });
      }
      return new Response("missing", { status: 404 });
    },
  });
  openbotUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

test("the generated client reaches OpenBot only at the API's addresses, in its one organization", () => {
  expect({
    connections: getExchangeRecorderConnectCodeUrl(DEFAULT_ORGANIZATION_ID),
    currentConnection: getDeleteCurrentRecorderConnectionUrl(
      DEFAULT_ORGANIZATION_ID,
    ),
    me: getGetRecorderIdentityUrl(DEFAULT_ORGANIZATION_ID),
    learning: getGetRecorderLearningUrl(DEFAULT_ORGANIZATION_ID),
    activity: getReportRecorderActivityUrl(DEFAULT_ORGANIZATION_ID),
  }).toEqual(API);
});

test("each of the Recorder's operations goes out through the mutator: its address and method, the bearer, a key on every write", async () => {
  const target = { openbotUrl, token: "obr_t" };

  const grant = await exchangeRecorderConnectCode(
    DEFAULT_ORGANIZATION_ID,
    {
      code: "obc_abc",
      label: "Work laptop",
      installId: "0123456789abcdef0123456789abcdef",
    },
    { target: { openbotUrl } },
  );
  expect(grant.token).toBe("obr_new");
  expect(grant.user).toEqual(ada);
  // The code is the credential: no bearer, and the body as the spec types it.
  expect(seen).toMatchObject({
    method: "POST",
    path: API.connections,
    auth: null,
    cookie: null,
    contentType: "application/json",
    body: {
      code: "obc_abc",
      label: "Work laptop",
      installId: "0123456789abcdef0123456789abcdef",
    },
  });
  expect(seen?.key).toMatch(/^[0-9a-f]{32}$/);

  expect(
    await getRecorderIdentity(DEFAULT_ORGANIZATION_ID, { target }),
  ).toEqual({
    user: ada,
    connectionId: "c1",
  });
  expect(seen).toMatchObject({
    method: "GET",
    path: API.me,
    auth: "Bearer obr_t",
    key: null,
  });

  expect(
    await getRecorderLearning(DEFAULT_ORGANIZATION_ID, { target }),
  ).toEqual({
    learning: { state: "assigned", containerId: "space-1" },
  });
  expect(seen).toMatchObject({ method: "GET", path: API.learning });

  const activity = { phase: "recording" as const, actions: 3 };
  expect(
    await reportRecorderActivity(DEFAULT_ORGANIZATION_ID, activity, { target }),
  ).toBeUndefined();
  expect(seen).toMatchObject({
    method: "POST",
    path: API.activity,
    auth: "Bearer obr_t",
    body: activity,
  });
  expect(seen?.key).toMatch(/^[0-9a-f]{32}$/);

  expect(
    await deleteCurrentRecorderConnection(DEFAULT_ORGANIZATION_ID, { target }),
  ).toBeUndefined();
  expect(seen).toMatchObject({
    method: "DELETE",
    path: API.currentConnection,
    auth: "Bearer obr_t",
  });
  expect(seen?.key).toMatch(/^[0-9a-f]{32}$/);
});

test("every request names the Recorder and the OpenBot release it was built from, a read and a write, through the generated client and openbotRaw", async () => {
  const target = { openbotUrl, token: "obr_t" };
  const named = `recorder/${RELEASE}`;
  await getRecorderIdentity(DEFAULT_ORGANIZATION_ID, { target });
  expect(seen).toMatchObject({ path: API.me, client: named });
  await reportRecorderActivity(
    DEFAULT_ORGANIZATION_ID,
    { phase: "recording", actions: 1 },
    { target },
  );
  expect(seen).toMatchObject({ path: API.activity, client: named });
  await exchangeRecorderConnectCode(
    DEFAULT_ORGANIZATION_ID,
    {
      code: "obc_abc",
      label: "Work laptop",
      installId: "0123456789abcdef0123456789abcdef",
    },
    { target: { openbotUrl } },
  );
  expect(seen).toMatchObject({ path: API.connections, client: named });
  await openbotRaw(target, "/ok", { method: "POST", body: "{}" });
  expect(seen).toMatchObject({ path: "/ok", client: named });
});

test("a call that names no OpenBot is refused before any request is made", async () => {
  const { urls } = await recordFetch(async () => {
    await expect(getRecorderIdentity(DEFAULT_ORGANIZATION_ID)).rejects.toThrow(
      "Name the OpenBot",
    );
  });
  expect(urls).toEqual([]);
});

test("sends the bearer, no cookie, and parses JSON", async () => {
  const result = await openbotRequest<{ echoed: unknown }>("/ok", {
    target: { openbotUrl, token: "obr_t" },
  });
  expect(result).toEqual({ echoed: null });
  expect(seen?.auth).toBe("Bearer obr_t");
  expect(seen?.cookie).toBeNull();
});

test("sends no Authorization header without a token and posts a JSON body", async () => {
  const result = await openbotRequest<{ echoed: unknown }>(
    "/ok",
    json({ target: { openbotUrl }, method: "POST" }, { a: 1 }),
  );
  expect(result).toEqual({ echoed: { a: 1 } });
  expect(seen?.auth).toBeNull();
  expect(seen?.method).toBe("POST");
});

test("every write carries an Idempotency-Key of its own, and a read carries none", async () => {
  const target = { openbotUrl, token: "obr_t" };
  await openbotRequest("/ok", { target });
  expect(seen?.key).toBeNull();
  const keys: (string | null)[] = [];
  await openbotRequest("/ok", json({ target, method: "POST" }, { a: 1 }));
  keys.push(seen?.key ?? null);
  await openbotRequest("/ok", json({ target, method: "POST" }, { a: 1 }));
  keys.push(seen?.key ?? null);
  await openbotRequest("/no-content", { target, method: "DELETE" });
  keys.push(seen?.key ?? null);
  for (const key of keys) expect(key).toMatch(/^[0-9a-f]{32}$/);
  expect(new Set(keys).size).toBe(3);
});

test("a caller retrying a write sends its own Idempotency-Key, which is kept", async () => {
  await openbotRequest("/ok", {
    ...json({ target: { openbotUrl }, method: "POST" }, { a: 1 }),
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "retry-1",
    },
  });
  expect(seen?.key).toBe("retry-1");
});

test("throws OpenBotError with the status and the server's message on a 4xx", async () => {
  const error = await failure("/bad");
  expect(error).toBeInstanceOf(OpenBotError);
  expect(error.status).toBe(400);
  expect(error.message).toBe("Bad batch.");
  expect(error.body).toMatchObject({
    detail: "Bad batch.",
    code: "VALIDATION_ERROR",
  });
  expect(error.signedOut).toBe(false);
});

test("a refusal that is not problem details carries no sentence, code or sign-out", async () => {
  const error = await failure("/older-shape");
  expect(error.status).toBe(401);
  expect(error.message).toBe("OpenBot answered 401.");
  expect(error.body).toBeNull();
  expect(error.signedOut).toBe(false);
});

test("signedOut is true only for a 401 carrying RECORDER_SIGNED_OUT", async () => {
  const out = await failure("/signed-out");
  expect(out.status).toBe(401);
  expect(out.signedOut).toBe(true);
  expect(out.message).toBe("Sign in again.");
  expect(out.body?.reason).toBe("removed");
  const identity = await failure("/identity");
  expect(identity.status).toBe(401);
  expect(identity.signedOut).toBe(false);
  const plain = await failure("/plain-401");
  expect(plain).toBeInstanceOf(OpenBotError);
  expect(plain.body).toBeNull();
  expect(plain.signedOut).toBe(false);
});

test("refuses a redirect", async () => {
  await expect(
    openbotRequest("/redirect", { target: { openbotUrl, token: "t" } }),
  ).rejects.toThrow();
  await expect(
    openbotRaw({ openbotUrl, token: "t" }, "/redirect", {}),
  ).rejects.toThrow();
});

test("openbotRaw returns the response unparsed and adds the bearer", async () => {
  const response = await openbotRaw({ openbotUrl, token: "obr_t" }, "/bad", {
    method: "PUT",
  });
  expect(response.status).toBe(400);
  expect(seen?.auth).toBe("Bearer obr_t");
  expect(seen?.method).toBe("PUT");
});

test("a 204 answer with no body resolves to undefined", async () => {
  const result = await openbotRequest<void>("/no-content", {
    target: { openbotUrl, token: "obr_t" },
    method: "DELETE",
  });
  expect(result).toBeUndefined();
  expect(seen?.auth).toBe("Bearer obr_t");
  expect(seen?.method).toBe("DELETE");
});

async function recordFetch(
  run: () => Promise<unknown>,
): Promise<{ inits: RequestInit[]; urls: string[] }> {
  const original = globalThis.fetch;
  const inits: RequestInit[] = [];
  const urls: string[] = [];
  globalThis.fetch = ((
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    urls.push(String(input));
    inits.push(init ?? {});
    return original(input, init);
  }) as typeof fetch;
  try {
    await run().catch(() => undefined);
  } finally {
    globalThis.fetch = original;
  }
  return { inits, urls };
}

test("every request goes out with credentials omit and redirect error, whatever the caller passes", async () => {
  const target = { openbotUrl, token: "obr_t" };
  const { inits } = await recordFetch(async () => {
    await openbotRequest("/ok", {
      target,
      credentials: "include",
      redirect: "follow",
    });
    await openbotRaw(target, "/ok", {
      credentials: "include",
      redirect: "follow",
    });
  });
  expect(inits).toHaveLength(2);
  for (const init of inits) {
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
  }
});

test("refuses a path that leaves OpenBot's origin before any request is made", async () => {
  const target = { openbotUrl, token: "obr_t" };
  for (const path of ["https://evil.test/x", "//evil.test/x"]) {
    let rejected = false;
    const { urls } = await recordFetch(async () => {
      try {
        await openbotRequest(path, { target });
      } catch {
        rejected = true;
      }
    });
    expect(rejected).toBe(true);
    expect(urls).toEqual([]);
  }
});

test("openbotRaw rejects rather than throws when it refuses a path", async () => {
  for (const path of ["https://evil.test/x", "//evil.test/x"]) {
    let rejected = false;
    const { urls } = await recordFetch(async () => {
      const pending = openbotRaw({ openbotUrl, token: "obr_t" }, path, {});
      await expect(pending).rejects.toThrow();
      rejected = true;
    });
    expect(rejected).toBe(true);
    expect(urls).toEqual([]);
  }
});

test("openbotRaw rejects rather than throws on an unparseable OpenBot URL", async () => {
  let rejected = false;
  await recordFetch(async () => {
    const pending = openbotRaw({ openbotUrl: "not a url" }, "/x", {});
    await expect(pending).rejects.toThrow();
    rejected = true;
  });
  expect(rejected).toBe(true);
});

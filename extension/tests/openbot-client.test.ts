import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  OpenBotError,
  openbotJson,
  openbotRaw,
} from "../src/shared/openbot-client";

type Seen = { auth: string | null; cookie: string | null; method: string };
let seen: Seen | null = null;

async function failure(path: string): Promise<OpenBotError> {
  try {
    await openbotJson({ openbotUrl, token: "t" }, path);
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
      seen = {
        auth: request.headers.get("authorization"),
        cookie: request.headers.get("cookie"),
        method: request.method,
      };
      if (url.pathname === "/ok") {
        return Response.json({
          echoed: request.method === "POST" ? await request.json() : null,
        });
      }
      if (url.pathname === "/signed-out") {
        return Response.json(
          { error: "Sign in again.", code: "RECORDER_SIGNED_OUT" },
          { status: 401 },
        );
      }
      if (url.pathname === "/identity") {
        return Response.json(
          { error: "Identity required.", code: "IDENTITY_REQUIRED" },
          { status: 401 },
        );
      }
      if (url.pathname === "/plain-401") {
        return new Response("nope", { status: 401 });
      }
      if (url.pathname === "/bad") {
        return Response.json({ error: "Bad batch." }, { status: 400 });
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

test("sends the bearer, no cookie, and parses JSON", async () => {
  const result = await openbotJson<{ echoed: unknown }>(
    { openbotUrl, token: "obr_t" },
    "/ok",
  );
  expect(result).toEqual({ echoed: null });
  expect(seen?.auth).toBe("Bearer obr_t");
  expect(seen?.cookie).toBeNull();
});

test("sends no Authorization header without a token and posts a JSON body", async () => {
  const result = await openbotJson<{ echoed: unknown }>({ openbotUrl }, "/ok", {
    method: "POST",
    body: { a: 1 },
  });
  expect(result).toEqual({ echoed: { a: 1 } });
  expect(seen?.auth).toBeNull();
  expect(seen?.method).toBe("POST");
});

test("throws OpenBotError with the status and the server's message on a 4xx", async () => {
  const error = await failure("/bad");
  expect(error).toBeInstanceOf(OpenBotError);
  expect(error.status).toBe(400);
  expect(error.message).toBe("Bad batch.");
  expect(error.body).toEqual({ error: "Bad batch." });
  expect(error.signedOut).toBe(false);
});

test("signedOut is true only for a 401 carrying RECORDER_SIGNED_OUT", async () => {
  const out = await failure("/signed-out");
  expect(out.status).toBe(401);
  expect(out.signedOut).toBe(true);
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
    openbotJson({ openbotUrl, token: "t" }, "/redirect"),
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
  const result = await openbotJson<void>(
    { openbotUrl, token: "obr_t" },
    "/no-content",
    { method: "DELETE" },
  );
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
    await openbotJson(target, "/ok");
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
        await openbotJson(target, path);
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

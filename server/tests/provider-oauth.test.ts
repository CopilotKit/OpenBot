import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { clearDesktopConnectionFailure } from "../src/desktop-connection-failure";
import {
  createProviderOAuthProxy,
  type ModelOAuthRecord,
  mountProviderOAuthProxy,
} from "../src/provider-oauth";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  try {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
  } finally {
    clearDesktopConnectionFailure("model");
  }
});

function record(overrides: Partial<ModelOAuthRecord> = {}): ModelOAuthRecord {
  return {
    version: 1,
    sessionId: "session-one",
    provider: "google",
    clientId: "desktop-client",
    clientSecret: "desktop-client-secret",
    accessToken: "provider-access-token",
    refreshToken: "provider-refresh-token",
    expiresAt: Date.now() + 3_600_000,
    scope: "model-scope",
    quotaProject: "google-quota-project",
    proxyToken: "local-proxy-token",
    ...overrides,
  };
}

async function fixture(
  current: ModelOAuthRecord,
  handler: (request: Request) => Response | Promise<Response>,
) {
  const root = await mkdtemp(join(tmpdir(), "openbot-model-oauth-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "model-oauth.json");
  await writeFile(file, JSON.stringify(current), { mode: 0o600 });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  cleanup.push(() => server.stop(true));
  const destinations: string[] = [];
  const app = new Hono();
  mountProviderOAuthProxy(
    app,
    createProviderOAuthProxy(file, {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        destinations.push(url.href);
        return fetch(new URL(url.pathname, server.url), init);
      },
    }),
  );
  const ask = (token: string | null = current.proxyToken) =>
    app.request("/api/model-provider/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "browser-session-must-not-pass-upstream",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({
        model: "chosen-model",
        messages: [],
        stream: true,
      }),
    });
  return { app, file, ask, destinations };
}

test("the model proxy requires its bearer even with a browser cookie", async () => {
  const f = await fixture(record(), () => new Response("not called"));
  for (const token of [null, "wrong-token"]) {
    const response = await f.ask(token);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("provider-access-token");
  }
  expect(f.destinations).toEqual([]);
});

test("Google uses provider bearer and quota project while preserving streamed model output", async () => {
  const f = await fixture(record(), async (request) => {
    expect(request.headers.get("authorization")).toBe(
      "Bearer provider-access-token",
    );
    expect(request.headers.get("x-goog-user-project")).toBe(
      "google-quota-project",
    );
    expect(request.headers.get("cookie")).toBeNull();
    expect(await request.json()).toMatchObject({
      model: "chosen-model",
      stream: true,
    });
    return new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', {
      headers: {
        "content-type": "text/event-stream",
        "set-cookie": "must-not-leave-provider",
      },
    });
  });
  const response = await f.ask();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toContain("data: [DONE]");
  expect(f.destinations).toEqual([
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  ]);
});

test("xAI uses the existing compatible model endpoint without Google quota headers", async () => {
  const f = await fixture(
    record({ provider: "xai", quotaProject: undefined }),
    (request) => {
      expect(request.headers.get("authorization")).toBe(
        "Bearer provider-access-token",
      );
      expect(request.headers.get("x-goog-user-project")).toBeNull();
      return Response.json({ choices: [] });
    },
  );
  expect((await f.ask()).status).toBe(200);
  expect(f.destinations).toEqual(["https://api.x.ai/v1/chat/completions"]);
});

test("concurrent requests refresh once and persist the rotated pair before forwarding", async () => {
  let refreshes = 0;
  const f = await fixture(record({ expiresAt: 1 }), async (request) => {
    if (new URL(request.url).pathname === "/token") {
      refreshes++;
      const body = new URLSearchParams(await request.text());
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("provider-refresh-token");
      expect(body.get("client_id")).toBe("desktop-client");
      expect(body.get("client_secret")).toBe("desktop-client-secret");
      await Bun.sleep(20);
      return Response.json({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
      });
    }
    expect(request.headers.get("authorization")).toBe("Bearer rotated-access");
    const saved = JSON.parse(await readFile(f.file, "utf8"));
    expect(saved.refreshToken).toBe("rotated-refresh");
    return Response.json({ choices: [] });
  });
  const responses = await Promise.all(Array.from({ length: 8 }, () => f.ask()));
  expect(responses.map((response) => response.status)).toEqual(
    Array(8).fill(200),
  );
  expect(refreshes).toBe(1);
  const saved = JSON.parse(await readFile(f.file, "utf8"));
  expect(saved).toMatchObject({
    accessToken: "rotated-access",
    refreshToken: "rotated-refresh",
    sessionId: "session-one",
  });
  expect(saved.expiresAt).toBeGreaterThan(Date.now());
  if (process.platform !== "win32")
    expect((await stat(f.file)).mode & 0o777).toBe(0o600);
  expect((await f.ask()).status).toBe(200);
  expect(refreshes).toBe(1);
});

test("an unexpired rejected xAI token is refreshed once and the request is replayed", async () => {
  let refreshes = 0;
  let calls = 0;
  const f = await fixture(
    record({
      provider: "xai",
      quotaProject: undefined,
      clientSecret: undefined,
    }),
    async (request) => {
      if (new URL(request.url).pathname === "/oauth2/token") {
        refreshes++;
        const body = new URLSearchParams(await request.text());
        expect(body.get("client_secret")).toBeNull();
        return Response.json({
          access_token: "new-xai-token",
          expires_in: 3600,
        });
      }
      calls++;
      return request.headers.get("authorization") === "Bearer new-xai-token"
        ? Response.json({ choices: [] })
        : Response.json({ error: "expired" }, { status: 401 });
    },
  );
  expect((await f.ask()).status).toBe(200);
  expect(refreshes).toBe(1);
  expect(calls).toBe(2);
  expect(JSON.parse(await readFile(f.file, "utf8")).refreshToken).toBe(
    "provider-refresh-token",
  );
});

test("a refused refresh exposes no provider response or credential and keeps the old file", async () => {
  const initial = record({ expiresAt: 1 });
  const f = await fixture(initial, () =>
    Response.json(
      { error: "invalid_grant", secret: initial.refreshToken },
      { status: 400 },
    ),
  );
  const response = await f.ask();
  expect(response.status).toBe(401);
  const body = await response.text();
  expect(body).not.toContain(initial.refreshToken);
  expect(body).not.toContain("invalid_grant");
  expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual(initial);
});

test.each(["model", "refresh"] as const)(
  "%s endpoint redirects cannot carry provider credentials elsewhere",
  async (endpoint) => {
    let leaked = 0;
    const destination = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        leaked++;
        return new Response("leaked");
      },
    });
    cleanup.push(() => destination.stop(true));
    const f = await fixture(
      record({
        expiresAt: endpoint === "refresh" ? 1 : Date.now() + 3_600_000,
      }),
      () => Response.redirect(destination.url, 307),
    );
    const response = await f.ask();
    expect(response.status).toBe(endpoint === "refresh" ? 401 : 502);
    expect(response.headers.get("location")).toBeNull();
    expect(leaked).toBe(0);
  },
);

test("a completed new sign-in cannot be overwritten by an older in-flight refresh", async () => {
  let began!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const release = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const f = await fixture(record({ expiresAt: 1 }), async () => {
    began();
    await release;
    return Response.json({
      access_token: "old-session-rotated-access",
      refresh_token: "old-session-rotated-refresh",
      expires_in: 3600,
    });
  });
  const pending = f.ask();
  await started;
  const replacement = record({
    sessionId: "new-sign-in",
    proxyToken: "new-local-token",
    refreshToken: "new-sign-in-refresh",
  });
  await writeFile(f.file, JSON.stringify(replacement), { mode: 0o600 });
  finish();
  expect((await pending).status).toBe(401);
  expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual(replacement);
});

test("missing or malformed credential files fail closed without exposing their content", async () => {
  const f = await fixture(record(), () => new Response("not called"));
  await writeFile(f.file, '{"accessToken":"malformed-private-token"');
  let response = await f.ask();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("malformed-private-token");
  await rm(f.file);
  response = await f.ask();
  expect(response.status).toBe(503);
  expect(f.destinations).toEqual([]);
});

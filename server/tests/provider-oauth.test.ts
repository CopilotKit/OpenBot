import { afterEach, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { fileURLToPath } from "node:url";
import { lockProviderCredentials } from "../src/provider-oauth-lock";
import {
  clearDesktopConnectionFailure,
  mountDesktopConnectionFailure,
} from "../src/desktop-connection-failure";
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
  mountDesktopConnectionFailure(app, "test-host-token");
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
  return { app, file, ask, destinations, providerUrl: server.url };
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
      contents: [],
    });
    return new Response(
      'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]},"finishReason":"STOP"}]}\n\n',
      {
        headers: {
          "content-type": "text/event-stream",
          "set-cookie": "must-not-leave-provider",
        },
      },
    );
  });
  const response = await f.ask();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toContain("data: [DONE]");
  expect(f.destinations).toEqual([
    "https://generativelanguage.googleapis.com/v1beta/models/chosen-model:streamGenerateContent?alt=sse",
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
    return new Response(
      'data: {"candidates":[{"content":{"parts":[{"text":"Refreshed"}]},"finishReason":"STOP"}]}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const responses = await Promise.all(Array.from({ length: 8 }, () => f.ask()));
  expect(responses.map((response) => response.status)).toEqual(
    Array(8).fill(200),
  );
  for (const response of responses)
    expect(await response.text()).toContain("data: [DONE]");
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

test("invalid Google requests are rejected before forwarding the provider bearer", async () => {
  const f = await fixture(record(), () => new Response("must not be called"));
  const response = await f.app.request(
    "/api/model-provider/v1/chat/completions",
    {
      method: "POST",
      headers: {
        authorization: "Bearer local-proxy-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "../outside", messages: [] }),
    },
  );
  expect(response.status).toBe(400);
  expect(f.destinations).toEqual([]);
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

async function authenticationFailure(app: Hono) {
  const response = await app.request("/api/desktop/connection-failure", {
    headers: { "x-openbot-desktop-host-token": "test-host-token" },
  });
  return response.json();
}

test("an abandoned legacy lock directory does not consume and lose a rotated token", async () => {
  let exchanges = 0;
  const f = await fixture(record({ provider: "xai", expiresAt: 1 }), () => {
    exchanges++;
    return Response.json({
      access_token: "next",
      refresh_token: "next-refresh",
      expires_in: 3600,
    });
  });
  const child = await lockOwner(f.file, "legacy");
  // The former Rust create_dir used the process umask (commonly 0755).
  if (process.platform !== "win32") await chmod(`${f.file}.lock`, 0o755);
  child.kill("SIGKILL");
  await child.exited;
  const response = await f.ask();
  expect(response.status).toBe(200);
  expect(exchanges).toBe(2); // One refresh and one model request.
  expect(JSON.parse(await readFile(f.file, "utf8")).refreshToken).toBe(
    "next-refresh",
  );
}, 10000);

test("independent proxy instances serialize real rotating-token exchanges", async () => {
  let exchanges = 0;
  const initial = record({ provider: "xai", expiresAt: 1 });
  const f = await fixture(initial, async (request) => {
    if (new URL(request.url).pathname === "/oauth2/token") {
      const exchange = ++exchanges;
      await Bun.sleep(50);
      return exchange === 1
        ? Response.json({
            access_token: "next",
            refresh_token: "next-refresh",
            expires_in: 3600,
          })
        : Response.json({ error: "already spent" }, { status: 400 });
    }
    return Response.json({ choices: [] });
  });
  // Each separate Hono/proxy instance has its own in-memory refresh deduplication map.
  const other = createProviderOAuthProxy(f.file, {
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return fetch(new URL(url.pathname, f.providerUrl), init);
    },
  });
  const responses = await Promise.all([
    f.ask(),
    other(
      new Request("http://localhost/model", {
        method: "POST",
        headers: { authorization: `Bearer ${initial.proxyToken}` },
        body: JSON.stringify({ model: "model", messages: [] }),
      }),
    ),
  ]);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect(exchanges).toBe(1);
});

test("an unreadable request body does not invalidate provider sign-in", async () => {
  const f = await fixture(record(), () => new Response("must not be called"));
  const response = await f.app.request(
    "/api/model-provider/v1/chat/completions",
    {
      method: "POST",
      headers: { authorization: "Bearer local-proxy-token" },
      body: new ReadableStream({
        start(controller) {
          controller.error(new Error("client disconnected"));
        },
      }),
    },
  );
  expect(response.status).toBe(400);
  expect(f.destinations).toEqual([]);
  expect(await authenticationFailure(f.app)).toBeNull();
});

test("a quota-project permission denial stays 403 without invalidating sign-in", async () => {
  const f = await fixture(record(), () =>
    Response.json({ error: "private quota project detail" }, { status: 403 }),
  );
  const response = await f.ask();
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain("private quota project detail");
  expect(await authenticationFailure(f.app)).toBeNull();
  expect(f.destinations).toHaveLength(1);
});

test("credential file paths must be absolute", () => {
  expect(() => createProviderOAuthProxy("relative.json")).toThrow("absolute");
});

test.each(["world-readable", "symlink", "oversized", "missing-quota"] as const)(
  "%s credential files are refused before provider I/O",
  async (kind) => {
    if (kind === "world-readable" && process.platform === "win32") return;
    const f = await fixture(record(), () => new Response("must not be called"));
    if (kind === "world-readable") await chmod(f.file, 0o644);
    if (kind === "symlink") {
      const target = `${f.file}.target`;
      await writeFile(target, JSON.stringify(record()), { mode: 0o600 });
      await rm(f.file);
      await symlink(target, f.file);
    }
    if (kind === "oversized")
      await writeFile(
        f.file,
        JSON.stringify(record({ scope: "x".repeat(64 * 1024) })),
      );
    if (kind === "missing-quota")
      await writeFile(
        f.file,
        JSON.stringify(record({ quotaProject: undefined })),
      );
    const response = await f.ask();
    expect(response.status).toBe(503);
    expect(f.destinations).toEqual([]);
    expect(await response.text()).not.toContain("provider-refresh-token");
  },
);

async function lockOwner(file: string, mode?: "legacy") {
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(
        new URL("./fixtures/provider-oauth-lock-owner.ts", import.meta.url),
      ),
      file,
      ...(mode ? [mode] : []),
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  cleanup.push(async () => {
    child.kill();
    await child.exited;
  });
  const reader = child.stdout.getReader();
  const timeout = setTimeout(() => child.kill(), 15000);
  try {
    let message = "";
    while (!message.includes("\n")) {
      const { value, done } = await reader.read();
      if (done)
        throw new Error(
          `Lock owner exited: ${await new Response(child.stderr).text()}`,
        );
      message += new TextDecoder().decode(value);
    }
    expect(message.trim()).toBe("locked");
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
  return child;
}

test("killing a real lock owner permits a subsequent durable rotating-token exchange", async () => {
  let refreshes = 0;
  const f = await fixture(
    record({ provider: "xai", expiresAt: 1 }),
    (request) => {
      if (new URL(request.url).pathname === "/oauth2/token") {
        refreshes++;
        return Response.json({
          access_token: "recovered",
          refresh_token: "recovered-refresh",
          expires_in: 3600,
        });
      }
      return Response.json({ choices: [] });
    },
  );
  const child = await lockOwner(f.file);
  child.kill("SIGKILL");
  await child.exited;
  expect((await f.ask()).status).toBe(200);
  expect(refreshes).toBe(1);
  expect(JSON.parse(await readFile(f.file, "utf8")).refreshToken).toBe(
    "recovered-refresh",
  );
}, 20000);

test("a live lock owner prevents any provider exchange until ownership is obtained", async () => {
  let refreshes = 0;
  const f = await fixture(
    record({ provider: "xai", expiresAt: 1 }),
    (request) => {
      if (new URL(request.url).pathname === "/oauth2/token") {
        refreshes++;
        return Response.json({
          access_token: "next",
          refresh_token: "next-refresh",
          expires_in: 3600,
        });
      }
      return Response.json({ choices: [] });
    },
  );
  const child = await lockOwner(f.file);
  const pending = f.ask();
  await Bun.sleep(100);
  expect(refreshes).toBe(0);
  child.stdin.end();
  expect(await child.exited).toBe(0);
  expect((await pending).status).toBe(200);
  expect(refreshes).toBe(1);
}, 20000);

test("a lock timeout returns a retryable failure without consuming a refresh token or recording an auth failure", async () => {
  const f = await fixture(
    record({ expiresAt: 1 }),
    () => new Response("must not be called"),
  );
  const unlock = await lockProviderCredentials(f.file);
  try {
    expect((await f.ask()).status).toBe(503);
    expect(f.destinations).toEqual([]);
    expect(await authenticationFailure(f.app)).toBeNull();
    expect(JSON.parse(await readFile(f.file, "utf8")).refreshToken).toBe(
      "provider-refresh-token",
    );
  } finally {
    await unlock();
  }
}, 20000);

test("a redirected lock inode is rejected before a provider exchange", async () => {
  const f = await fixture(
    record({ expiresAt: 1 }),
    () => new Response("must not be called"),
  );
  await mkdir(`${f.file}.lock`, { mode: 0o700 });
  const target = `${f.file}.untouched`;
  await writeFile(target, "untouched", { mode: 0o600 });
  await symlink(target, join(`${f.file}.lock`, "owner.lock"));
  expect((await f.ask()).status).toBe(503);
  expect(f.destinations).toEqual([]);
  expect(await readFile(target, "utf8")).toBe("untouched");
});

test("Windows validates the opened credential identity before reading a replaced path", async () => {
  const f = await fixture(record({ provider: "xai" }), () =>
    Response.json({ choices: [] }),
  );
  const originalPlatform = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  )!;
  const before = await fsPromises.lstat(f.file, { bigint: true });
  const replacement = `${f.file}.replacement`;
  await writeFile(
    replacement,
    JSON.stringify(
      record({ provider: "xai", accessToken: "must-not-be-forwarded" }),
    ),
    { mode: 0o600 },
  );
  // Return the real metadata sampled before another writer atomically replaced
  // the path: a deterministic race between Windows lstat and open.
  Object.defineProperty(process, "platform", {
    value: "win32",
    configurable: true,
  });
  try {
    expect((await f.ask()).status).toBe(200); // Valid file identities still work.
    f.destinations.length = 0;
    await fsPromises.rename(replacement, f.file);
    const inspect = spyOn(fsPromises, "lstat").mockResolvedValue(before);
    try {
      expect((await f.ask()).status).toBe(503);
      expect(f.destinations).toEqual([]);
    } finally {
      inspect.mockRestore();
    }
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

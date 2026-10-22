// A person's own OpenBot browser, through the real routes and the real database: opening it mints the person's Recorder
// connection with no Connect step, the connection resolves through the Recorder guard as that person, each open
// replaces the last, organization mode seals the session from the request, and nobody else (an admin included) reaches
// the browser or its live screen. The computer is a stand-in that answers its routes exactly as the contract types them
// (shared/openbot-browser.ts): slice 1 builds the real ones.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type BrowserApiState,
  type BrowserOpenResponse,
  type BrowserState,
  browserNarrationRequestSchema,
  browserNavigateRequestSchema,
  browserOpenRequestSchema,
  browserRecordingRequestSchema,
  browserTabsRequestSchema,
  isPersonBrowserId,
  type LauncherState,
} from "@openbot/shared/openbot-browser";
import {
  RECORDER_SIGNED_OUT,
  type RecorderConnectionsResponse,
} from "@openbot/shared/recorder-api";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import type { AuditEventInput } from "../src/audit";
import { createOrganizationAuth } from "../src/auth/organization";
import { organizationUserStore } from "../src/auth/organization-store";
import { openbotAddress } from "../src/browser/address";
import { personBrowserEgressPolicy } from "../src/browser/egress";
import {
  gatewayBrowserComputers,
  withPersonBrowsers,
} from "../src/browser/host";
import { personBrowserId } from "../src/browser/person";
import { createComputerGateway } from "../src/computer/gateway";
import { withPolicyPushOnWake } from "../src/computer/policy-network";
import {
  type ComputerProvider,
  createSharedComputerProvider,
} from "../src/computer/provider";
import { loadConfig } from "../src/config";
import { decryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { recorderConnections } from "../src/db/schema/recorder";
import { startHttpServer } from "../src/http-server";
import { createRecorderExtension } from "../src/recorder/wiring";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `browser-routes-${randomUUID()}`;
const ada = {
  id: `${prefix}-ada`,
  email: `${prefix}-ada@example.test`,
  name: "Ada",
};
const ben = {
  id: `${prefix}-ben`,
  email: `${prefix}-ben@example.test`,
  name: "Ben",
};
const admin = {
  id: `${prefix}-admin`,
  email: `${prefix}-admin@example.test`,
  name: "Admin",
};
const PEOPLE = { ada, ben, admin } as const;
const COMPUTER_TOKEN = "browser-routes-computer-token";
const PUBLIC = "https://openbot.example.com";
const GATEWAY = "wss://gateway.example.com/socket";
// This slice's own ports: the stand-in computer, the server the live screen is proxied through, and the organization's
// sign-in server.
const COMPUTER_PORT = 7721;
const SERVER_PORT = 7722;
const AUTHORITY_PORT = 7723;

// ---- The stand-in computer --------------------------------------------------------------------

type Opened = {
  state: BrowserState;
  connection: unknown;
  narrated: unknown[];
};
const browsers = new Map<string, Opened>();
const policies = new Map<string, unknown>();
/** Every request the computer took, as `<method> <path> <browser>`. */
const asked: string[] = [];

const recorderOf = (opened: Opened): LauncherState =>
  opened.state.recorder as LauncherState;

/** The computer's routes as the contract types them: the token, a person's browser id in `x-openbot-bot-id` (400 for
 * anything else), and each body read against the contract's schema. */
const computer = Bun.serve<{ bot: string }>({
  hostname: "127.0.0.1",
  port: COMPUTER_PORT,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/stream") {
      if (url.searchParams.get("token") !== COMPUTER_TOKEN)
        return new Response(null, { status: 401 });
      const bot = url.searchParams.get("bot") ?? "";
      return server.upgrade(request, { data: { bot } })
        ? undefined
        : new Response(null, { status: 400 });
    }
    if (request.headers.get("x-openbot-computer-token") !== COMPUTER_TOKEN)
      return Response.json({ error: "Unauthorized." }, { status: 401 });
    const id = request.headers.get("x-openbot-bot-id") ?? "";
    asked.push(`${request.method} ${url.pathname} ${id}`);
    if (url.pathname === "/health") return Response.json({ status: "ok" });
    if (url.pathname === "/egress-policy" && request.method === "PUT") {
      policies.set(id, ((await request.json()) as { policy: unknown }).policy);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/control")
      return Response.json({ holder: "human", transitioning: false });
    if (!url.pathname.startsWith("/browser/"))
      return Response.json({ error: "Not found." }, { status: 404 });
    if (!isPersonBrowserId(id))
      return Response.json(
        { error: "Only a person's browser opens here." },
        { status: 400 },
      );
    const body = request.method === "POST" ? await request.json() : undefined;
    const opened = browsers.get(id);
    const closed: BrowserState = { open: false, tabs: [] };
    switch (url.pathname) {
      case "/browser/state":
        return Response.json(opened?.state ?? closed);
      case "/browser/open": {
        const parsed = browserOpenRequestSchema.safeParse(body);
        if (!parsed.success)
          return Response.json({ error: "Bad request." }, { status: 400 });
        const next: Opened = {
          connection: parsed.data.connection,
          narrated: [],
          state: {
            open: true,
            browser: "chromium",
            window: "screen",
            recorder: {
              connected: true,
              userId: parsed.data.connection.user.id,
              phase: "idle",
              actions: 0,
              narration: "external",
            },
            tabs: [
              { id: "t1", url: "about:blank", title: "New Tab", active: true },
            ],
          },
        };
        browsers.set(id, next);
        return Response.json(next.state);
      }
      case "/browser/recording": {
        const parsed = browserRecordingRequestSchema.safeParse(body);
        if (!parsed.success || !opened)
          return Response.json({ error: "Bad request." }, { status: 400 });
        const recorder = recorderOf(opened);
        if (parsed.data.action === "start") {
          if (recorder.phase !== "idle")
            return Response.json(
              { error: "A recording is already running." },
              { status: 409 },
            );
          opened.state.recorder = {
            ...recorder,
            phase: "recording",
            title: parsed.data.title,
            recordingId: "rec-1",
            startedAt: Date.now(),
          };
        } else
          opened.state.recorder = {
            connected: true,
            phase: "idle",
            actions: 0,
            narration: recorder.narration,
          };
        return Response.json(opened.state);
      }
      case "/browser/narration": {
        const parsed = browserNarrationRequestSchema.safeParse(body);
        if (!parsed.success || !opened)
          return Response.json({ error: "Bad request." }, { status: 400 });
        opened.narrated.push(parsed.data);
        return Response.json({ ok: true });
      }
      case "/browser/tabs": {
        const parsed = browserTabsRequestSchema.safeParse(body);
        if (!parsed.success || !opened)
          return Response.json({ error: "Bad request." }, { status: 400 });
        if (parsed.data.action === "new")
          opened.state.tabs = [
            ...opened.state.tabs.map((tab) => ({ ...tab, active: false })),
            {
              id: `t${opened.state.tabs.length + 1}`,
              url: parsed.data.url ?? "about:blank",
              title: "",
              active: true,
            },
          ];
        return Response.json(opened.state);
      }
      case "/browser/navigate": {
        const parsed = browserNavigateRequestSchema.safeParse(body);
        if (!parsed.success || !opened)
          return Response.json({ error: "Bad request." }, { status: 400 });
        if ("url" in parsed.data) {
          const url = parsed.data.url;
          opened.state.tabs = opened.state.tabs.map((tab) =>
            tab.active ? { ...tab, url } : tab,
          );
        }
        return Response.json(opened.state);
      }
      case "/browser/close":
        browsers.delete(id);
        return Response.json(closed);
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  },
  websocket: {
    open(ws) {
      ws.send(JSON.stringify({ type: "frame", bot: ws.data.bot }));
    },
    message() {},
  },
});

// ---- OpenBot, as index.ts builds it ------------------------------------------------------------

const audits: AuditEventInput[] = [];
const auditStore = {
  insert: async (event: AuditEventInput) => {
    audits.push(event);
  },
};
const roleRepository = {
  rolesForUser: async (id: string) =>
    id === admin.id ? ["admin" as const] : ["user" as const],
};
const personalSpaces = {
  containerFor: (userId: string) => `space-of-${userId}`,
  state: async () => ({ state: "unassigned" as const, containerId: null }),
  kick: () => {},
};

/** The person a test cookie signs in. */
function personOf(cookie: string | null) {
  const name = /test-session=(\w+)/.exec(cookie ?? "")?.[1];
  return name && name in PEOPLE ? PEOPLE[name as keyof typeof PEOPLE] : null;
}

const better = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const person = personOf(headers.get("cookie"));
      return person ? { user: person } : null;
    },
  },
};

/** One OpenBot: the Bots' computer provider carrying people's browsers, the gateway over it, and the browser routes. */
function build(
  environment: Record<string, string | undefined> = {},
  options: {
    auth?: typeof better | ReturnType<typeof createOrganizationAuth>;
    organizationAuth?: ReturnType<typeof createOrganizationAuth>;
    computers?: false;
    /** The Bots' computer provider, in place of the shared stand-in computer. */
    provider?: ComputerProvider;
  } = {},
) {
  const base = {
    OPENBOT_PUBLIC_URL: PUBLIC,
    INTELLIGENCE_GATEWAY_WS_URL: GATEWAY,
    AGENT_COMPUTER_URL: `http://127.0.0.1:${COMPUTER_PORT}`,
    COMPUTER_TOKEN,
    ...environment,
  };
  // Organization mode signs people in at the organization's own server, with no sign-in provider here.
  const config = loadConfig(
    options.organizationAuth
      ? {
          DATABASE_URL: "postgres://openbot:openbot@127.0.0.1:5432/openbot",
          KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          INTELLIGENCE_API_URL: "http://127.0.0.1:7100",
          INTELLIGENCE_API_KEY: "tenant-api-key",
          COPILOTKIT_LICENSE_TOKEN: "license-token",
          ...base,
        }
      : testEnvironment(base),
  );
  const personPolicy = personBrowserEgressPolicy({
    native: config.browser !== undefined,
    allowPrivateHosts: false,
    openbotUrls: [config.publicUrl, config.appUrl],
    gatewayUrl: config.runtime.intelligence.gatewayWsUrl,
  });
  const provider = withPolicyPushOnWake(
    withPersonBrowsers(
      options.provider ??
        createSharedComputerProvider({
          baseUrl: `http://127.0.0.1:${COMPUTER_PORT}`,
          token: COMPUTER_TOKEN,
        }),
      config.browser?.url,
    ),
    {
      policyForBot: async (botId) =>
        isPersonBrowserId(botId) ? personPolicy : undefined,
      token: COMPUTER_TOKEN,
    },
  );
  const gateway = createComputerGateway({
    provider,
    auditStore,
    policy: () => undefined,
    token: COMPUTER_TOKEN,
  });
  const recorder = createRecorderExtension({
    config,
    database,
    organizationAuth: options.organizationAuth,
    roleRepository,
    peopleStore: { isRevoked: async () => false },
    personalSpaces,
    auditStore,
  });
  const args = [config] as unknown as Parameters<typeof createApp>;
  args[1] = (options.auth ?? better) as never;
  args[2] = roleRepository;
  args[7] = gateway;
  args[8] = {} as never;
  args[12] = auditStore;
  args[34] = {
    recorder,
    browser: {
      ...(options.computers === false
        ? {}
        : { computers: gatewayBrowserComputers(gateway) }),
      token: COMPUTER_TOKEN,
      recorder,
      openbotUrl: openbotAddress(config),
    },
  };
  return { app: createApp(...args), gateway, config };
}

type OpenBot = ReturnType<typeof build>;

const call = (
  { app }: OpenBot,
  path: string,
  init: RequestInit & { json?: unknown; as?: keyof typeof PEOPLE } = {},
) => {
  const { json, headers, as, ...rest } = init;
  return app.request(`http://openbot.test${path}`, {
    ...rest,
    headers: {
      ...(json === undefined ? {} : { "content-type": "application/json" }),
      ...(as ? { cookie: `test-session=${as}` } : {}),
      ...(headers as Record<string, string>),
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
};
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
/** The connection the computer was handed at the last open of this person's browser. */
const handed = (userId: string) =>
  browsers.get(personBrowserId(userId))?.connection as {
    openbotUrl: string;
    token: string;
    connectionId: string;
    user: { id: string; name: string; email: string };
  };

async function open(
  openbot: OpenBot,
  as: keyof typeof PEOPLE,
  headers: Record<string, string> = {},
) {
  const response = await call(openbot, "/api/browser/open", {
    method: "POST",
    as,
    headers,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as BrowserOpenResponse;
}

let openbot: OpenBot;
beforeAll(async () => {
  await database.insert(users).values([ada, ben, admin]);
  openbot = build();
});
afterAll(async () => {
  computer.stop(true);
  await database
    .delete(users)
    .where(inArray(users.id, [ada.id, ben.id, admin.id]));
  await database
    .delete(users)
    .where(eq(users.email, `${prefix}-org@example.test`));
  await database.$client.close();
});

describe("opening a person's own browser", () => {
  test("the browser is named for its person, and the state says it can be opened before anything runs", async () => {
    const computerId = personBrowserId(ada.id);
    expect(isPersonBrowserId(computerId)).toBe(true);
    expect(computerId).not.toBe(personBrowserId(ben.id));
    const state = await call(openbot, "/api/browser", { as: "ada" });
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual({
      available: true,
      computerId,
      open: false,
      tabs: [],
    } satisfies BrowserApiState);
    expect((await call(openbot, "/api/browser")).status).toBe(401);
    // An OpenBot with no way to run a person's browser says so, and the app hides the button.
    const without = build({}, { computers: false });
    expect(
      await (await call(without, "/api/browser", { as: "ada" })).json(),
    ).toEqual({
      available: false,
      computerId,
      open: false,
      tabs: [],
    });
    const refused = await call(without, "/api/browser/open", {
      method: "POST",
      as: "ada",
    });
    expect(refused.status).toBe(503);
  });

  test("asking the state never starts a computer or opens a browser: the app asks on every load", async () => {
    // A supervisor that has never started this person's computer: starting one is what `locate` does.
    const started: string[] = [];
    const supervisor = {
      name: "docker",
      isolation: "per-bot",
      locate: async (botId: string) => {
        started.push(botId);
        return `http://127.0.0.1:${COMPUTER_PORT}`;
      },
      status: async (botId: string) => ({ botId, state: "absent" as const }),
      stop: async () => ({ wasRunning: false }),
      reset: async () => ({ cleared: false }),
      list: async () => [],
    } satisfies ComputerProvider;
    const cold = build({}, { provider: supervisor });
    const before = asked.length;
    for (let index = 0; index < 3; index += 1)
      expect(
        await (await call(cold, "/api/browser", { as: "ben" })).json(),
      ).toEqual({
        available: true,
        computerId: personBrowserId(ben.id),
        open: false,
        tabs: [],
      });
    expect(started).toEqual([]);
    expect(asked.slice(before)).toEqual([]);
  });

  test("OpenBot Desktop's host-side computer carries people's browsers, while Bots' computers stay where they are", async () => {
    const bots = {
      name: "docker",
      isolation: "per-bot",
      locate: async () => "http://127.0.0.1:4300/bot-computer",
      status: async (botId: string) => ({ botId, state: "absent" as const }),
      stop: async () => ({ wasRunning: false }),
      reset: async () => ({ cleared: false }),
      list: async () => [],
    } satisfies ComputerProvider;
    const desktop = withPersonBrowsers(bots, "http://127.0.0.1:4101");
    expect(await desktop.locate(personBrowserId(ada.id))).toBe(
      "http://127.0.0.1:4101",
    );
    expect(await desktop.status(personBrowserId(ada.id))).toMatchObject({
      state: "ready",
    });
    expect(await desktop.locate("agent_7")).toBe(
      "http://127.0.0.1:4300/bot-computer",
    );
    expect(await desktop.status("agent_7")).toMatchObject({ state: "absent" });
    // Without OPENBOT_BROWSER_URL the same provider carries both.
    expect(withPersonBrowsers(bots, undefined)).toBe(bots);
    // There, a person's own desktop browser goes everywhere their own browser would.
    expect(
      personBrowserEgressPolicy({
        native:
          loadConfig(
            testEnvironment({ OPENBOT_BROWSER_URL: "http://127.0.0.1:4101" }),
          ).browser !== undefined,
        allowPrivateHosts: false,
        openbotUrls: [],
        gatewayUrl: GATEWAY,
      }),
    ).toEqual({ mode: "allow_all", rules: [] });
  });

  test("open mints the person's Recorder connection, which resolves through the Recorder guard as them and shows in Settings, Browsers", async () => {
    const opened = await open(openbot, "ada");
    const computerId = personBrowserId(ada.id);
    expect(opened).toEqual({
      ok: true,
      computerId,
      browser: "chromium",
      window: "screen",
      narration: "external",
    });
    const connection = handed(ada.id);
    expect(connection.openbotUrl).toBe(PUBLIC);
    expect(connection.user).toEqual({
      id: ada.id,
      name: "Ada",
      email: ada.email,
    });
    expect(connection.token).toMatch(/^obr_/);

    // The Recorder guard takes the token as Ada's, on the Recorder's own routes.
    const me = await call(openbot, "/api/recorder/me", {
      headers: bearer(connection.token),
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      user: { id: ada.id, name: "Ada", email: ada.email },
      connectionId: connection.connectionId,
    });

    // One more connected browser, as any other.
    const listed = (await (
      await call(openbot, "/api/recorder/connections", { as: "ada" })
    ).json()) as RecorderConnectionsResponse;
    const mine = listed.connections.filter(
      (row) => row.id === connection.connectionId,
    );
    expect(mine).toEqual([
      expect.objectContaining({
        label: "OpenBot browser",
        via: "openbot-browser",
        extensionId: RECORDER_EXTENSION_ID,
        installId: computerId.slice("person-".length),
      }),
    ]);
    expect(
      audits.find(
        (event) =>
          event.eventType === "recorder.connected" &&
          event.targetId === connection.connectionId,
      )?.payload,
    ).toMatchObject({ via: "openbot-browser", label: "OpenBot browser" });

    // The browser's network policy went to its computer ahead of the browser: the open web and this OpenBot and the
    // Intelligence gateway by name, nothing inside the deployment.
    const policy = policies.get(computerId) as {
      mode: string;
      rules: { type: string; value: string }[];
    };
    expect(policy.mode).toBe("allowlist_only");
    expect(policy.rules).toContainEqual({
      type: "domain",
      value: "openbot.example.com",
    });
    expect(policy.rules).toContainEqual({
      type: "domain",
      value: "gateway.example.com",
    });
    expect(policy.rules.some((rule) => rule.value.startsWith("10."))).toBe(
      false,
    );

    // The state now shows the open browser, with its Recorder.
    expect(
      await (await call(openbot, "/api/browser", { as: "ada" })).json(),
    ).toMatchObject({
      available: true,
      computerId,
      open: true,
      browser: "chromium",
      window: "screen",
      narration: "external",
      recorder: { connected: true, userId: ada.id, phase: "idle" },
    });
  });

  test("a second open replaces the first token instead of adding a connection", async () => {
    await open(openbot, "ada");
    const first = handed(ada.id);
    await open(openbot, "ada");
    const second = handed(ada.id);
    expect(second.token).not.toBe(first.token);

    const before = await call(openbot, "/api/recorder/me", {
      headers: bearer(first.token),
    });
    expect(before.status).toBe(401);
    expect(((await before.json()) as { code: string }).code).toBe(
      RECORDER_SIGNED_OUT,
    );
    expect(
      (
        await call(openbot, "/api/recorder/me", {
          headers: bearer(second.token),
        })
      ).status,
    ).toBe(200);
    const live = await database
      .select({ id: recorderConnections.id })
      .from(recorderConnections)
      .where(eq(recorderConnections.userId, ada.id));
    const unrevoked = (
      await database
        .select()
        .from(recorderConnections)
        .where(eq(recorderConnections.userId, ada.id))
    ).filter((row) => row.revokedAt === null);
    expect(live.length).toBeGreaterThan(1);
    expect(unrevoked.map((row) => row.id)).toEqual([second.connectionId]);
    expect(
      audits.find(
        (event) =>
          event.eventType === "recorder.revoked" &&
          event.targetId === first.connectionId,
      )?.payload,
    ).toEqual({ connectionId: first.connectionId, reason: "replaced" });
  });

  test("the OpenBot browser's connection is disconnected from Settings, Browsers like any other", async () => {
    await open(openbot, "ada");
    const connection = handed(ada.id);
    const removed = await call(
      openbot,
      `/api/recorder/connections/${connection.connectionId}`,
      { method: "DELETE", as: "ada" },
    );
    expect(removed.status).toBe(204);
    expect(
      (
        await call(openbot, "/api/recorder/me", {
          headers: bearer(connection.token),
        })
      ).status,
    ).toBe(401);
  });

  test("record, narrate, tabs, navigate and close reach the person's browser and answer its state", async () => {
    await open(openbot, "ada");
    const computerId = personBrowserId(ada.id);
    const post = (path: string, json: unknown) =>
      call(openbot, path, { method: "POST", as: "ada", json });

    const started = await post("/api/browser/recording", {
      action: "start",
      title: "Refund order 1043",
    });
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({
      available: true,
      computerId,
      recorder: { phase: "recording", title: "Refund order 1043" },
    });
    // The Recorder's own refusal comes back as it said it.
    const again = await post("/api/browser/recording", {
      action: "start",
      title: "Again",
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: "A recording is already running.",
    });

    const phrase = {
      text: "refunding it now",
      startedAt: 1_000,
      endedAt: 2_000,
    };
    expect(await (await post("/api/browser/narration", phrase)).json()).toEqual(
      {
        ok: true,
      },
    );
    expect(browsers.get(computerId)?.narrated).toEqual([phrase]);
    expect(
      (
        await post("/api/browser/narration", {
          ...phrase,
          endedAt: phrase.startedAt - 1,
        })
      ).status,
    ).toBe(400);

    const tabs = await post("/api/browser/tabs", {
      action: "new",
      url: "https://example.com",
    });
    expect(((await tabs.json()) as BrowserApiState).tabs.at(-1)).toMatchObject({
      url: "https://example.com",
      active: true,
    });
    const went = await post("/api/browser/navigate", { url: "example.org/a" });
    expect(
      ((await went.json()) as BrowserApiState).tabs.find((tab) => tab.active)
        ?.url,
    ).toBe("example.org/a");
    // Only web addresses: on a computer in the cloud, file: would read the computer's own disk.
    for (const url of [
      "file:///profiles",
      "chrome://settings",
      "javascript:alert(1)",
    ]) {
      expect((await post("/api/browser/navigate", { url })).status).toBe(400);
      expect(
        (await post("/api/browser/tabs", { action: "new", url })).status,
      ).toBe(400);
    }
    expect(
      (await post("/api/browser/navigate", { url: "127.0.0.1:8080" })).status,
    ).toBe(200);

    const stopped = await post("/api/browser/recording", { action: "stop" });
    expect(((await stopped.json()) as BrowserApiState).recorder?.phase).toBe(
      "idle",
    );
    const closed = await call(openbot, "/api/browser/close", {
      method: "POST",
      as: "ada",
    });
    expect(await closed.json()).toMatchObject({
      available: true,
      computerId,
      open: false,
    });
    // A form from another site cannot send any of these.
    expect(
      (
        await call(openbot, "/api/browser/recording", {
          method: "POST",
          as: "ada",
          headers: { "content-type": "text/plain" },
          body: '{"action":"stop"}',
        })
      ).status,
    ).toBe(415);
  });

  test("each person reaches only their own browser", async () => {
    await open(openbot, "ada");
    const benOpened = await open(openbot, "ben");
    expect(benOpened.computerId).toBe(personBrowserId(ben.id));
    expect(handed(ben.id).user.id).toBe(ben.id);
    expect(
      asked.filter((line) => line.endsWith(personBrowserId(ben.id))).length,
    ).toBeGreaterThan(0);
    // Ben's token is Ben's, never Ada's.
    expect(
      await (
        await call(openbot, "/api/recorder/me", {
          headers: bearer(handed(ben.id).token),
        })
      ).json(),
    ).toMatchObject({ user: { id: ben.id } });
  });
});

describe("a person's browser on the computer routes and the live screen", () => {
  const adaBrowser = () => personBrowserId(ada.id);

  test("its person reads who holds the wheel; nobody else does, an admin included, and nothing that acts as a Bot answers", async () => {
    const control = await call(
      openbot,
      `/api/computers/${adaBrowser()}/control`,
      {
        as: "ada",
      },
    );
    expect(control.status).toBe(200);
    expect(await control.json()).toEqual({
      holder: "human",
      transitioning: false,
    });
    for (const as of ["ben", "admin"] as const) {
      const refused = await call(
        openbot,
        `/api/computers/${adaBrowser()}/control`,
        { as },
      );
      expect(refused.status).toBe(404);
    }
    for (const [method, path] of [
      ["POST", "navigate"],
      ["POST", "exec"],
      ["POST", "files/list"],
      ["POST", "computers/stop"],
      ["POST", "control/take"],
      ["GET", "files/download"],
    ] as const) {
      const refused = await call(
        openbot,
        `/api/computers/${adaBrowser()}/${path}`,
        { method, as: "ada", json: method === "POST" ? {} : undefined },
      );
      expect(refused.status).toBe(404);
    }
  });

  test("the live screen streams to its person and refuses everyone else, an admin included", async () => {
    const server = startHttpServer({
      port: SERVER_PORT,
      config: openbot.config,
      resolveRequestActor: async (request) => {
        const person = personOf(request.headers.get("cookie"));
        if (!person) throw new Error("Sign in first.");
        return {
          id: person.id,
          name: person.name,
          role: person === admin ? "admin" : "user",
        };
      },
      agentProfileStore: { get: async () => null } as never,
      computerGateway: openbot.gateway,
      demonstrationStore: {
        active: async () => {
          throw new Error("A person's browser is never a demonstration.");
        },
      } as never,
      demonstrationRecorder: {} as never,
      app: openbot.app,
    });
    try {
      const watch = (as: keyof typeof PEOPLE, id = adaBrowser()) =>
        new Promise<string>((resolve) => {
          const socket = new WebSocket(
            `ws://127.0.0.1:${SERVER_PORT}/api/computers/${encodeURIComponent(id)}/stream`,
            { headers: { cookie: `test-session=${as}` } } as never,
          );
          socket.onmessage = (event) => {
            resolve(String(event.data));
            socket.close();
          };
          socket.onerror = () => resolve("refused");
          socket.onclose = () => resolve("refused");
        });
      expect(JSON.parse(await watch("ada"))).toEqual({
        type: "frame",
        bot: adaBrowser(),
      });
      expect(await watch("ben")).toBe("refused");
      expect(await watch("admin")).toBe("refused");
      // A plain request names the reason.
      const plain = await fetch(
        `http://127.0.0.1:${SERVER_PORT}/api/computers/${adaBrowser()}/stream`,
        {
          headers: { cookie: "test-session=admin", upgrade: "websocket" },
        },
      );
      expect(plain.status).toBe(404);
    } finally {
      await server.stop(true);
    }
  });
});

describe("where the browser reaches this OpenBot", () => {
  test("the configured public origin, else this machine's own window, else the app's address; never another site", () => {
    const at = (environment: { publicUrl?: string; appUrl?: string }) =>
      openbotAddress({
        publicUrl: environment.publicUrl,
        appUrl: environment.appUrl,
      });
    expect(at({ publicUrl: "https://openbot.example.com/" })(undefined)).toBe(
      "https://openbot.example.com",
    );
    // OpenBot Desktop: no public URL, and its window found its own loopback address.
    const desktop = at({ appUrl: "http://localhost:3010" });
    expect(desktop("http://[::1]:3010")).toBe("http://[::1]:3010");
    expect(desktop("http://127.0.0.1:3010")).toBe("http://127.0.0.1:3010");
    expect(desktop(undefined)).toBe("http://127.0.0.1:3010");
    // A request from another site never names the address the token goes to.
    expect(at({})("https://evil.example")).toBeNull();
    expect(
      at({ appUrl: "https://app.example.com" })("https://evil.example"),
    ).toBe("https://app.example.com");
    // An address the Recorder would refuse is no answer: plain http to another machine.
    expect(
      at({ publicUrl: "http://openbot.internal:3001" })(undefined),
    ).toBeNull();
  });

  test("open says so when there is no address the Recorder would connect to", async () => {
    const nowhere = build({
      OPENBOT_PUBLIC_URL: "http://openbot.internal:3001",
      BETTER_AUTH_URL: "http://openbot.internal:3001",
      TRUSTED_ORIGINS: "http://openbot.internal:3010",
    });
    const refused = await call(nowhere, "/api/browser/open", {
      method: "POST",
      as: "ada",
    });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({
      error:
        "This OpenBot has no address your browser can reach it at. An admin sets OPENBOT_PUBLIC_URL to its https address.",
    });
  });
});

describe("organization mode", () => {
  const SESSION_COOKIE = "better-auth.session_token=organization-fixture";
  const person = {
    id: `${prefix}-org`,
    email: `${prefix}-org@example.test`,
    name: "Organization Person",
    image: null,
    role: "user" as const,
  };
  let signedIn = true;
  const authority = Bun.serve({
    hostname: "127.0.0.1",
    port: AUTHORITY_PORT,
    fetch: (request) =>
      request.headers.get("cookie") === SESSION_COOKIE && signedIn
        ? Response.json({ user: person })
        : new Response(null, { status: 401 }),
  });
  afterAll(() => authority.stop(true));

  test("open seals the person's organization session from this request, as the connect-code route does", async () => {
    // The guard keeps the organization's answer for a minute on the clock it was built with, so the clock that moves
    // past it goes in first.
    const realNow = Date.now;
    let skewMs = 0;
    Date.now = () => realNow() + skewMs;
    try {
      await sealed(() => {
        skewMs += 61_000;
      });
    } finally {
      Date.now = realNow;
    }
  });

  async function sealed(pastTheCache: () => void) {
    const organizationAuth = createOrganizationAuth({
      authorityUrl: `http://127.0.0.1:${AUTHORITY_PORT}`,
      materializeUser: organizationUserStore(database),
    });
    const org = build(
      {
        OPENBOT_ORGANIZATION_AUTH_URL: `http://127.0.0.1:${AUTHORITY_PORT}`,
      },
      { auth: organizationAuth, organizationAuth },
    );
    const APP = "http://127.0.0.1:3010";
    const handoff = await org.app.request(
      `${APP}/api/auth/organization/session`,
      {
        method: "POST",
        headers: { origin: APP, "content-type": "application/json" },
        body: JSON.stringify({ cookie: SESSION_COOKIE }),
      },
    );
    expect(handoff.status).toBe(200);
    const { ticket } = (await handoff.json()) as { ticket: string };
    const consumed = await org.app.request(
      `${APP}/api/auth/organization/session?ticket=${ticket}`,
    );
    const cookie = consumed.headers.get("set-cookie")?.split(";")[0] as string;
    expect(cookie).toStartWith("openbot.organization-session=");

    const opened = await org.app.request(`${APP}/api/browser/open`, {
      method: "POST",
      headers: { cookie },
    });
    expect(opened.status).toBe(200);
    const userId = ((await opened.json()) as BrowserOpenResponse).computerId;
    const [row] = await database
      .select()
      .from(recorderConnections)
      .where(eq(recorderConnections.via, "openbot-browser"))
      .then((rows) =>
        rows.filter(
          (candidate) =>
            candidate.revokedAt === null &&
            personBrowserId(candidate.userId) === userId,
        ),
      );
    expect(row?.organizationSession).toBeTruthy();
    expect(
      await decryptSecret(
        org.config.keyEncryptionKey,
        row?.organizationSession as string,
      ),
    ).toBe(cookie.slice(cookie.indexOf("=") + 1));

    // The Recorder's token stands while the organization says the person is signed in, and ends when it says not.
    const token = (
      browsers.get(userId)?.connection as { token: string } | undefined
    )?.token as string;
    const me = () =>
      org.app.request(`${APP}/api/recorder/me`, { headers: bearer(token) });
    expect((await me()).status).toBe(200);
    signedIn = false;
    pastTheCache();
    const out = await me();
    expect(out.status).toBe(401);
    expect(await out.json()).toMatchObject({
      code: RECORDER_SIGNED_OUT,
      reason: "organization",
    });
  }
});

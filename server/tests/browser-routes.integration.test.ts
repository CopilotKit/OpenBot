// A person's own OpenBot browser, through the real routes and the real database: opening it mints the person's Recorder
// connection with no Connect step, the connection resolves through the Recorder guard as that person, each open
// replaces the last, organization mode seals the session from the request, and nobody else (an admin included) reaches
// the browser or its live screen. The computer is a stand-in that answers its routes exactly as the contract types them
// (shared/openbot-browser.ts): slice 1 builds the real ones.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BROWSER_ABSENCES,
  type BrowserApiState,
  type BrowserOpenResponse,
  type BrowserState,
  browserNarrationRequestSchema,
  browserNavigateRequestSchema,
  browserOpenRequestSchema,
  browserRecordingRequestSchema,
  browserTabsRequestSchema,
  isPersonBrowserId,
  type LauncherConnection,
  type LauncherState,
} from "@openbot/shared/openbot-browser";
import {
  RECORDER_SIGNED_OUT,
  type RecorderConnectionsResponse,
} from "@openbot/shared/recorder-api";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import { eq, inArray } from "drizzle-orm";
import { NOT_ITS_OWN_COMPUTER } from "../../agent-computer/src/person-access";
import { NO_INSTALLED_BROWSER } from "../../agent-computer/src/person-launch";
import { createApp } from "../src/app";
import type { AuditEventInput } from "../src/audit";
import { DEV_ACTOR, initializeDevActorUser } from "../src/auth/dev-actor";
import { createOrganizationAuth } from "../src/auth/organization";
import { organizationUserStore } from "../src/auth/organization-store";
import { openbotAddress } from "../src/browser/address";
import { personBrowserEgressPolicy } from "../src/browser/egress";
import {
  gatewayBrowserComputers,
  personBrowserPlace,
  personBrowserRefusal,
  SHARED_COMPUTER,
  withPersonBrowsers,
} from "../src/browser/host";
import { personBrowserId } from "../src/browser/person";
import {
  browserRequestSeconds,
  CALL_BUDGET_MS,
  CALL_TIMEOUT_MS,
  OPEN_BUDGET_MS,
  STATE_TIMEOUT_MS,
} from "../src/browser/routes";
import { botSeat, type ComputerSeat } from "../src/computer/computer-key";
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
import {
  recorderConnectCodes,
  recorderConnections,
} from "../src/db/schema/recorder";
import { startHttpServer } from "../src/http-server";
import { createRecorderConnectionStore } from "../src/recorder/connections";
import { createRecorderExtension } from "../src/recorder/wiring";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { SESSION_LIFETIME_MS, testEnvironment } from "./support/environment";

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
// Their own ports: the stand-in computer, the server the live screen is proxied through, the organization's sign-in
// server, and a port nothing listens on.
const COMPUTER_PORT = 7761;
const SERVER_PORT = 7762;
const AUTHORITY_PORT = 7763;
const NOTHING_PORT = 7764;
/** The real computer one test runs, on a port of its own. */
const REAL_COMPUTER_PORT = 7815;
/** The real shared computer another runs. */
const SHARED_COMPUTER_PORT = 7816;
/** What the person is told when their browser cannot open for OpenBot's own setup. */
const NOT_SET_UP =
  "Your browser can't open right now. Ask an admin to check OpenBot's setup.";
/** The same, on a single-user OpenBot (OpenBot Desktop), where the person is the admin. */
const NOT_SET_UP_SINGLE_USER =
  "Your browser can't open right now. Quit OpenBot, open it again, and try once more.";

// ---- The stand-in computer --------------------------------------------------------------------

type Opened = {
  state: BrowserState;
  connection: unknown;
  narrated: unknown[];
  /** The token the Recorder held when its recording started: the one its capture passes will carry. */
  recordedUnder?: string;
};
const browsers = new Map<string, Opened>();
/**
 * The connection each browser's Recorder keeps in its profile, as the Recorder keeps it in `chrome.storage.local`: it
 * outlives the browser being closed, and a browser opened again with no new connection starts out holding it. Until
 * the Recorder forgets it (a disconnect).
 */
const recorderKeeps = new Map<string, LauncherConnection>();
const policies = new Map<string, unknown>();
/** Every request the computer took, as `<method> <path> <browser>`. */
const asked: string[] = [];
/** How the computer answers the next open instead of opening, when a test says so. */
let refuseNextOpen: { status: number; error: string } | null = null;
/** How the computer answers the next navigation, when a test says so: after `ms`, with `error` and `status`, as the real
 * one answers a page that did not load in its navigation timeout; or not until `never` settles. */
let slowNextNavigation:
  | { ms: number; status: number; error: string }
  | { never: Promise<void> }
  | null = null;
/** How long the computer takes over the next open, when a test says so: a cold computer launching a browser. */
let slowNextOpen: number | null = null;
/** How the computer answers the next disconnect instead of telling the Recorder, when a test says so: with `status`, as
 * a computer with no such route answers; or not until `never` settles. */
let refuseNextDisconnect: { status: number } | { never: Promise<void> } | null =
  null;
/**
 * How the computer answers the state while a test says the person's browser is not answering: as the real one does
 * (agent-computer's browser-host.ts), a 504 with its sentence once the browser has not answered in 5 s; or, for a
 * computer that is itself stuck, not until `never` settles.
 */
let silentState: { answers: true } | { never: Promise<void> } | null = null;
/** What the real computer answers when the browser did not answer (agent-computer's NOT_ANSWERING). */
const COMPUTER_NOT_ANSWERING = "The browser did not answer within 5 s.";
/** The window an open shows its browser in: a screen (hosted OpenBot) unless a test opens a native one (Desktop). */
let openAs: "screen" | "native" = "screen";
/**
 * When a test says so, the Recorder takes a connection as the real one does (extension/src/background/launcher.ts): it
 * asks OpenBot who the connection is for, `askMs` after it was handed it, and refuses one OpenBot answers is signed out,
 * with its own sentence, which the computer answers as a Recorder that could not be connected.
 */
let confirmOpens: {
  askMs: number;
  /** OpenBot's status for `/api/recorder/me` with this token. */
  me: (token: string) => Promise<number>;
} | null = null;

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
    const sent = request.method === "POST" ? await request.text() : "";
    const body = sent ? JSON.parse(sent) : undefined;
    const opened = browsers.get(id);
    const closed: BrowserState = { open: false, tabs: [] };
    switch (url.pathname) {
      case "/browser/state":
        if (opened && silentState && "never" in silentState) {
          await silentState.never;
        } else if (opened && silentState)
          return Response.json(
            { error: COMPUTER_NOT_ANSWERING },
            { status: 504 },
          );
        return Response.json(opened?.state ?? closed);
      case "/browser/open": {
        if (refuseNextOpen) {
          const { status, error } = refuseNextOpen;
          refuseNextOpen = null;
          return Response.json({ error }, { status });
        }
        const parsed = browserOpenRequestSchema.safeParse(body);
        if (!parsed.success)
          return Response.json({ error: "Bad request." }, { status: 400 });
        if (slowNextOpen !== null) {
          const ms = slowNextOpen;
          slowNextOpen = null;
          await Bun.sleep(ms);
        }
        const brought = parsed.data.connection;
        // An open that brings no connection hands the Recorder nothing: an open browser is as it was, and a closed one
        // opens with its Recorder holding what it kept (agent-computer's browser-host.ts).
        if (!brought && opened) return Response.json(opened.state);
        if (brought && confirmOpens) {
          await Bun.sleep(confirmOpens.askMs);
          if ((await confirmOpens.me(brought.token)) === 401)
            return Response.json(
              {
                error:
                  "The Recorder could not be connected: OpenBot did not accept this browser's connection. Open the browser from OpenBot again.",
              },
              { status: 502 },
            );
        }
        const holds = brought ?? recorderKeeps.get(id);
        if (brought) recorderKeeps.set(id, brought);
        const native = openAs === "native";
        const narration = native
          ? { narration: "own" as const, voice: "off" as const }
          : { narration: "external" as const };
        const next: Opened = {
          connection: holds,
          narrated: [],
          state: {
            open: true,
            browser: native ? "chrome" : "chromium",
            window: openAs,
            recorder: holds
              ? {
                  connected: true,
                  userId: holds.user.id,
                  connectionId: holds.connectionId,
                  phase: "idle",
                  actions: 0,
                  ...narration,
                }
              : { connected: false, phase: "idle", actions: 0, ...narration },
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
          // The Recorder's own refusals, in its words (extension/src/background/launcher.ts, recording.ts).
          if (!recorder.connected)
            return Response.json(
              { error: "Connect this browser to OpenBot first." },
              { status: 409 },
            );
          if (recorder.phase !== "idle")
            return Response.json(
              { error: "A recording is already running." },
              { status: 409 },
            );
          opened.recordedUnder = (opened.connection as { token: string }).token;
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
        const slow = slowNextNavigation;
        slowNextNavigation = null;
        if (slow && "never" in slow) {
          await slow.never;
          return Response.json(opened.state);
        }
        if (slow) {
          await Bun.sleep(slow.ms);
          return Response.json({ error: slow.error }, { status: slow.status });
        }
        if ("url" in parsed.data) {
          const url = parsed.data.url;
          opened.state.tabs = opened.state.tabs.map((tab) =>
            tab.active ? { ...tab, url } : tab,
          );
        }
        return Response.json(opened.state);
      }
      case "/browser/disconnect": {
        // A POST with no body. The Recorder forgets its connection as it does when OpenBot answers that its token is
        // gone, and reports what it reports then (extension/src/background/launcher.ts): a recording under it stopped.
        if (request.method !== "POST" || sent !== "")
          return Response.json({ error: "Bad request." }, { status: 400 });
        const refusal = refuseNextDisconnect;
        refuseNextDisconnect = null;
        if (refusal && "never" in refusal) await refusal.never;
        else if (refusal)
          return Response.json(
            { error: "Not found." },
            { status: refusal.status },
          );
        if (!opened)
          return Response.json(
            { error: "This browser is not open. Open it first." },
            { status: 409 },
          );
        recorderKeeps.delete(id);
        opened.state.recorder = {
          connected: false,
          phase: "idle",
          actions: 0,
          narration: "own",
          voice: "off",
        };
        return Response.json(opened.state);
      }
      case "/browser/close":
        browsers.delete(id);
        return Response.json(closed);
      case "/browser/clear":
        // A POST with no body. As the computer clears it (agent-computer's browser-host.ts): the browser closed and its
        // whole profile deleted, the Recorder's storage with it, so the connection the Recorder kept goes too. It stays
        // closed: only OpenBot can hand the Recorder a connection again.
        if (request.method !== "POST" || sent !== "")
          return Response.json({ error: "Bad request." }, { status: 400 });
        browsers.delete(id);
        recorderKeeps.delete(id);
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
    /** The token the browser routes call the computer with, in place of the right one. */
    token?: string;
    /** The Bots' computer provider, in place of the stand-in computer as a computer of each one's own. */
    provider?: ComputerProvider;
    /** How long the browser routes wait for the computer, in place of their own deadline. */
    callTimeoutMs?: number;
    /** Each browser route's budget, in place of its own. */
    budgetMs?: { open?: number; call?: number };
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
    withPersonBrowsers(options.provider ?? ownComputers(), config.browser?.url),
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
    sessionLifetimeMs: SESSION_LIFETIME_MS,
    auditStore,
  });
  const args = [config] as unknown as Parameters<typeof createApp>;
  args[1] = (options.auth ?? better) as never;
  args[2] = roleRepository;
  args[7] = gateway;
  args[8] = {} as never;
  args[12] = auditStore;
  const place = personBrowserPlace({
    provider,
    browserUrl: config.browser?.url,
    ...(config.browserAbsent ? { absent: config.browserAbsent } : {}),
    computers: () => gatewayBrowserComputers(gateway, config.browser?.url),
  });
  args[34] = {
    recorder,
    browser: {
      ...(options.computers === false ? {} : place),
      token: options.token ?? COMPUTER_TOKEN,
      recorder,
      openbotUrl: openbotAddress(config),
      singleUser: config.singleUser,
      ...(options.callTimeoutMs
        ? { callTimeoutMs: options.callTimeoutMs }
        : {}),
      ...(options.budgetMs ? { budgetMs: options.budgetMs } : {}),
    },
  };
  return { app: createApp(...args), gateway, config };
}

type OpenBot = ReturnType<typeof build>;

/**
 * The stand-in computer as a provider that gives every computer named its own, as a supervisor or a Sandbox does: where
 * a person's browser may run. The same calls as the shared provider's, which is how the stand-in is reached.
 */
function ownComputers(): ComputerProvider {
  return {
    ...createSharedComputerProvider({
      baseUrl: `http://127.0.0.1:${COMPUTER_PORT}`,
      token: COMPUTER_TOKEN,
    }),
    name: "docker",
    isolation: "per-person",
  };
}

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
      shows: "screen",
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
      isolation: "per-person",
      locate: async ({ botId }: ComputerSeat) => {
        started.push(botId);
        return `http://127.0.0.1:${COMPUTER_PORT}`;
      },
      status: async ({ botId }: ComputerSeat) => ({
        botId,
        state: "absent" as const,
      }),
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
        shows: "screen",
        computerId: personBrowserId(ben.id),
        open: false,
        tabs: [],
      });
    expect(started).toEqual([]);
    expect(asked.slice(before)).toEqual([]);
  });

  test("the state says where the browser shows before it is opened: a window on the desktop on OpenBot Desktop, a screen elsewhere", async () => {
    // The sidebar's Browser button reads this on every load to know what one click does, so it is said with no browser
    // open, from where people's browsers run here, and asking it starts nothing.
    const started: string[] = [];
    const bots = {
      name: "docker",
      isolation: "per-person",
      locate: async ({ botId }: ComputerSeat) => {
        started.push(botId);
        return `http://127.0.0.1:${COMPUTER_PORT}`;
      },
      status: async ({ botId }: ComputerSeat) => ({
        botId,
        state: "absent" as const,
      }),
      stop: async () => ({ wasRunning: false }),
      reset: async () => ({ cleared: false }),
      list: async () => [],
    } satisfies ComputerProvider;
    // OpenBot Desktop: people's browsers run on its host-side local Chrome computer, here one that is not answering
    // (Chrome closed, the computer restarting), and Bots' computers stay where they are.
    const desktop = build(
      { OPENBOT_BROWSER_URL: `http://127.0.0.1:${NOTHING_PORT}` },
      { provider: bots },
    );
    const before = asked.length;
    const { result: answered } = await logged(async () =>
      (await call(desktop, "/api/browser", { as: "ben" })).json(),
    );
    expect(answered).toEqual({
      available: true,
      shows: "native",
      computerId: personBrowserId(ben.id),
      open: false,
      tabs: [],
      // The person's own browsers, which a computer that is not answering cannot list.
      real: { connected: false, browsers: [] },
    });
    expect(started).toEqual([]);
    expect(asked.slice(before)).toEqual([]);

    // Hosted: the computers Bots run on run people's browsers too, and the app shows them as a screen.
    const hosted = build({}, { provider: bots });
    expect(
      await (await call(hosted, "/api/browser", { as: "ben" })).json(),
    ).toMatchObject({ available: true, shows: "screen", open: false });
    expect(started).toEqual([]);

    // Once it is open the state still says where it shows, beside the window the browser reports.
    openAs = "native";
    try {
      const native = build({
        OPENBOT_BROWSER_URL: `http://127.0.0.1:${COMPUTER_PORT}`,
      });
      const opened = await open(native, "ben");
      expect(opened.window).toBe("native");
      expect(
        await (await call(native, "/api/browser", { as: "ben" })).json(),
      ).toMatchObject({
        available: true,
        shows: "native",
        open: true,
        window: "native",
      });
      await call(native, "/api/browser/close", { method: "POST", as: "ben" });
    } finally {
      openAs = "screen";
    }
  });

  test("on OpenBot Desktop with no Chrome or Edge it can open, the state says why in a sentence for the person", async () => {
    // With Chrome or Edge somewhere OpenBot Desktop did not look, or installed only as a Flatpak, the reason used to be
    // only in Desktop's log. Desktop now names it to the server, which says it to the person.
    const flatpak = build({ OPENBOT_BROWSER_ABSENT: "flatpak-chrome" });
    expect(
      await (await call(flatpak, "/api/browser", { as: "ben" })).json(),
    ).toEqual({
      available: true,
      shows: "screen",
      note: BROWSER_ABSENCES["flatpak-chrome"],
      computerId: personBrowserId(ben.id),
      open: false,
      tabs: [],
    } satisfies BrowserApiState);
    expect(BROWSER_ABSENCES["flatpak-chrome"]).toBe(
      "OpenBot can't open the Flatpak version of Google Chrome, so install Chrome from google.com/chrome to use your own browser.",
    );
    // With no computers for it at all, the same sentence is why it cannot open.
    const nothing = build(
      { OPENBOT_BROWSER_ABSENT: "no-chrome-or-edge" },
      { computers: false },
    );
    expect(
      await (await call(nothing, "/api/browser", { as: "ben" })).json(),
    ).toMatchObject({ available: false });
    // A name this server does not know, and a browser that does run, explain nothing.
    for (const environment of [
      { OPENBOT_BROWSER_ABSENT: "a-reason-from-a-newer-desktop" },
      {
        OPENBOT_BROWSER_ABSENT: "no-chrome-or-edge",
        OPENBOT_BROWSER_URL: `http://127.0.0.1:${NOTHING_PORT}`,
      },
    ])
      expect(
        await (
          await call(build(environment), "/api/browser", { as: "ben" })
        ).json(),
      ).not.toHaveProperty("note");
  });

  test("OpenBot Desktop's host-side computer carries people's browsers, while Bots' computers stay where they are", async () => {
    const bots = {
      name: "docker",
      isolation: "per-person",
      locate: async () => "http://127.0.0.1:4300/bot-computer",
      status: async ({ botId }: ComputerSeat) => ({
        botId,
        state: "absent" as const,
      }),
      stop: async () => ({ wasRunning: false }),
      reset: async () => ({ cleared: false }),
      list: async () => [],
    } satisfies ComputerProvider;
    const desktop = withPersonBrowsers(bots, "http://127.0.0.1:4101");
    expect(await desktop.locate(botSeat(personBrowserId(ada.id)))).toBe(
      "http://127.0.0.1:4101",
    );
    expect(
      await desktop.status(botSeat(personBrowserId(ada.id))),
    ).toMatchObject({
      state: "ready",
    });
    expect(await desktop.locate(botSeat("agent_7"))).toBe(
      "http://127.0.0.1:4300/bot-computer",
    );
    expect(await desktop.status(botSeat("agent_7"))).toMatchObject({
      state: "absent",
    });
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
    // Intelligence gateway by name on their own ports, nothing inside the deployment.
    const policy = policies.get(computerId) as {
      mode: string;
      rules: { type: string; value: string; ports?: string }[];
    };
    expect(policy.mode).toBe("allowlist_only");
    expect(policy.rules).toContainEqual({
      type: "domain",
      value: "openbot.example.com",
      ports: "443",
    });
    expect(policy.rules).toContainEqual({
      type: "domain",
      value: "gateway.example.com",
      ports: "443",
    });
    expect(policy.rules.some((rule) => rule.value.startsWith("10."))).toBe(
      false,
    );
    // Pushed before the browser opened: the computer's filter refuses everything for a browser it has no policy for.
    const pushedAt = asked.indexOf(`PUT /egress-policy ${computerId}`);
    expect(pushedAt).toBeGreaterThanOrEqual(0);
    expect(pushedAt).toBeLessThan(
      asked.indexOf(`POST /browser/open ${computerId}`),
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

  test("opening it again keeps the connection that stands: no new token, and nothing on the trail", async () => {
    // The end-to-end run: every open, and many a Record, revoked the browser's connection and made another, a
    // `recorder.revoked` and a `recorder.connected` row each time.
    await open(openbot, "ada");
    const first = handed(ada.id);
    const trail = () =>
      audits.filter(
        (event) =>
          (event.eventType === "recorder.connected" ||
            event.eventType === "recorder.revoked") &&
          event.actorUserId === ada.id,
      ).length;
    const rows = trail();

    // Again while it is open, and again after it was closed: its Recorder kept the connection in its profile.
    await open(openbot, "ada");
    await call(openbot, "/api/browser/close", { method: "POST", as: "ada" });
    const reopened = await open(openbot, "ada");
    expect(reopened.narration).toBe("external");
    expect(handed(ada.id).token).toBe(first.token);
    expect(trail()).toBe(rows);
    expect(
      (
        await call(openbot, "/api/recorder/me", {
          headers: bearer(first.token),
        })
      ).status,
    ).toBe(200);
    const unrevoked = (
      await database
        .select()
        .from(recorderConnections)
        .where(eq(recorderConnections.userId, ada.id))
    ).filter((row) => row.revokedAt === null);
    expect(unrevoked.map((row) => row.id)).toEqual([first.connectionId]);
  });

  test("a Recorder that does not hold the connection that stands is handed a new one, which replaces it", async () => {
    await open(openbot, "ada");
    const first = handed(ada.id);
    // The Recorder in the open browser holds some other connection than the one OpenBot holds for it.
    const opened = browsers.get(personBrowserId(ada.id));
    if (!opened?.state.recorder) throw new Error("Ada's browser is open.");
    opened.state.recorder = {
      ...opened.state.recorder,
      connectionId: "another-connection",
    };
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
    const unrevoked = (
      await database
        .select()
        .from(recorderConnections)
        .where(eq(recorderConnections.userId, ada.id))
    ).filter((row) => row.revokedAt === null);
    expect(unrevoked.map((row) => row.id)).toEqual([second.connectionId]);
    expect(
      audits.find(
        (event) =>
          event.eventType === "recorder.revoked" &&
          event.targetId === first.connectionId,
      )?.payload,
    ).toEqual({
      connectionId: first.connectionId,
      via: "openbot-browser",
      reason: "replaced",
    });
  });

  test("a connection that no longer stands is not kept: the next open makes a new one", async () => {
    await open(openbot, "ada");
    const first = handed(ada.id);
    // Disconnected in Settings, Browsers, which also tells the browser to forget it.
    expect(
      (
        await call(openbot, `/api/recorder/connections/${first.connectionId}`, {
          method: "DELETE",
          as: "ada",
        })
      ).status,
    ).toBe(204);
    await open(openbot, "ada");
    const next = handed(ada.id);
    expect(next.token).not.toBe(first.token);
    expect(
      audits.filter(
        (event) =>
          event.eventType === "recorder.connected" &&
          event.targetId === next.connectionId,
      ),
    ).toHaveLength(1);
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

    const now = Date.now();
    const phrase = {
      text: "refunding it now",
      startedAt: now - 2_000,
      endedAt: now - 1_000,
      sentAt: now,
    };
    expect(await (await post("/api/browser/narration", phrase)).json()).toEqual(
      {
        ok: true,
      },
    );
    expect(browsers.get(computerId)?.narrated).toEqual([
      expect.objectContaining({ text: phrase.text }),
    ]);
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

  test("the computer's refusals reach the person as theirs, and its own failings never read as the person's", async () => {
    // No Chrome or Edge here, in the computer's own words (agent-computer's browser-host.ts answers it 503): OpenBot's
    // setup, which the person is told is why their browser cannot open, and who can see to it.
    refuseNextOpen = { status: 503, error: NO_INSTALLED_BROWSER };
    const { result: unavailable, warned } = await logged(() =>
      call(openbot, "/api/browser/open", { method: "POST", as: "ada" }),
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: NOT_SET_UP });
    // The computer's sentence is in the server's log, for whoever runs OpenBot.
    expect(
      warned
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.type === "browser-computer-failed"),
    ).toEqual([
      {
        type: "browser-computer-failed",
        path: "/browser/open",
        status: 503,
        error: NO_INSTALLED_BROWSER,
      },
    ]);
    // The Recorder refused: its sentence, as a conflict.
    refuseNextOpen = {
      status: 409,
      error:
        "Your organization's Recorder policy does not allow this OpenBot. Ask your IT team.",
    };
    const refused = await call(openbot, "/api/browser/open", {
      method: "POST",
      as: "ada",
    });
    expect(refused.status).toBe(409);
    // The Recorder could not be reached in it: the computer failed, with what it said.
    refuseNextOpen = {
      status: 502,
      error: "The Recorder in your browser does not offer its launcher.",
    };
    const failed = await call(openbot, "/api/browser/open", {
      method: "POST",
      as: "ada",
    });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({
      error: "The Recorder in your browser does not offer its launcher.",
    });
    // OpenBot calling its computer with the wrong token is not the person signed out.
    const misconfigured = build({}, { token: "not-the-computer-token" });
    const wrong = await call(misconfigured, "/api/browser/open", {
      method: "POST",
      as: "ada",
    });
    expect(wrong.status).toBe(502);
    expect(await wrong.json()).toEqual({
      error: "Your browser could not be reached. Try again.",
    });
  });

  test("a computer with no built Recorder: the person is told their browser cannot open, and the setup sentence stays in both logs", async () => {
    // The fourth end-to-end run: with the Recorder missing on the computer, the Browser page showed the computer's
    // sentence naming OPENBOT_RECORDER_DIR and a build command. The real computer, its Recorder directory empty.
    const dir = await mkdtemp(join(tmpdir(), "openbot-no-recorder-"));
    await Promise.all(
      ["recorder", "profiles", "workspace"].map((name) =>
        mkdir(join(dir, name)),
      ),
    );
    const realComputer = Bun.spawn(
      [process.execPath, "--no-env-file", "src/index.ts"],
      {
        cwd: fileURLToPath(new URL("../../agent-computer", import.meta.url)),
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          TMPDIR: tmpdir(),
          COMPUTER_TOKEN,
          PORT: String(REAL_COMPUTER_PORT),
          PROFILES_DIR: join(dir, "profiles"),
          WORKSPACE_DIR: join(dir, "workspace"),
          OPENBOT_RECORDER_DIR: join(dir, "recorder"),
          // Started for Ada's browser alone, as a supervisor starts the container it makes for it.
          COMPUTER_BOT_ID: personBrowserId(ada.id),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const base = `http://127.0.0.1:${REAL_COMPUTER_PORT}`;
      const deadline = Date.now() + 20_000;
      while (
        !(await fetch(`${base}/health`).then(
          (response) => response.ok,
          () => false,
        ))
      ) {
        if (Date.now() > deadline || realComputer.exitCode !== null)
          throw new Error("The computer did not start.");
        await Bun.sleep(100);
      }
      const onRealComputer = build(
        {},
        {
          provider: {
            ...createSharedComputerProvider({
              baseUrl: base,
              token: COMPUTER_TOKEN,
            }),
            isolation: "per-person",
          },
        },
      );
      const { result, warned } = await logged(() =>
        call(onRealComputer, "/api/browser/open", {
          method: "POST",
          as: "ada",
        }),
      );
      expect(result.status).toBe(503);
      expect(await result.json()).toEqual({ error: NOT_SET_UP });

      // The computer's own sentence, for whoever runs OpenBot, in the server's log and in the computer's.
      const failures = warned
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.type === "browser-computer-failed");
      expect(failures).toEqual([
        {
          type: "browser-computer-failed",
          path: "/browser/open",
          status: 503,
          error: expect.stringContaining("OPENBOT_RECORDER_DIR"),
        },
      ]);
      realComputer.kill();
      await realComputer.exited;
      const computerLog = await new Response(realComputer.stdout).text();
      const opened = computerLog
        .split("\n")
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>];
          } catch {
            return [];
          }
        })
        .filter((line) => line.type === "computer-browser-open-failed");
      expect(opened).toEqual([
        expect.objectContaining({
          step: "recorder-files",
          status: 503,
          error: failures[0]?.error,
        }),
      ]);
    } finally {
      realComputer.kill();
      await realComputer.exited;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the computer refuses a person's browser on itself where Bots run, whatever the server was told", async () => {
    // The computer's half of keeping a person's browser off the computer Bots share: a server configured to think the
    // shared computer is a computer of its own (a provider that says per-bot, a stray OPENBOT_BROWSER_URL) still cannot
    // open a person's browser beside Bots.
    const dir = await mkdtemp(join(tmpdir(), "openbot-shared-computer-"));
    await Promise.all(
      ["profiles", "workspace"].map((name) => mkdir(join(dir, name))),
    );
    const sharedComputer = Bun.spawn(
      [process.execPath, "--no-env-file", "src/index.ts"],
      {
        cwd: fileURLToPath(new URL("../../agent-computer", import.meta.url)),
        // The shared computer: started for nobody in particular, as compose and the chart's shared mode start it.
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          TMPDIR: tmpdir(),
          COMPUTER_TOKEN,
          PORT: String(SHARED_COMPUTER_PORT),
          PROFILES_DIR: join(dir, "profiles"),
          WORKSPACE_DIR: join(dir, "workspace"),
          OPENBOT_RECORDER_DIR: join(dir, "recorder"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const base = `http://127.0.0.1:${SHARED_COMPUTER_PORT}`;
      const deadline = Date.now() + 20_000;
      while (
        !(await fetch(`${base}/health`).then(
          (response) => response.ok,
          () => false,
        ))
      ) {
        if (Date.now() > deadline || sharedComputer.exitCode !== null)
          throw new Error("The computer did not start.");
        await Bun.sleep(100);
      }
      const misled = build(
        {},
        {
          provider: {
            ...createSharedComputerProvider({
              baseUrl: base,
              token: COMPUTER_TOKEN,
            }),
            isolation: "per-person",
          },
        },
      );
      const { result, warned } = await logged(() =>
        call(misled, "/api/browser/open", { method: "POST", as: "ada" }),
      );
      expect(result.status).toBe(503);
      expect(await result.json()).toEqual({ error: NOT_SET_UP });
      expect(
        warned
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((line) => line.type === "browser-computer-failed"),
      ).toEqual([
        {
          type: "browser-computer-failed",
          path: "/browser/open",
          status: 503,
          error: NOT_ITS_OWN_COMPUTER,
        },
      ]);
      // Every route of the person's, the live screen's included, is refused before it reaches a profile.
      for (const path of ["/browser/state", "/egress-policy", "/control"]) {
        const asked = await fetch(`${base}${path}`, {
          headers: {
            "x-openbot-computer-token": COMPUTER_TOKEN,
            "x-openbot-bot-id": personBrowserId(ada.id),
          },
        });
        expect(asked.status).toBe(503);
        // Named with a person too, as a seat on a computer people share is: still the person's browser, still refused.
        const seated = await fetch(`${base}${path}`, {
          headers: {
            "x-openbot-computer-token": COMPUTER_TOKEN,
            "x-openbot-bot-id": personBrowserId(ada.id),
            "x-openbot-person-id": ada.id,
          },
        });
        expect(seated.status).toBe(503);
      }
      for (const query of [
        `bot=${personBrowserId(ada.id)}`,
        `bot=${personBrowserId(ada.id)}&person=${ada.id}`,
      ]) {
        const stream = await fetch(
          `${base}/stream?token=${COMPUTER_TOKEN}&${query}`,
        );
        expect(stream.status).toBe(503);
      }
      expect(await readdir(join(dir, "profiles"))).toEqual([]);
      // A Bot is served there as before.
      expect(
        (
          await fetch(`${base}/control`, {
            headers: {
              "x-openbot-computer-token": COMPUTER_TOKEN,
              "x-openbot-bot-id": "agent_7",
            },
          })
        ).status,
      ).toBe(200);
    } finally {
      sharedComputer.kill();
      await sharedComputer.exited;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an open the computer could not make is logged with the computer's own sentence", async () => {
    // The third end-to-end run: two opens failed with 502, and the server's log said only that, so nobody could say why.
    const sentence =
      "The Recorder could not be connected: The Recorder did not answer in time.";
    refuseNextOpen = { status: 502, error: sentence };
    const { result, warned } = await logged(() =>
      call(openbot, "/api/browser/open", { method: "POST", as: "ada" }),
    );
    expect(result.status).toBe(502);
    expect(
      warned
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.type === "browser-computer-failed"),
    ).toEqual([
      {
        type: "browser-computer-failed",
        path: "/browser/open",
        status: 502,
        error: sentence,
      },
    ]);
  });

  test("two opens at once both open the browser, and the Recorder is never handed a connection the other revoked", async () => {
    // The third end-to-end run: the Browser page, loaded again while it was opening, sent a second open, whose connection
    // revoked the first's before the Recorder took it. The Recorder refused it as signed out, and both opens failed.
    confirmOpens = {
      askMs: 200,
      me: async (token) =>
        (await call(openbot, "/api/recorder/me", { headers: bearer(token) }))
          .status,
    };
    try {
      const first = call(openbot, "/api/browser/open", {
        method: "POST",
        as: "ada",
      });
      await Bun.sleep(50);
      const second = call(openbot, "/api/browser/open", {
        method: "POST",
        as: "ada",
      });
      const answers = await Promise.all([first, second]);
      expect(
        await Promise.all(
          answers.map(async (answer) => ({
            status: answer.status,
            body: await answer.json(),
          })),
        ),
      ).toEqual([
        { status: 200, body: expect.objectContaining({ ok: true }) },
        { status: 200, body: expect.objectContaining({ ok: true }) },
      ]);
    } finally {
      confirmOpens = null;
    }
    // The connection the Recorder holds is the one that stands.
    expect(
      (
        await call(openbot, "/api/recorder/me", {
          headers: bearer(handed(ada.id).token),
        })
      ).status,
    ).toBe(200);
  });

  test("a person who already holds ten unused codes is told to wait, and the refusal is on the trail", async () => {
    const codes = createRecorderConnectionStore(database);
    // No connection of Ben's stands, so his open has to make one.
    await codes.revokeAll(ben.id, "signed_out");
    try {
      for (let index = 0; index < 10; index += 1) {
        expect(await codes.mintCode(ben.id, "web")).not.toBeNull();
      }
      const refused = await call(openbot, "/api/browser/open", {
        method: "POST",
        as: "ben",
      });
      expect(refused.status).toBe(429);
      expect(await refused.json()).toEqual({
        error:
          "Too many connection codes were asked for at once. Wait a few minutes and try again.",
      });
      expect(
        audits.filter(
          (event) =>
            event.eventType === "recorder.connect_refused" &&
            event.actorUserId === ben.id,
        ),
      ).toEqual([
        {
          eventType: "recorder.connect_refused",
          targetType: "recorder_connection",
          actorUserId: ben.id,
          payload: { reason: "too_many_codes", via: "openbot-browser" },
        },
      ]);
    } finally {
      await database
        .delete(recorderConnectCodes)
        .where(eq(recorderConnectCodes.userId, ben.id));
    }
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

describe("clearing a person's own browser", () => {
  const clear = (as?: keyof typeof PEOPLE) =>
    call(openbot, "/api/browser/clear", {
      method: "POST",
      ...(as ? { as } : {}),
    });
  const clearedRows = () =>
    audits.filter((event) => event.eventType === "computer.browser_cleared");
  const clears = (userId: string) =>
    asked.filter(
      (line) => line === `POST /browser/clear ${personBrowserId(userId)}`,
    ).length;
  /** The reason each `recorder.revoked` row gives for this connection. */
  const revokedAs = (connectionId: string) =>
    audits
      .filter(
        (event) =>
          event.eventType === "recorder.revoked" &&
          event.targetId === connectionId,
      )
      .map((event) => event.payload?.reason);

  test("wipes the person's browser, says who did it on the trail, and opens it again fresh with its Recorder connected anew", async () => {
    await open(openbot, "ada");
    const before = handed(ada.id);
    const rows = clearedRows().length;
    const cleared = await clear("ada");
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      available: true,
      computerId: personBrowserId(ada.id),
      open: true,
      recorder: { connected: true, userId: ada.id },
    });
    expect(clears(ada.id)).toBeGreaterThan(0);
    // The connection the wiped Recorder held went with its storage: it was opened with a new one, which replaced it.
    const after = handed(ada.id);
    expect(after.connectionId).not.toBe(before.connectionId);
    expect(
      (
        await call(openbot, "/api/recorder/me", {
          headers: bearer(before.token),
        })
      ).status,
    ).toBe(401);
    // Ended by the clear, whose wipe took its token, before the open made the new one.
    expect(revokedAs(before.connectionId)).toEqual(["cleared"]);
    expect(
      await (
        await call(openbot, "/api/recorder/me", {
          headers: bearer(after.token),
        })
      ).json(),
    ).toMatchObject({ user: { id: ada.id } });
    // Who cleared which browser, as a computer reset is recorded.
    expect(clearedRows().slice(rows)).toEqual([
      expect.objectContaining({
        targetType: "computer",
        targetId: personBrowserId(ada.id),
        actorUserId: ada.id,
        payload: expect.objectContaining({ actor: ada.id }),
      }),
    ]);
  });

  test("a closed browser is cleared and left closed, its Recorder connection ended with it, and nobody signed out reaches it", async () => {
    await open(openbot, "ben");
    const held = handed(ben.id);
    await call(openbot, "/api/browser/close", { method: "POST", as: "ben" });
    // Closed, the browser keeps its connection in its profile, and OpenBot keeps it live for the next open.
    expect(
      (await call(openbot, "/api/recorder/me", { headers: bearer(held.token) }))
        .status,
    ).toBe(200);
    const opensBefore = asked.filter((line) =>
      line.startsWith("POST /browser/open "),
    ).length;
    const cleared = await clear("ben");
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ open: false, tabs: [] });
    expect(clears(ben.id)).toBeGreaterThan(0);
    expect(
      asked.filter((line) => line.startsWith("POST /browser/open ")).length,
    ).toBe(opensBefore);
    // The token went with the profile, so nothing stands for it here either: ended, and on the trail as the clear's.
    expect(
      (await call(openbot, "/api/recorder/me", { headers: bearer(held.token) }))
        .status,
    ).toBe(401);
    expect(revokedAs(held.connectionId)).toEqual(["cleared"]);
    expect(
      audits.find(
        (event) =>
          event.eventType === "recorder.revoked" &&
          event.targetId === held.connectionId,
      ),
    ).toMatchObject({
      actorUserId: ben.id,
      payload: { via: "openbot-browser", reason: "cleared" },
    });

    const unsigned = asked.length;
    expect((await clear()).status).toBe(401);
    expect(asked.slice(unsigned)).toEqual([]);
  });
});

/** The lines the server logged at warning and at error level while `work` ran. */
async function logged<T>(
  work: () => T | Promise<T>,
): Promise<{ result: T; warned: string[]; failed: string[] }> {
  const warned: string[] = [];
  const failed: string[] = [];
  const { warn, error } = console;
  console.warn = (...parts: unknown[]) => {
    warned.push(parts.map(String).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    failed.push(parts.map(String).join(" "));
  };
  try {
    return { result: await work(), warned, failed };
  } finally {
    console.warn = warn;
    console.error = error;
  }
}
const typesOf = (lines: string[]) =>
  lines.flatMap((line) => {
    try {
      return [(JSON.parse(line) as { type?: string }).type];
    } catch {
      return [];
    }
  });

describe("narration on the server's clock", () => {
  const post = (json: unknown) =>
    call(openbot, "/api/browser/narration", {
      method: "POST",
      as: "ada",
      json,
    });
  const narrated = () =>
    browsers.get(personBrowserId(ada.id))?.narrated.at(-1) as Record<
      string,
      unknown
    >;
  // The person's computer an hour behind this server's clock.
  const SKEW_MS = -3_600_000;

  test("a phrase is moved onto the server's clock by how far the page's clock is from it, and reaches the Recorder so", async () => {
    await open(openbot, "ada");
    const pageNow = Date.now() + SKEW_MS;
    const before = Date.now();
    const answer = await post({
      text: "  I search Wikipedia for Charles Babbage  ",
      startedAt: pageNow - 4_000,
      endedAt: pageNow - 1_000,
      sentAt: pageNow,
    });
    const after = Date.now();
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ ok: true });
    const phrase = narrated();
    // `sentAt` is the server's own clock on arrival, and every time keeps its distance from it.
    expect(phrase.sentAt as number).toBeGreaterThanOrEqual(before);
    expect(phrase.sentAt as number).toBeLessThanOrEqual(after);
    expect(phrase).toEqual({
      text: "I search Wikipedia for Charles Babbage",
      startedAt: (phrase.sentAt as number) - 4_000,
      endedAt: (phrase.sentAt as number) - 1_000,
      sentAt: phrase.sentAt,
    });
  });

  test("the person starting and stopping a phrase reaches the Recorder on the server's clock too", async () => {
    await open(openbot, "ada");
    const pageNow = Date.now() + SKEW_MS;
    const before = Date.now();
    expect(
      (await post({ speaking: true, since: pageNow - 1_500, sentAt: pageNow }))
        .status,
    ).toBe(200);
    const began = narrated();
    expect(began.sentAt as number).toBeGreaterThanOrEqual(before);
    expect(began).toEqual({
      speaking: true,
      since: (began.sentAt as number) - 1_500,
      sentAt: began.sentAt,
    });
    expect(
      (await post({ speaking: false, sentAt: pageNow + 2_000 })).status,
    ).toBe(200);
    const ended = narrated();
    expect(ended.sentAt as number).toBeGreaterThanOrEqual(before);
    expect(ended.sentAt as number).toBeLessThanOrEqual(Date.now());
    expect(ended).toEqual({ speaking: false, sentAt: ended.sentAt });
  });

  test("times no phrase sent now could have are refused, and nothing reaches the Recorder", async () => {
    await open(openbot, "ada");
    const computerId = personBrowserId(ada.id);
    const pageNow = Date.now() + SKEW_MS;
    const count = () => browsers.get(computerId)?.narrated.length;
    const before = count();
    for (const body of [
      // Counted from the page's load rather than the epoch: decades before the recording.
      { speaking: true, since: 12_345, sentAt: pageNow },
      {
        text: "from another clock",
        startedAt: 12_345,
        endedAt: 15_000,
        sentAt: pageNow,
      },
      // Ten minutes after it was sent.
      {
        text: "from the future",
        startedAt: pageNow + 9 * 60_000,
        endedAt: pageNow + 10 * 60_000,
        sentAt: pageNow,
      },
      { speaking: true, since: pageNow + 10 * 60_000, sentAt: pageNow },
      // Begun long before anyone speaking now began.
      {
        text: "an hour long",
        startedAt: pageNow - 60 * 60_000,
        endedAt: pageNow - 1_000,
        sentAt: pageNow,
      },
    ]) {
      const refused = await post(body);
      expect([body, refused.status]).toEqual([body, 400]);
      expect(await refused.json()).toEqual({
        error:
          "That phrase's times do not fit the recording, so it was not added.",
      });
    }
    for (const body of [
      {
        text: "ends first",
        startedAt: pageNow,
        endedAt: pageNow - 1,
        sentAt: pageNow,
      },
      { text: "no sentAt", startedAt: pageNow - 2, endedAt: pageNow - 1 },
      { speaking: true, sentAt: pageNow },
    ])
      expect([body, (await post(body)).status]).toEqual([body, 400]);
    expect(count()).toBe(before);
  });
});

describe("a slow page, and a browser that cannot be reached", () => {
  test("OpenBot waits longer for its computer than the computer waits for a page", async () => {
    // The computer's own navigation timeout, as it sets it (agent-computer/src/index.ts).
    const source = await Bun.file(
      new URL("../../agent-computer/src/index.ts", import.meta.url),
    ).text();
    const navigation =
      /numberFromEnv\("NAVIGATION_TIMEOUT_MS",\s*([\d_]+)\)/.exec(source)?.[1];
    expect(navigation).toBeDefined();
    expect(CALL_TIMEOUT_MS).toBeGreaterThan(
      Number(navigation?.replaceAll("_", "")),
    );
  });

  test("a page the computer gave up on reaches the person in the computer's words, and is not logged as an outage", async () => {
    const patient = build({}, { callTimeoutMs: 2_000 });
    await open(patient, "ada");
    slowNextNavigation = {
      ms: 500,
      status: 502,
      error: "en.wikipedia.org did not load in time.",
    };
    const { result, warned, failed } = await logged(() =>
      call(patient, "/api/browser/navigate", {
        method: "POST",
        as: "ada",
        json: { url: "https://en.wikipedia.org" },
      }),
    );
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({
      error: "en.wikipedia.org did not load in time.",
    });
    expect(typesOf(failed)).toEqual([]);
    expect(typesOf(warned)).toEqual(["browser-computer-failed"]);
  });

  test("a computer that took the request and has not answered reads as slow, at warning level", async () => {
    const impatient = build({}, { callTimeoutMs: 300 });
    await open(impatient, "ada");
    let release = () => {};
    slowNextNavigation = {
      never: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    try {
      const { result, warned, failed } = await logged(() =>
        call(impatient, "/api/browser/navigate", {
          method: "POST",
          as: "ada",
          json: { url: "https://accounts.google.com" },
        }),
      );
      expect(result.status).toBe(504);
      expect(await result.json()).toEqual({
        error:
          "Your browser is taking too long to answer. The page may still be loading.",
      });
      expect(typesOf(failed)).toEqual([]);
      expect(typesOf(warned)).toEqual(["browser-computer-slow"]);
    } finally {
      release();
    }
  });

  test("each route keeps the person's request open for its own waits, past Bun's 10 s", () => {
    // An open and a Record wait for a computer to wake and a browser to launch; the rest for the computer's own answer.
    // Each is kept open for its budget and the state read that may follow it, and the state keeps Bun's 10 s, which its
    // own bound answers well within.
    for (const [path, budget] of [
      ["/api/browser/open", OPEN_BUDGET_MS],
      ["/api/browser/recording", OPEN_BUDGET_MS],
      ["/api/browser/tabs", CALL_BUDGET_MS],
      ["/api/browser/navigate", CALL_BUDGET_MS],
      ["/api/browser/narration", CALL_BUDGET_MS],
      ["/api/browser/close", CALL_BUDGET_MS],
      // A clear wipes the browser and opens it again.
      ["/api/browser/clear", OPEN_BUDGET_MS],
    ] as const) {
      const seconds = browserRequestSeconds(path) ?? 0;
      expect(seconds * 1000).toBeGreaterThan(budget + STATE_TIMEOUT_MS);
      // Under the largest idle timeout Bun.serve takes.
      expect(seconds).toBeLessThanOrEqual(255);
    }
    expect(CALL_BUDGET_MS).toBeGreaterThan(CALL_TIMEOUT_MS);
    expect(browserRequestSeconds("/api/browser")).toBeUndefined();
    expect(STATE_TIMEOUT_MS).toBeLessThan(10_000);
  });

  test("a slow open and a slow page answer through OpenBot's own server, never with an empty reply", async () => {
    // Bun.serve closes a request that has sent nothing for 10 s, and these waited on the computer for up to 45 s, or 90
    // for an open: a cold open or a slow page reached the person as an empty reply, and the app said only its fallback.
    await call(openbot, "/api/browser/close", { method: "POST", as: "ada" });
    const server = startHttpServer({
      port: SERVER_PORT,
      config: openbot.config,
      resolveRequestActor: async () => {
        throw new Error("Only the live screen asks this.");
      },
      agentProfileStore: { get: async () => null } as never,
      computerGateway: openbot.gateway,
      app: openbot.app,
    });
    const post = (path: string, json?: unknown) =>
      fetch(`http://127.0.0.1:${SERVER_PORT}${path}`, {
        method: "POST",
        headers: {
          cookie: "test-session=ada",
          ...(json === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(json === undefined ? {} : { body: JSON.stringify(json) }),
        signal: AbortSignal.timeout(30_000),
      });
    try {
      slowNextOpen = 12_000;
      const opened = await post("/api/browser/open");
      expect(opened.status).toBe(200);
      expect(await opened.json()).toMatchObject({
        ok: true,
        computerId: personBrowserId(ada.id),
        window: "screen",
      });

      slowNextNavigation = {
        ms: 12_000,
        status: 502,
        error: "en.wikipedia.org did not load in time.",
      };
      const { result: navigated } = await logged(() =>
        post("/api/browser/navigate", { url: "https://en.wikipedia.org" }),
      );
      expect(navigated.status).toBe(502);
      expect(await navigated.json()).toEqual({
        error: "en.wikipedia.org did not load in time.",
      });
    } finally {
      slowNextOpen = null;
      slowNextNavigation = null;
      await server.stop(true);
    }
  }, 60_000);

  test("a route whose budget runs out says the browser is taking too long, and leaves nothing waiting", async () => {
    // The budget is every wait's in the route: finding the computer, and each call to it.
    const SLOW =
      "Your browser is taking too long to answer. The page may still be loading.";
    let wake = () => {};
    const asleep = new Promise<string>((resolve) => {
      wake = () => resolve(`http://127.0.0.1:${COMPUTER_PORT}`);
    });
    const waking = build(
      {},
      {
        budgetMs: { open: 400, call: 300 },
        provider: {
          ...ownComputers(),
          // A computer that is still waking, and takes longer than any route has.
          locate: () => asleep,
        },
      },
    );
    try {
      const asking = Date.now();
      const { result: navigated, warned } = await logged(() =>
        call(waking, "/api/browser/navigate", {
          method: "POST",
          as: "ada",
          json: { url: "https://example.com" },
        }),
      );
      expect(navigated.status).toBe(504);
      expect(await navigated.json()).toEqual({ error: SLOW });
      expect(Date.now() - asking).toBeLessThan(5_000);
      expect(typesOf(warned)).toContain("browser-computer-slow");

      const opened = await call(waking, "/api/browser/open", {
        method: "POST",
        as: "ada",
      });
      expect(opened.status).toBe(504);
      expect(await opened.json()).toEqual({ error: SLOW });
    } finally {
      wake();
    }
  });

  test("a computer nothing answers on reads as unreachable, at error level", async () => {
    const nowhere = `http://127.0.0.1:${NOTHING_PORT}`;
    const gone = build(
      {},
      {
        provider: {
          name: "docker",
          isolation: "per-person",
          locate: async () => nowhere,
          status: async ({ botId }: ComputerSeat) => ({
            botId,
            state: "ready" as const,
          }),
          stop: async () => ({ wasRunning: false }),
          reset: async () => ({ cleared: false }),
          list: async () => [],
        } satisfies ComputerProvider,
      },
    );
    const { result, failed } = await logged(() =>
      call(gone, "/api/browser/navigate", {
        method: "POST",
        as: "ada",
        json: { url: "https://example.com" },
      }),
    );
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({
      error: "Your browser could not be reached. Try again.",
    });
    expect(typesOf(failed)).toEqual(["browser-computer-unreachable"]);
  });
});

describe("a browser that is open and not answering", () => {
  /** What the person is told, on an OpenBot with sign-in. */
  const NOT_ANSWERING =
    "Your browser isn't answering. If it doesn't come back soon, ask an admin for help.";
  /** How many requests the computer took that start with `line` (`<method> <path>`). */
  const timesAsked = (line: string) =>
    asked.filter((entry) => entry.startsWith(line)).length;

  test("the state says so in a sentence, the Browser button stays, and it shows again once the browser answers", async () => {
    await open(openbot, "ada");
    silentState = { answers: true };
    try {
      const { result: asked, warned } = await logged(() =>
        call(openbot, "/api/browser", { as: "ada" }),
      );
      // Not logged as a failure at every ask: the page asks every second, and the computer says it once.
      expect(typesOf(warned)).toEqual([]);
      expect(asked.status).toBe(200);
      expect(await asked.json()).toMatchObject({
        available: true,
        shows: "screen",
        computerId: personBrowserId(ada.id),
        problem: NOT_ANSWERING,
      });
      // Record is told the same at once, and never reaches the browser to wait on it.
      const recordsBefore = timesAsked("POST /browser/recording");
      const record = await call(openbot, "/api/browser/recording", {
        method: "POST",
        as: "ada",
        json: { action: "start", title: "Pay the invoice" },
      });
      expect(record.status).toBe(504);
      expect(await record.json()).toEqual({ error: NOT_ANSWERING });
      expect(timesAsked("POST /browser/recording")).toBe(recordsBefore);
    } finally {
      silentState = null;
    }
    const back = (await (
      await call(openbot, "/api/browser", { as: "ada" })
    ).json()) as BrowserApiState;
    expect(back.open).toBe(true);
    expect(back.problem).toBeUndefined();
  });

  test("a computer that does not answer at all still gets the person an answer, before OpenBot's own server would close the request", async () => {
    // The end-to-end run: the state waited 45 s, Bun.serve closed the person's request with an empty reply at 10, the
    // Browser page had nothing to say and the sidebar lost its Browser button.
    await open(openbot, "ada");
    let release = () => {};
    silentState = {
      never: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const server = startHttpServer({
      port: SERVER_PORT,
      config: openbot.config,
      resolveRequestActor: async () => {
        throw new Error("Only the live screen asks this.");
      },
      agentProfileStore: { get: async () => null } as never,
      computerGateway: openbot.gateway,
      app: openbot.app,
    });
    try {
      const asking = Date.now();
      const { result: asked, warned } = await logged(() =>
        fetch(`http://127.0.0.1:${SERVER_PORT}/api/browser`, {
          headers: { cookie: "test-session=ada" },
          signal: AbortSignal.timeout(15_000),
        }),
      );
      expect(asked.status).toBe(200);
      expect(await asked.json()).toMatchObject({
        available: true,
        problem: NOT_ANSWERING,
      });
      expect(Date.now() - asking).toBeLessThan(10_000);
      expect(typesOf(warned)).toContain("browser-computer-slow");
    } finally {
      release();
      silentState = null;
      await server.stop(true);
    }
  }, 30_000);
});

describe("Record after the OpenBot browser is disconnected", () => {
  const record = (title: string) =>
    call(openbot, "/api/browser/recording", {
      method: "POST",
      as: "ada",
      json: { action: "start", title },
    });
  const stop = () =>
    call(openbot, "/api/browser/recording", {
      method: "POST",
      as: "ada",
      json: { action: "stop" },
    });
  const disconnect = async (connectionId: string) =>
    expect(
      (
        await call(openbot, `/api/recorder/connections/${connectionId}`, {
          method: "DELETE",
          as: "ada",
        })
      ).status,
    ).toBe(204);
  const computerId = () => personBrowserId(ada.id);
  const opens = () =>
    asked.filter((line) => line === `POST /browser/open ${computerId()}`)
      .length;
  const disconnects = (id = computerId()) =>
    asked.filter((line) => line === `POST /browser/disconnect ${id}`).length;
  const state = async (on: OpenBot = openbot, as: "ada" | "ben" = "ada") =>
    (await (await call(on, "/api/browser", { as })).json()) as BrowserApiState;

  test("Disconnect in Settings, Browsers tells the person's open browser at once, and its Recorder and the state say it is signed out", async () => {
    // The second end-to-end run: after Disconnect the Recorder went on saying it was connected for minutes (90 s on
    // Desktop, 125 s hosted, before the run stopped looking), until its next call to OpenBot.
    await open(openbot, "ada");
    const revoked = handed(ada.id);
    expect((await state()).recorder).toMatchObject({
      connected: true,
      userId: ada.id,
    });
    const before = disconnects();
    await disconnect(revoked.connectionId);
    expect(disconnects()).toBe(before + 1);
    expect(browsers.get(computerId())?.state.recorder).toEqual({
      connected: false,
      phase: "idle",
      actions: 0,
      narration: "own",
      voice: "off",
    });
    const after = await state();
    expect(after).toMatchObject({
      open: true,
      recorder: { connected: false, phase: "idle" },
      // A Recorder with no connection has been told nothing about narration: the window says who hears the person.
      narration: "external",
    });
    expect(after.recorder).not.toHaveProperty("userId");
    // Record after Disconnect connects the browser again first.
    const started = await record("After Disconnect");
    expect(started.status).toBe(200);
    expect((await state()).recorder).toMatchObject({
      connected: true,
      userId: ada.id,
      phase: "recording",
    });
    expect(handed(ada.id).connectionId).not.toBe(revoked.connectionId);
    expect((await stop()).status).toBe(200);
  });

  test("a Recorder the revoke did not reach is never reported connected, and Record connects it again first", async () => {
    await open(openbot, "ada");
    const revoked = handed(ada.id);
    // An older computer, with no disconnect route: the revoke stands, and the Recorder has not heard.
    refuseNextDisconnect = { status: 404 };
    const { warned } = await logged(() => disconnect(revoked.connectionId));
    expect(refuseNextDisconnect).toBeNull();
    expect(typesOf(warned)).toContain("browser-disconnect-refused");
    expect(browsers.get(computerId())?.state.recorder).toMatchObject({
      connected: true,
      userId: ada.id,
    });
    const reported = await state();
    expect(reported.recorder).toMatchObject({ connected: false });
    expect(reported.recorder).not.toHaveProperty("userId");
    // Every answer that carries the state says so, not only the state route's.
    const tabs = await call(openbot, "/api/browser/tabs", {
      method: "POST",
      as: "ada",
      json: { action: "new" },
    });
    expect(tabs.status).toBe(200);
    expect(((await tabs.json()) as BrowserApiState).recorder?.connected).toBe(
      false,
    );

    const before = opens();
    expect((await record("Not heard")).status).toBe(200);
    expect(opens()).toBe(before + 1);
    expect((await state()).recorder).toMatchObject({
      connected: true,
      userId: ada.id,
      phase: "recording",
    });
    expect((await stop()).status).toBe(200);
  });

  test("a closed, stopped, unreachable or slow browser never fails the revoke", async () => {
    // Closed: the computer has nothing to tell, and says so.
    await open(openbot, "ada");
    const closedOne = handed(ada.id);
    await call(openbot, "/api/browser/close", { method: "POST", as: "ada" });
    const { warned: closedWarned } = await logged(() =>
      disconnect(closedOne.connectionId),
    );
    expect(asked.at(-1)).toBe(`POST /browser/disconnect ${computerId()}`);
    expect(typesOf(closedWarned)).toEqual([]);

    // A computer that is not running is not started to be told: there is no browser on it.
    const started: string[] = [];
    const cold = build(
      {},
      {
        provider: {
          name: "docker",
          isolation: "per-person",
          locate: async ({ botId }: ComputerSeat) => {
            started.push(botId);
            return `http://127.0.0.1:${COMPUTER_PORT}`;
          },
          status: async ({ botId }: ComputerSeat) => ({
            botId,
            state: "absent" as const,
          }),
          stop: async () => ({ wasRunning: false }),
          reset: async () => ({ cleared: false }),
          list: async () => [],
        } satisfies ComputerProvider,
      },
    );
    await open(openbot, "ada");
    const before = disconnects();
    expect(
      (
        await call(
          cold,
          `/api/recorder/connections/${handed(ada.id).connectionId}`,
          { method: "DELETE", as: "ada" },
        )
      ).status,
    ).toBe(204);
    expect(started).toEqual([]);
    expect(disconnects()).toBe(before);

    // A computer nothing answers on.
    const gone = build(
      {},
      {
        provider: {
          name: "docker",
          isolation: "per-person",
          locate: async () => `http://127.0.0.1:${NOTHING_PORT}`,
          status: async ({ botId }: ComputerSeat) => ({
            botId,
            state: "ready" as const,
          }),
          stop: async () => ({ wasRunning: false }),
          reset: async () => ({ cleared: false }),
          list: async () => [],
        } satisfies ComputerProvider,
      },
    );
    await open(openbot, "ada");
    const { result: unreachable, failed } = await logged(() =>
      call(gone, `/api/recorder/connections/${handed(ada.id).connectionId}`, {
        method: "DELETE",
        as: "ada",
      }),
    );
    expect(unreachable.status).toBe(204);
    expect(typesOf(failed)).toEqual(["browser-computer-unreachable"]);

    // A computer that takes the request and does not answer: the revoke answers once OpenBot stops waiting.
    const impatient = build({}, { callTimeoutMs: 300 });
    await open(openbot, "ada");
    const slow = handed(ada.id);
    let release = () => {};
    refuseNextDisconnect = {
      never: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    try {
      const startedAt = Date.now();
      const { result } = await logged(() =>
        call(impatient, `/api/recorder/connections/${slow.connectionId}`, {
          method: "DELETE",
          as: "ada",
        }),
      );
      expect(result.status).toBe(204);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      release();
    }
    // Each revoke stood.
    for (const connection of [closedOne, slow])
      expect(
        (
          await call(openbot, "/api/recorder/me", {
            headers: bearer(connection.token),
          })
        ).status,
      ).toBe(401);
  });

  test("only the OpenBot browser's own connection reaches it: not another browser's, and not the Recorder's own Disconnect", async () => {
    await open(openbot, "ada");
    const browser = handed(ada.id);
    const before = disconnects();

    // Ada's Chrome on her laptop, connected through the Recorder's own Connect, disconnected in Settings, Browsers.
    const code = (await (
      await call(openbot, "/api/recorder/connect-codes", {
        method: "POST",
        as: "ada",
        json: { via: "web" },
      })
    ).json()) as { code: string };
    const exchanged = await call(openbot, "/api/recorder/connections", {
      method: "POST",
      headers: { origin: `chrome-extension://${RECORDER_EXTENSION_ID}` },
      json: {
        code: code.code,
        label: "Chrome on Ada's laptop",
        installId: "0123456789abcdef0123456789abcdef",
      },
    });
    expect(exchanged.status).toBe(201);
    const laptop = ((await exchanged.json()) as { connection: { id: string } })
      .connection;
    await disconnect(laptop.id);
    expect(disconnects()).toBe(before);
    expect((await state()).recorder).toMatchObject({
      connected: true,
      userId: ada.id,
    });

    // The Recorder in the OpenBot browser disconnecting itself from its own popup: it forgets the connection itself, as
    // the person's own Disconnect, so it is not told it was signed out.
    expect(
      (
        await call(openbot, "/api/recorder/connections/current", {
          method: "DELETE",
          headers: bearer(browser.token),
        })
      ).status,
    ).toBe(204);
    expect(disconnects()).toBe(before);
  });

  test("Disconnect in Settings, Browsers, then Record: the browser is connected again first, and records under a connection that stands", async () => {
    await open(openbot, "ada");
    const revoked = handed(ada.id);
    await disconnect(revoked.connectionId);
    // OpenBot told the Recorder at once, and it says it is signed out.
    expect(browsers.get(computerId())?.state.recorder?.connected).toBe(false);

    const started = await record("Look up Charles Babbage");
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({
      recorder: { phase: "recording", title: "Look up Charles Babbage" },
    });
    const now = handed(ada.id);
    expect(now.connectionId).not.toBe(revoked.connectionId);
    const recordedUnder = browsers.get(computerId())?.recordedUnder as string;
    expect(recordedUnder).toBe(now.token);
    // Its capture passes carry a token OpenBot takes as the person's.
    const me = await call(openbot, "/api/recorder/me", {
      headers: bearer(recordedUnder),
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ user: { id: ada.id } });
    // One OpenBot browser in Settings, Browsers again, the new one.
    const listed = (await (
      await call(openbot, "/api/recorder/connections", { as: "ada" })
    ).json()) as RecorderConnectionsResponse;
    expect(
      listed.connections
        .filter((row) => row.via === "openbot-browser")
        .map((row) => row.id),
    ).toEqual([now.connectionId]);
    expect((await stop()).status).toBe(200);
  });

  test("a Recorder that holds no connection of its own is connected again too", async () => {
    await open(openbot, "ada");
    const opened = browsers.get(computerId()) as Opened;
    opened.state.recorder = {
      connected: false,
      phase: "idle",
      actions: 0,
      narration: "own",
    };
    const started = await record("After the keep-alive heard");
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({
      recorder: { phase: "recording", connected: true, userId: ada.id },
    });
    expect((await stop()).status).toBe(200);
  });

  test("a connection that stands is not made again for every recording", async () => {
    await open(openbot, "ada");
    const held = handed(ada.id);
    const before = opens();
    expect((await record("Refund order 1043")).status).toBe(200);
    expect(opens()).toBe(before);
    expect(handed(ada.id).token).toBe(held.token);
    expect((await stop()).status).toBe(200);
  });

  test("when the Recorder refuses to connect again, Record says why and nothing is recorded", async () => {
    await open(openbot, "ada");
    await disconnect(handed(ada.id).connectionId);
    const sentence =
      "The Recorder could not be connected: Your organization's Recorder policy does not allow this OpenBot. Ask your IT team.";
    refuseNextOpen = { status: 502, error: sentence };
    const recordings = () =>
      asked.filter((line) => line === `POST /browser/recording ${computerId()}`)
        .length;
    const before = recordings();
    const refused = await record("Look up Ada Lovelace");
    // The refusal was the reconnect's. Cleared either way, so a later open is not refused for this test's sake.
    const reconnected = refuseNextOpen as unknown;
    refuseNextOpen = null;
    expect(reconnected).toBeNull();
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({ error: sentence });
    expect(recordings()).toBe(before);
    expect(browsers.get(computerId())?.state.recorder?.phase).toBe("idle");
  });
});

describe("who hears the person, as every answer says it", () => {
  // The window decides (shared/openbot-browser.ts): a native window's Recorder hears the person itself and says whether
  // it does (`voice`); a screen's browser has no microphone, the app hears the person, and there is no `voice`.
  const expected = {
    screen: { narration: "external" as const },
    native: { narration: "own" as const, voice: "off" as const },
  };
  const state = async () =>
    (await (
      await call(openbot, "/api/browser", { as: "ada" })
    ).json()) as BrowserApiState;
  const newTab = async () =>
    (await (
      await call(openbot, "/api/browser/tabs", {
        method: "POST",
        as: "ada",
        json: { action: "new" },
      })
    ).json()) as BrowserApiState;

  for (const window of ["screen", "native"] as const)
    test(`a ${window === "screen" ? "hosted" : "Desktop"} browser's Recorder is reported with the window's narration, signed in or out`, async () => {
      openAs = window;
      try {
        // Closed first, so it opens in this window: an open browser keeps the window it has.
        await call(openbot, "/api/browser/close", {
          method: "POST",
          as: "ada",
        });
        const opened = await open(openbot, "ada");
        expect(opened.narration).toBe(expected[window].narration);
        const signedIn: LauncherState = {
          connected: true,
          userId: ada.id,
          connectionId: handed(ada.id).connectionId,
          phase: "idle",
          actions: 0,
          ...expected[window],
        };
        for (const answer of [await state(), await newTab()]) {
          expect(answer.narration).toBe(expected[window].narration);
          expect(answer.recorder).toEqual(signedIn);
        }

        // Disconnected in Settings, Browsers: the Recorder reports what the real one reports once signed out, which is
        // its own default narration, `own` with a voice, whatever window it is in (the third end-to-end run's hosted
        // Disconnect).
        const removed = await call(
          openbot,
          `/api/recorder/connections/${handed(ada.id).connectionId}`,
          { method: "DELETE", as: "ada" },
        );
        expect(removed.status).toBe(204);
        expect(
          browsers.get(personBrowserId(ada.id))?.state.recorder,
        ).toMatchObject({ connected: false, narration: "own", voice: "off" });
        const signedOut: LauncherState = {
          connected: false,
          phase: "idle",
          actions: 0,
          ...expected[window],
        };
        for (const answer of [await state(), await newTab()]) {
          expect(answer.narration).toBe(expected[window].narration);
          expect(answer.recorder).toEqual(signedOut);
        }
      } finally {
        openAs = "screen";
      }
    });
});

describe("a person's browser where every Bot shares one computer", () => {
  // With OPENBOT_BROWSER_URL unset, a person's browser used to run on the shared computer, in the container where Bots
  // may run a shell, so a prompt-injected Bot could read the person's cookies off its disk.
  test("is refused through every route before anything reaches the computer, and the state says why", async () => {
    const shared = build(
      {},
      {
        provider: createSharedComputerProvider({
          baseUrl: `http://127.0.0.1:${COMPUTER_PORT}`,
          token: COMPUTER_TOKEN,
        }),
      },
    );
    const computerId = personBrowserId(ben.id);
    const connections = async () =>
      (
        await database
          .select({ id: recorderConnections.id })
          .from(recorderConnections)
          .where(eq(recorderConnections.userId, ben.id))
      ).length;
    const minted = await connections();
    const before = asked.length;

    // The app hides the Browser button, and the Browser page says why in the person's words.
    expect(
      await (await call(shared, "/api/browser", { as: "ben" })).json(),
    ).toEqual({
      available: false,
      note: SHARED_COMPUTER,
      computerId,
      open: false,
      tabs: [],
    } satisfies BrowserApiState);
    const opening = await call(shared, "/api/browser/open", {
      method: "POST",
      as: "ben",
    });
    expect(opening.status).toBe(503);
    expect(await opening.json()).toEqual({ error: SHARED_COMPUTER });
    const routes: [string, unknown][] = [
      ["/api/browser/recording", { action: "start", title: "Pay a bill" }],
      ["/api/browser/navigate", { url: "https://example.com" }],
      ["/api/browser/tabs", { action: "new" }],
      ["/api/browser/close", undefined],
    ];
    for (const [path, json] of routes) {
      const refused = await call(shared, path, {
        method: "POST",
        as: "ben",
        json,
      });
      expect(refused.status).toBe(503);
      expect(await refused.json()).toEqual({ error: SHARED_COMPUTER });
    }

    // The computer routes reach a computer through the gateway, whose provider refuses a person's browser outright.
    const control = await call(shared, `/api/computers/${computerId}/control`, {
      as: "ben",
    });
    expect(control.status).toBeGreaterThanOrEqual(400);
    await expect(shared.gateway.locate(botSeat(computerId))).rejects.toThrow(
      SHARED_COMPUTER,
    );
    expect(await shared.gateway.status(botSeat(computerId))).toMatchObject({
      state: "absent",
    });

    // Nothing of the person's reached the shared computer, not even their network policy, and no Recorder connection
    // was minted for a browser that cannot open.
    expect(
      asked.slice(before).filter((line) => line.endsWith(computerId)),
    ).toEqual([]);
    expect(await connections()).toBe(minted);
    // A Bot's computer there is reached as before.
    expect(await shared.gateway.locate(botSeat("agent_7"))).toMatch(
      `http://127.0.0.1:${COMPUTER_PORT}`,
    );
  });

  test("a computer of each one's own, and OpenBot Desktop's host-side computer, still run it", () => {
    const shared = { isolation: "shared" } as const;
    const own = { isolation: "per-person" } as const;
    expect(personBrowserRefusal(shared, undefined)).toBe(SHARED_COMPUTER);
    expect(personBrowserRefusal(own, undefined)).toBeNull();
    expect(personBrowserRefusal(shared, "http://127.0.0.1:4101")).toBeNull();
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

  test("with no address the Recorder would connect to, the person is told their browser cannot open, and the setting to fix is in the log", async () => {
    // The person used to be told to set OPENBOT_PUBLIC_URL, which only whoever runs OpenBot can do.
    const nowhere = build({
      OPENBOT_PUBLIC_URL: "http://openbot.internal:3001",
      BETTER_AUTH_URL: "http://openbot.internal:3001",
      TRUSTED_ORIGINS: "http://openbot.internal:3010",
    });
    const { result: refused, warned } = await logged(() =>
      call(nowhere, "/api/browser/open", {
        method: "POST",
        as: "ada",
      }),
    );
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: NOT_SET_UP });
    expect(
      warned
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.type === "browser-open-no-address"),
    ).toEqual([
      {
        type: "browser-open-no-address",
        error:
          "This OpenBot has no address a person's browser can reach it at, so the Recorder in it cannot be connected. Set OPENBOT_PUBLIC_URL to this OpenBot's https address.",
      },
    ]);
  });
});

describe("a single-user OpenBot, where the person is its admin", () => {
  /**
   * OpenBot Desktop's server: one person and no sign-in, no address anybody else reaches, and people's browsers on the
   * host-side computer (here the stand-in), so they show as windows on the person's desktop.
   */
  const desktop = () =>
    build({
      OPENBOT_SINGLE_USER: "true",
      OPENBOT_PUBLIC_URL: undefined,
      BETTER_AUTH_URL: undefined,
      BETTER_AUTH_SECRET: undefined,
      GOOGLE_OAUTH_CLIENT_ID: undefined,
      GOOGLE_OAUTH_CLIENT_SECRET: undefined,
      INITIAL_ADMIN_EMAILS: undefined,
      OPENBOT_BROWSER_URL: `http://127.0.0.1:${COMPUTER_PORT}`,
    });
  /** The address OpenBot Desktop's window uses, which the Recorder is handed. */
  const WINDOW = { origin: "http://127.0.0.1:3010" };

  beforeAll(async () => {
    await initializeDevActorUser(database, true);
  });
  afterAll(async () => {
    await database
      .delete(recorderConnections)
      .where(eq(recorderConnections.userId, DEV_ACTOR.id));
  });

  test("a browser the computer cannot run is OpenBot's setup, which the person is told to check themselves, not to ask an admin about", async () => {
    // Run 7, on OpenBot Desktop: the person was told to ask an admin, and on Desktop there is nobody else.
    const single = desktop();
    expect(single.config.singleUser).toBe(true);
    expect(
      await (await call(single, "/api/browser", { headers: WINDOW })).json(),
    ).toMatchObject({ available: true, shows: "native" });
    refuseNextOpen = { status: 503, error: NO_INSTALLED_BROWSER };
    const { result: refused, warned } = await logged(() =>
      call(single, "/api/browser/open", { method: "POST", headers: WINDOW }),
    );
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: NOT_SET_UP_SINGLE_USER });
    // The computer's own sentence, the reason, is in the log the person is pointed at.
    expect(
      warned
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.type === "browser-computer-failed"),
    ).toEqual([
      {
        type: "browser-computer-failed",
        path: "/browser/open",
        status: 503,
        error: NO_INSTALLED_BROWSER,
      },
    ]);

    // On an OpenBot with sign-in, the same refusal still sends the person to an admin.
    refuseNextOpen = { status: 503, error: NO_INSTALLED_BROWSER };
    const { result: multi } = await logged(() =>
      call(openbot, "/api/browser/open", { method: "POST", as: "ada" }),
    );
    expect(multi.status).toBe(503);
    expect(await multi.json()).toEqual({ error: NOT_SET_UP });
  });

  test("a browser that is not answering tells the single person what they can do themselves", async () => {
    const single = desktop();
    await call(single, "/api/browser/open", {
      method: "POST",
      headers: WINDOW,
    });
    silentState = { answers: true };
    try {
      expect(
        await (await call(single, "/api/browser", { headers: WINDOW })).json(),
      ).toMatchObject({
        available: true,
        problem:
          "Your browser isn't answering. If it doesn't come back soon, quit OpenBot and open it again.",
      });
    } finally {
      silentState = null;
    }
  });

  test("with no address the Recorder would connect to, the single person is told the same, and the setting is in the log", async () => {
    // A request with no Origin, and nothing configured: OpenBot has no address to hand the Recorder.
    const { result: refused, warned } = await logged(() =>
      call(desktop(), "/api/browser/open", { method: "POST" }),
    );
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: NOT_SET_UP_SINGLE_USER });
    expect(typesOf(warned)).toContain("browser-open-no-address");
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

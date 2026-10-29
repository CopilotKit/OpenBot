// The Browser button and the person's own everyday browser, through the real routes and the real database: each
// Recorder's report of what it is recording is kept against its connection, the state's red dot (`activity`) reads the
// newest live one from any of the person's Recorders, and on OpenBot Desktop the state lists the person's own browsers
// and whether a Recorder in one is connected through Desktop (`real`), while Browser brings that browser forward, or
// opens the Recorder's store page in it, or (before the Recorder is published) opens the OpenBot browser as before.
// The computer is a stand-in that answers its routes exactly as the contract types them (shared/openbot-browser.ts):
// the real-browser routes are OpenBot Desktop's host-side computer's, another slice's work.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type BrowserApiState,
  type BrowserOpenResponse,
  type BrowserState,
  browserOpenRequestSchema,
  isPersonBrowserId,
  type LauncherConnection,
  type LauncherState,
  type RealBrowser,
  type RealBrowserOpenResponse,
  realBrowserComputerPaths,
  realBrowserRequestSchema,
} from "@openbot/shared/openbot-browser";
import {
  type ExchangeResponse,
  RECORDER_SIGNED_OUT,
  type RecorderActivity,
  recorderPaths,
} from "@openbot/shared/recorder-api";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createApp } from "../src/app";
import type { AuditEventInput } from "../src/audit";
import { DEV_ACTOR, initializeDevActorUser } from "../src/auth/dev-actor";
import { openbotAddress } from "../src/browser/address";
import { personBrowserEgressPolicy } from "../src/browser/egress";
import {
  gatewayBrowserComputers,
  personBrowserPlace,
  withPersonBrowsers,
} from "../src/browser/host";
import { personBrowserId } from "../src/browser/person";
import type { ComputerSeat } from "../src/computer/computer-key";
import { createComputerGateway } from "../src/computer/gateway";
import { withPolicyPushOnWake } from "../src/computer/policy-network";
import {
  type ComputerProvider,
  createSharedComputerProvider,
} from "../src/computer/provider";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { recorderConnections } from "../src/db/schema/recorder";
import { createRecorderConnectionStore } from "../src/recorder/connections";
import { createRecorderExtension } from "../src/recorder/wiring";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { SESSION_LIFETIME_MS, testEnvironment } from "./support/environment";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `browser-real-${randomUUID()}`;
const ada = { id: `${prefix}-ada`, email: `${prefix}-ada@example.test` };
const ben = { id: `${prefix}-ben`, email: `${prefix}-ben@example.test` };
const cy = { id: `${prefix}-cy`, email: `${prefix}-cy@example.test` };
const PEOPLE = { ada, ben, cy } as const;
type Person = keyof typeof PEOPLE;
const COMPUTER_TOKEN = "browser-real-computer-token";
const PUBLIC = "https://openbot.example.com";
// This slice's own ports: the stand-in computer, and one nothing listens on.
const COMPUTER_PORT = 7880;
const NOTHING_PORT = 7881;
const EXTENSION_ORIGIN = `chrome-extension://${RECORDER_EXTENSION_ID}`;
/** Store ids as the stores would assign them once the Recorder is published: the Chrome Web Store keeps the fixed id. */
const PUBLISHED = {
  chrome: RECORDER_EXTENSION_ID,
  edge: "jdmmhcgkbfeaonlpjeeahjakkgcejilm",
};

// ---- The stand-in computer --------------------------------------------------------------------

/** Every request the computer took, as `<method> <path>`, with the body of each real-browser POST. */
const asked: { line: string; body?: unknown }[] = [];
/** The OpenBot browsers it has open, by person browser id. */
const browsers = new Map<string, BrowserState & { token?: string }>();
/** The connection each browser's Recorder keeps in its profile, which outlives the browser being closed. */
const recorderKeeps = new Map<string, LauncherConnection>();
/** The person's own browsers installed on this computer, as `GET /browser/real` lists them. */
let installed: RealBrowser[] = ["chrome", "msedge"];
/** How the next real-browser route answers instead, when a test says so. */
let refuseNextReal: { status: number; error?: string } | null = null;

const STORE_HOSTS = [
  "chromewebstore.google.com",
  "microsoftedge.microsoft.com",
];

/** The computer's routes as the contract types them: the token, a person's browser id in `x-openbot-bot-id` (400 for
 * anything else), and each body read against the contract's schema. The real-browser routes refuse what OpenBot
 * Desktop's host-side computer refuses: a front with a url, and a store url that is not an https store page. */
const computer = Bun.serve({
  hostname: "127.0.0.1",
  port: COMPUTER_PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("x-openbot-computer-token") !== COMPUTER_TOKEN)
      return Response.json({ error: "Unauthorized." }, { status: 401 });
    const id = request.headers.get("x-openbot-bot-id") ?? "";
    const sent = request.method === "POST" ? await request.text() : "";
    const body = sent ? JSON.parse(sent) : undefined;
    asked.push({ line: `${request.method} ${url.pathname}`, body });
    if (url.pathname === "/health") return Response.json({ status: "ok" });
    if (url.pathname === "/egress-policy" && request.method === "PUT")
      return Response.json({ ok: true });
    if (!url.pathname.startsWith("/browser/"))
      return Response.json({ error: "Not found." }, { status: 404 });
    if (!isPersonBrowserId(id))
      return Response.json(
        { error: "Only a person's browser opens here." },
        { status: 400 },
      );
    if (url.pathname.startsWith(realBrowserComputerPaths.installed)) {
      const refusal = refuseNextReal;
      refuseNextReal = null;
      if (refusal)
        return Response.json(
          { error: refusal.error ?? "Not found." },
          { status: refusal.status },
        );
    }
    switch (url.pathname) {
      case realBrowserComputerPaths.installed:
        if (request.method !== "GET") break;
        return Response.json({ browsers: installed });
      case realBrowserComputerPaths.front: {
        const parsed = realBrowserRequestSchema.safeParse(body);
        if (!parsed.success || parsed.data.url !== undefined)
          return Response.json({ error: "Bad request." }, { status: 400 });
        return Response.json({ ok: true });
      }
      case realBrowserComputerPaths.store: {
        const parsed = realBrowserRequestSchema.safeParse(body);
        const page = parsed.success && parsed.data.url;
        if (
          !page ||
          new URL(page).protocol !== "https:" ||
          !STORE_HOSTS.includes(new URL(page).hostname)
        )
          return Response.json({ error: "Bad request." }, { status: 400 });
        return Response.json({ ok: true });
      }
      case "/browser/state": {
        const open = browsers.get(id);
        if (!open) return Response.json({ open: false, tabs: [] });
        const { token: _token, ...state } = open;
        return Response.json(state);
      }
      case "/browser/open": {
        const parsed = browserOpenRequestSchema.safeParse(body);
        if (!parsed.success)
          return Response.json({ error: "Bad request." }, { status: 400 });
        const brought = parsed.data.connection;
        // An open that brings no connection hands the Recorder nothing: an open browser is as it was, and a closed one
        // opens with its Recorder holding what it kept (agent-computer's browser-host.ts).
        const open = browsers.get(id);
        if (!brought && open) {
          const { token: _token, ...state } = open;
          return Response.json(state);
        }
        const holds = brought ?? recorderKeeps.get(id);
        if (brought) recorderKeeps.set(id, brought);
        const state: BrowserState = {
          open: true,
          browser: "chrome",
          window: "native",
          recorder: holds
            ? {
                connected: true,
                userId: holds.user.id,
                connectionId: holds.connectionId,
                phase: "idle",
                actions: 0,
                narration: "own",
                voice: "off",
              }
            : {
                connected: false,
                phase: "idle",
                actions: 0,
                narration: "own",
                voice: "off",
              },
          tabs: [],
        };
        browsers.set(id, {
          ...state,
          ...(holds ? { token: holds.token } : {}),
        });
        return Response.json(state);
      }
      case "/browser/close":
        browsers.delete(id);
        return Response.json({ open: false, tabs: [] });
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  },
});

// ---- OpenBot, as index.ts builds it ------------------------------------------------------------

const auditStore = { insert: async (_event: AuditEventInput) => {} };
const roleRepository = { rolesForUser: async () => ["user" as const] };
const personalSpaces = {
  containerFor: (userId: string) => `space-of-${userId}`,
  state: async () => ({ state: "unassigned" as const, containerId: null }),
  kick: () => {},
};
const better = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const name = /test-session=(\w+)/.exec(headers.get("cookie") ?? "")?.[1];
      return name && name in PEOPLE
        ? { user: { ...PEOPLE[name as Person], name: name } }
        : null;
    },
  },
};

/**
 * One OpenBot: hosted (people's browsers on computers of their own beside the Bots', as a supervisor or a Sandbox gives
 * them, shown as a screen), or OpenBot Desktop (`desktop`: people's browsers on its host-side computer,
 * `OPENBOT_BROWSER_URL`, as windows on the person's own desktop).
 */
function build(
  options: {
    desktop?: boolean | string;
    singleUser?: boolean;
    storeIds?: { chrome?: string; edge?: string };
    /** The Bots' computer provider, in place of the stand-in computer as a computer of each one's own. */
    provider?: ComputerProvider;
  } = {},
) {
  const computerUrl = `http://127.0.0.1:${COMPUTER_PORT}`;
  const browserUrl =
    typeof options.desktop === "string"
      ? options.desktop
      : options.desktop
        ? computerUrl
        : undefined;
  const config = loadConfig(
    testEnvironment({
      // A single-user OpenBot is reached only from this machine: its window's own loopback address.
      OPENBOT_PUBLIC_URL: options.singleUser ? undefined : PUBLIC,
      AGENT_COMPUTER_URL: computerUrl,
      COMPUTER_TOKEN,
      ...(browserUrl ? { OPENBOT_BROWSER_URL: browserUrl } : {}),
      ...(options.singleUser
        ? {
            OPENBOT_SINGLE_USER: "true",
            BETTER_AUTH_URL: undefined,
            BETTER_AUTH_SECRET: undefined,
            GOOGLE_OAUTH_CLIENT_ID: undefined,
            GOOGLE_OAUTH_CLIENT_SECRET: undefined,
            INITIAL_ADMIN_EMAILS: undefined,
          }
        : {}),
    }),
  );
  const personPolicy = personBrowserEgressPolicy({
    native: config.browser !== undefined,
    allowPrivateHosts: false,
    openbotUrls: [config.publicUrl, config.appUrl],
    gatewayUrl: config.runtime.intelligence.gatewayWsUrl,
  });
  const provider = withPolicyPushOnWake(
    withPersonBrowsers(
      options.provider ?? {
        ...createSharedComputerProvider({
          baseUrl: computerUrl,
          token: COMPUTER_TOKEN,
        }),
        name: "docker",
        isolation: "per-person",
      },
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
    organizationAuth: undefined,
    roleRepository,
    peopleStore: { isRevoked: async () => false },
    personalSpaces,
    sessionLifetimeMs: SESSION_LIFETIME_MS,
    auditStore,
  });
  const args = [config] as unknown as Parameters<typeof createApp>;
  args[1] = better as never;
  args[2] = roleRepository;
  args[7] = gateway;
  args[8] = {} as never;
  args[12] = auditStore;
  args[34] = {
    recorder,
    browser: {
      ...personBrowserPlace({
        provider,
        browserUrl: config.browser?.url,
        computers: () => gatewayBrowserComputers(gateway, config.browser?.url),
      }),
      token: COMPUTER_TOKEN,
      recorder,
      openbotUrl: openbotAddress(config),
      singleUser: config.singleUser,
      ...(options.storeIds ? { storeIds: options.storeIds } : {}),
    },
  };
  return { app: createApp(...args), config };
}
type OpenBot = ReturnType<typeof build>;

const call = (
  { app }: OpenBot,
  path: string,
  init: RequestInit & { json?: unknown; as?: Person } = {},
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

/** A Recorder connecting as the person, as the real one does: a connect code minted for them (from OpenBot, or from
 * OpenBot Desktop's handoff), exchanged from the Recorder's own origin under the name it gives its browser. */
async function connect(
  openbot: OpenBot,
  as: Person | null,
  input: { via: "web" | "desktop"; label: string },
): Promise<ExchangeResponse> {
  const minted = await call(openbot, recorderPaths.connectCodes, {
    method: "POST",
    ...(as ? { as } : {}),
    json: { via: input.via },
  });
  expect(minted.status).toBe(201);
  const { code } = (await minted.json()) as { code: string };
  const exchanged = await call(openbot, recorderPaths.connections, {
    method: "POST",
    headers: { origin: EXTENSION_ORIGIN },
    json: {
      code,
      label: input.label,
      installId: randomUUID().replaceAll("-", ""),
    },
  });
  expect(exchanged.status).toBe(201);
  return exchanged.json();
}

/** The Recorder telling OpenBot what it is doing, with its own bearer. */
const report = (openbot: OpenBot, token: string, activity: unknown) =>
  call(openbot, recorderPaths.activity, {
    method: "POST",
    headers: bearer(token),
    json: activity,
  });

const recordingReceipt = (startedAt = Date.now() - 20_000) =>
  ({
    phase: "recording",
    recordingId: "rec-receipt",
    title: "Submit the receipt",
    startedAt,
    actions: 4,
  }) satisfies RecorderActivity;

async function stateOf(openbot: OpenBot, as?: Person) {
  const response = await call(openbot, "/api/browser", as ? { as } : {});
  expect(response.status).toBe(200);
  return (await response.json()) as BrowserApiState;
}

async function openAs(openbot: OpenBot, as?: Person) {
  const response = await call(openbot, "/api/browser/open", {
    method: "POST",
    ...(as ? { as } : {}),
  });
  return {
    status: response.status,
    body: (await response.json()) as
      | BrowserOpenResponse
      | RealBrowserOpenResponse
      | { error: string },
  };
}

/** Moves a connection's last report back in time, as a report that arrived that long ago. */
const reportedAgo = (connectionId: string, ms: number) =>
  database
    .update(recorderConnections)
    .set({ activityAt: new Date(Date.now() - ms) })
    .where(eq(recorderConnections.id, connectionId));

/** What the computer was asked from `since` on, as `<method> <path>` lines. */
const askedSince = (since: number) =>
  asked.slice(since).map((entry) => entry.line);

/** Runs `work` with the server's warnings and errors about an unreachable or failing computer kept out of the output. */
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const { warn, error } = console;
  console.warn = () => {};
  console.error = () => {};
  try {
    return await work();
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

const removeConnections = (userId: string) =>
  database
    .delete(recorderConnections)
    .where(eq(recorderConnections.userId, userId));

beforeAll(async () => {
  await database.insert(users).values([ada, ben, cy]);
});
afterAll(async () => {
  computer.stop(true);
  await database
    .delete(users)
    .where(inArray(users.id, [ada.id, ben.id, cy.id]));
  await database.$client.close();
});

describe("a Recorder tells OpenBot what it is recording", () => {
  test("its report is kept against its connection with when it arrived, and the next one replaces it", async () => {
    const openbot = build();
    const chrome = await connect(openbot, "ada", {
      via: "web",
      label: "Google Chrome on macOS",
    });
    const before = Date.now();
    const recording = recordingReceipt();
    const answered = await report(openbot, chrome.token, recording);
    expect(answered.status).toBe(204);
    const [row] = await database
      .select()
      .from(recorderConnections)
      .where(eq(recorderConnections.id, chrome.connection.id));
    expect(row?.activity).toEqual(recording);
    expect(row?.activityAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row?.activityAt?.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    // Stopped: the idle report takes the recording's place, rather than adding to it.
    expect(
      (await report(openbot, chrome.token, { phase: "idle", actions: 0 }))
        .status,
    ).toBe(204);
    const [after] = await database
      .select({ activity: recorderConnections.activity })
      .from(recorderConnections)
      .where(eq(recorderConnections.id, chrome.connection.id));
    expect(after?.activity).toEqual({ phase: "idle", actions: 0 });
    await removeConnections(ada.id);
  });

  test("only a connected Recorder's bearer is taken, and only a report the contract types", async () => {
    const openbot = build();
    const chrome = await connect(openbot, "ada", {
      via: "web",
      label: "Google Chrome on macOS",
    });
    // A signed-in person is not a Recorder.
    expect(
      (
        await call(openbot, recorderPaths.activity, {
          method: "POST",
          as: "ada",
          json: recordingReceipt(),
        })
      ).status,
    ).toBe(401);
    // Not JSON, and not a report.
    expect(
      (
        await call(openbot, recorderPaths.activity, {
          method: "POST",
          headers: { ...bearer(chrome.token), "content-type": "text/plain" },
          body: JSON.stringify(recordingReceipt()),
        })
      ).status,
    ).toBe(415);
    for (const wrong of [
      { phase: "paused", actions: 0 },
      { phase: "recording" },
      { ...recordingReceipt(), url: "https://example.com" },
      { phase: "recording", actions: -1 },
    ]) {
      const refused = await report(openbot, chrome.token, wrong);
      expect([wrong, refused.status]).toEqual([wrong, 400]);
    }
    const [row] = await database
      .select({ activity: recorderConnections.activity })
      .from(recorderConnections)
      .where(eq(recorderConnections.id, chrome.connection.id));
    expect(row?.activity).toBeNull();

    // Disconnected: refused as every bearer route refuses a revoked connection, signed out, and nothing is kept.
    const gone = await call(openbot, recorderPaths.currentConnection, {
      method: "DELETE",
      headers: bearer(chrome.token),
    });
    expect(gone.status).toBe(204);
    const refused = await report(openbot, chrome.token, recordingReceipt());
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { code: string }).code).toBe(
      RECORDER_SIGNED_OUT,
    );
    const [revoked] = await database
      .select({ activity: recorderConnections.activity })
      .from(recorderConnections)
      .where(eq(recorderConnections.id, chrome.connection.id));
    expect(revoked?.activity).toBeNull();
    await removeConnections(ada.id);
  });

  test("a report that arrives after its connection was revoked is not kept", async () => {
    // The guard read the token before the revoke landed: the write itself refuses a revoked connection.
    const openbot = build();
    const chrome = await connect(openbot, "ada", {
      via: "web",
      label: "Google Chrome on macOS",
    });
    const store = createRecorderConnectionStore(database);
    expect(await store.revoke(ada.id, chrome.connection.id, "revoked")).toBe(
      true,
    );
    expect(
      await store.reportActivity(
        ada.id,
        chrome.connection.id,
        recordingReceipt(),
      ),
    ).toBe(false);
    // Nor is one kept against another person's connection.
    const bens = await connect(openbot, "ben", {
      via: "web",
      label: "Google Chrome on macOS",
    });
    expect(
      await store.reportActivity(
        ada.id,
        bens.connection.id,
        recordingReceipt(),
      ),
    ).toBe(false);
    const rows = await database
      .select({ activity: recorderConnections.activity })
      .from(recorderConnections)
      .where(
        inArray(recorderConnections.id, [
          chrome.connection.id,
          bens.connection.id,
        ]),
      );
    expect(rows.map((row) => row.activity)).toEqual([null, null]);
    await removeConnections(ada.id);
    await removeConnections(ben.id);
  });
});

describe("the red dot follows any of the person's Recorders", () => {
  for (const surface of ["hosted", "Desktop"] as const)
    test(`a recording in the person's everyday browser lights it on ${surface}, and Stop puts it out`, async () => {
      const openbot = build({ desktop: surface === "Desktop" });
      const everyday = await connect(openbot, "ada", {
        via: surface === "Desktop" ? "desktop" : "web",
        label: "Google Chrome on macOS",
      });
      expect((await stateOf(openbot, "ada")).activity).toBeUndefined();
      const recording = recordingReceipt();
      await report(openbot, everyday.token, recording);
      const state = await stateOf(openbot, "ada");
      expect(state.activity).toEqual(recording);
      // The OpenBot browser itself is not open, and nothing about it changed.
      expect(state).toMatchObject({ open: false, tabs: [] });
      expect(state.recorder).toBeUndefined();

      await report(openbot, everyday.token, { phase: "idle", actions: 0 });
      expect((await stateOf(openbot, "ada")).activity).toBeUndefined();
      await removeConnections(ada.id);
    });

  test("a report older than 90 seconds lights nothing, and the newest recording is the one named", async () => {
    const openbot = build();
    const chrome = await connect(openbot, "ada", {
      via: "web",
      label: "Google Chrome on macOS",
    });
    const edge = await connect(openbot, "ada", {
      via: "web",
      label: "Microsoft Edge on Windows",
    });
    await report(openbot, chrome.token, recordingReceipt());
    // A browser that quit mid-recording says nothing more: three missed 30-second reports later the dot is out.
    await reportedAgo(chrome.connection.id, 91_000);
    expect((await stateOf(openbot, "ada")).activity).toBeUndefined();
    await reportedAgo(chrome.connection.id, 85_000);
    expect((await stateOf(openbot, "ada")).activity?.title).toBe(
      "Submit the receipt",
    );

    const other = {
      phase: "starting",
      recordingId: "rec-expense",
      title: "File the expense",
      actions: 0,
    } satisfies RecorderActivity;
    await report(openbot, edge.token, other);
    expect((await stateOf(openbot, "ada")).activity).toEqual(other);
    // The newer one stops: the older recording, still running, is named again.
    await report(openbot, edge.token, { phase: "idle", actions: 0 });
    expect((await stateOf(openbot, "ada")).activity?.title).toBe(
      "Submit the receipt",
    );
    await removeConnections(ada.id);
  });

  test("another person's recording never lights mine, and a disconnected browser's report is gone with it", async () => {
    const openbot = build();
    const bens = await connect(openbot, "ben", {
      via: "web",
      label: "Google Chrome on macOS",
    });
    await report(openbot, bens.token, recordingReceipt());
    expect((await stateOf(openbot, "ada")).activity).toBeUndefined();
    expect((await stateOf(openbot, "ben")).activity?.title).toBe(
      "Submit the receipt",
    );
    // Disconnected in Settings, Browsers while it recorded.
    const removed = await call(
      openbot,
      `/api/recorder/connections/${bens.connection.id}`,
      { method: "DELETE", as: "ben" },
    );
    expect(removed.status).toBe(204);
    expect((await stateOf(openbot, "ben")).activity).toBeUndefined();
    await removeConnections(ben.id);
  });

  test("the OpenBot browser's own Recorder, as its computer says now, is newer than any report", async () => {
    const openbot = build({ desktop: true });
    const opened = await openAs(openbot, "cy");
    expect(opened.status).toBe(200);
    const computerId = personBrowserId(cy.id);
    const browser = browsers.get(computerId);
    if (!browser?.token) throw new Error("the browser did not open connected");
    const everyday = await connect(openbot, "cy", {
      via: "desktop",
      label: "Google Chrome on macOS",
    });
    await report(openbot, everyday.token, recordingReceipt());

    // Recording in the OpenBot browser too, as its computer reports it: that is the one named, being the newest.
    browser.recorder = {
      ...(browser.recorder as LauncherState),
      phase: "recording",
      recordingId: "rec-openbot",
      title: "Book the room",
      startedAt: Date.now() - 5_000,
      actions: 2,
    };
    const both = await stateOf(openbot, "cy");
    expect(both.activity).toEqual({
      phase: "recording",
      recordingId: "rec-openbot",
      title: "Book the room",
      startedAt: browser.recorder.startedAt as number,
      actions: 2,
    });

    // The OpenBot browser's Recorder said it was recording, then stopped, and its idle report did not arrive: its
    // computer says idle now, which outranks the report, and the everyday browser's recording is the one shown.
    const reported = await report(openbot, browser.token, {
      phase: "recording",
      recordingId: "rec-openbot",
      title: "Book the room",
      startedAt: Date.now() - 5_000,
      actions: 2,
    });
    expect(reported.status).toBe(204);
    await report(openbot, everyday.token, { phase: "idle", actions: 0 });
    browser.recorder = { ...browser.recorder, phase: "idle", actions: 0 };
    expect((await stateOf(openbot, "cy")).activity).toBeUndefined();

    // Closed: the computer says it holds no browser, and the report from before is not taken for one.
    await call(openbot, "/api/browser/close", { method: "POST", as: "cy" });
    expect((await stateOf(openbot, "cy")).activity).toBeUndefined();
    await removeConnections(cy.id);
  });

  test("asking for the dot starts no computer: a report is read from the database alone", async () => {
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
    const cold = build({ provider: supervisor });
    const everyday = await connect(cold, "ben", {
      via: "web",
      label: "Google Chrome on Linux",
    });
    await report(cold, everyday.token, recordingReceipt());
    const since = asked.length;
    const state = await stateOf(cold, "ben");
    expect(state.activity?.title).toBe("Submit the receipt");
    expect(state).toMatchObject({
      available: true,
      shows: "screen",
      open: false,
    });
    expect(state.real).toBeUndefined();
    expect(started).toEqual([]);
    expect(askedSince(since)).toEqual([]);
    await removeConnections(ben.id);
  });
});

describe("OpenBot Desktop's state names the person's own browsers", () => {
  test("which are installed, and whether a Recorder in one is connected through Desktop", async () => {
    const desktop = build({ desktop: true });
    installed = ["chrome", "msedge"];
    expect((await stateOf(desktop, "ada")).real).toEqual({
      connected: false,
      browsers: ["chrome", "msedge"],
    });
    // A browser connected from OpenBot in that browser (Connect this browser) is not the Desktop route.
    await connect(desktop, "ada", {
      via: "web",
      label: "Google Chrome on macOS",
    });
    expect((await stateOf(desktop, "ada")).real?.connected).toBe(false);
    const handed = await connect(desktop, "ada", {
      via: "desktop",
      label: "Google Chrome on macOS",
    });
    expect((await stateOf(desktop, "ada")).real).toEqual({
      connected: true,
      browsers: ["chrome", "msedge"],
    });
    // Disconnected: no longer.
    await call(desktop, `/api/recorder/connections/${handed.connection.id}`, {
      method: "DELETE",
      as: "ada",
    });
    installed = ["msedge"];
    expect((await stateOf(desktop, "ada")).real).toEqual({
      connected: false,
      browsers: ["msedge"],
    });
    installed = ["chrome", "msedge"];

    // Hosted OpenBot has no everyday browser of the person's to name.
    expect((await stateOf(build(), "ada")).real).toBeUndefined();
    await removeConnections(ada.id);
  });

  test("a computer that cannot list them answers no browsers, never an error", async () => {
    // Not answering at all, and answering as a computer from before the route did (404).
    const down = build({ desktop: `http://127.0.0.1:${NOTHING_PORT}` });
    expect(await quietly(() => stateOf(down, "ada"))).toEqual({
      available: true,
      shows: "native",
      computerId: personBrowserId(ada.id),
      open: false,
      tabs: [],
      real: { connected: false, browsers: [] },
    });
    const older = build({ desktop: true });
    refuseNextReal = { status: 404 };
    expect((await stateOf(older, "ada")).real).toEqual({
      connected: false,
      browsers: [],
    });
  });
});

describe("Browser on OpenBot Desktop, with the person's own browser", () => {
  test("with the Recorder connected through Desktop it brings that browser forward: Edge when its name says so, else Chrome", async () => {
    const desktop = build({ desktop: true, storeIds: PUBLISHED });
    const connectionsBefore = async () =>
      (
        await database
          .select({ id: recorderConnections.id })
          .from(recorderConnections)
          .where(eq(recorderConnections.userId, ada.id))
      ).length;
    await connect(desktop, "ada", {
      via: "desktop",
      label: "Microsoft Edge on macOS",
    });
    const minted = await connectionsBefore();
    let since = asked.length;
    const edge = await openAs(desktop, "ada");
    expect(edge).toEqual({
      status: 200,
      body: { ok: true, opened: "real", browser: "msedge" },
    });
    expect(
      asked
        .slice(since)
        .filter((entry) => entry.line.startsWith("POST /browser/")),
    ).toEqual([
      {
        line: `POST ${realBrowserComputerPaths.front}`,
        body: { browser: "msedge" },
      },
    ]);
    // No OpenBot browser opened, and no Recorder connection minted for one.
    expect(browsers.has(personBrowserId(ada.id))).toBe(false);
    expect(await connectionsBefore()).toBe(minted);

    // A Chrome connected later, and used since: the browser the person was last heard from is the one brought forward.
    const chrome = await connect(desktop, "ada", {
      via: "desktop",
      label: "Google Chrome on macOS",
    });
    await report(desktop, chrome.token, { phase: "idle", actions: 0 });
    since = asked.length;
    expect((await openAs(desktop, "ada")).body).toEqual({
      ok: true,
      opened: "real",
      browser: "chrome",
    });
    expect(asked.slice(since).map((entry) => entry.body)).toContainEqual({
      browser: "chrome",
    });

    // A name that does not say: Chrome.
    await removeConnections(ada.id);
    await connect(desktop, "ada", { via: "desktop", label: "Work laptop" });
    expect((await openAs(desktop, "ada")).body).toMatchObject({
      opened: "real",
      browser: "chrome",
    });
    await removeConnections(ada.id);
  });

  test("not connected, it opens the Recorder's store page in their Chrome, else in Edge, where it is published", async () => {
    installed = ["chrome", "msedge"];
    const desktop = build({ desktop: true, storeIds: PUBLISHED });
    let since = asked.length;
    expect(await openAs(desktop, "ben")).toEqual({
      status: 200,
      body: { ok: true, opened: "store", browser: "chrome" },
    });
    expect(
      asked
        .slice(since)
        .filter((entry) => entry.line.startsWith("POST /browser/")),
    ).toEqual([
      {
        line: `POST ${realBrowserComputerPaths.store}`,
        body: {
          browser: "chrome",
          url: `https://chromewebstore.google.com/detail/${PUBLISHED.chrome}`,
        },
      },
    ]);
    expect(browsers.has(personBrowserId(ben.id))).toBe(false);

    // Only Edge installed: Edge's own store, under the id Edge Add-ons gave it.
    installed = ["msedge"];
    since = asked.length;
    expect((await openAs(desktop, "ben")).body).toEqual({
      ok: true,
      opened: "store",
      browser: "msedge",
    });
    expect(asked.slice(since).map((entry) => entry.body)).toContainEqual({
      browser: "msedge",
      url: `https://microsoftedge.microsoft.com/addons/detail/${PUBLISHED.edge}`,
    });

    // Published on Edge Add-ons alone: Edge, though Chrome is there too.
    installed = ["chrome", "msedge"];
    const edgeOnly = build({
      desktop: true,
      storeIds: { edge: PUBLISHED.edge },
    });
    expect((await openAs(edgeOnly, "ben")).body).toEqual({
      ok: true,
      opened: "store",
      browser: "msedge",
    });
  });

  test("before the Recorder is published it opens the OpenBot browser as it always has, and asks nothing about their own", async () => {
    // No store ids at all, as shipped until the Recorder is published.
    installed = ["chrome", "msedge"];
    const desktop = build({ desktop: true, storeIds: {} });
    const since = asked.length;
    const opened = await openAs(desktop, "ben");
    expect(opened).toEqual({
      status: 200,
      body: {
        ok: true,
        computerId: personBrowserId(ben.id),
        browser: "chrome",
        window: "native",
        narration: "own",
      },
    });
    expect(askedSince(since)).toContain("POST /browser/open");
    expect(
      askedSince(since).filter((line) => line.includes("/browser/real")),
    ).toEqual([]);
    await call(desktop, "/api/browser/close", { method: "POST", as: "ben" });

    // Published only for a browser the person does not have: the OpenBot browser still.
    installed = ["chrome"];
    const edgeOnly = build({
      desktop: true,
      storeIds: { edge: PUBLISHED.edge },
    });
    expect((await openAs(edgeOnly, "ben")).body).toMatchObject({
      computerId: personBrowserId(ben.id),
      window: "native",
    });
    installed = ["chrome", "msedge"];
    await call(desktop, "/api/browser/close", { method: "POST", as: "ben" });
    await removeConnections(ben.id);
  });

  test("a browser that cannot be brought forward is told as any computer refusal is", async () => {
    const desktop = build({ desktop: true, storeIds: PUBLISHED });
    await connect(desktop, "ada", {
      via: "desktop",
      label: "Google Chrome on macOS",
    });
    refuseNextReal = {
      status: 502,
      error: "Google Chrome did not open. Try again.",
    };
    expect(await quietly(() => openAs(desktop, "ada"))).toEqual({
      status: 502,
      body: { error: "Google Chrome did not open. Try again." },
    });
    await removeConnections(ada.id);
  });

  test("hosted OpenBot is unchanged: a Desktop connection and a published Recorder open the browser in the page", async () => {
    const hosted = build({ storeIds: PUBLISHED });
    await connect(hosted, "cy", {
      via: "desktop",
      label: "Google Chrome on macOS",
    });
    const since = asked.length;
    const opened = await openAs(hosted, "cy");
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({
      computerId: personBrowserId(cy.id),
    });
    expect(
      askedSince(since).filter((line) => line.includes("/browser/real")),
    ).toEqual([]);
    await call(hosted, "/api/browser/close", { method: "POST", as: "cy" });
    await removeConnections(cy.id);
  });
});

describe("OpenBot Desktop as it runs, for its one person", () => {
  beforeAll(async () => {
    await initializeDevActorUser(database, true);
  });
  afterAll(async () => {
    await removeConnections(DEV_ACTOR.id);
  });

  test("the Recorder connected through Desktop lights the dot, names the browser, and Browser brings it forward", async () => {
    const desktop = build({ desktop: true, singleUser: true });
    const window = { origin: "http://127.0.0.1:3010" };
    const handed = await connect(desktop, null, {
      via: "desktop",
      label: "Google Chrome on macOS",
    });
    await report(desktop, handed.token, recordingReceipt());
    const response = await call(desktop, "/api/browser", { headers: window });
    const state = (await response.json()) as BrowserApiState;
    expect(state).toMatchObject({
      available: true,
      shows: "native",
      real: { connected: true, browsers: ["chrome", "msedge"] },
      activity: { phase: "recording", title: "Submit the receipt" },
    });
    const opened = await call(desktop, "/api/browser/open", {
      method: "POST",
      headers: window,
    });
    expect(await opened.json()).toEqual({
      ok: true,
      opened: "real",
      browser: "chrome",
    });
    const live = await database
      .select({ via: recorderConnections.via })
      .from(recorderConnections)
      .where(
        and(
          eq(recorderConnections.userId, DEV_ACTOR.id),
          isNull(recorderConnections.revokedAt),
        ),
      );
    expect(live).toEqual([{ via: "desktop" }]);
  });
});

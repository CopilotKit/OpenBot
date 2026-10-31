// A Bot's browser worked by a person, through the real routes and the real database: the bar and Record answer only the
// person holding the Bot's wheel, Record mints that person a Recorder connection for the one recording and Stop revokes
// it, a connection left by a recording the computer ended on its own is revoked on the next read, nobody else stops or
// narrates someone's recording, and the Bot's network lets the Recorder out only while a recording runs. The computer is
// a stand-in that answers its routes exactly as the contract types them (shared/bot-browser.ts): slice 1 builds the real
// ones.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  BOT_BROWSER_VIA,
  type BotBrowserApiState,
  type BotBrowserState,
  botBrowserComputerClearRequestSchema,
  botBrowserComputerPaths,
  botBrowserComputerRecordingRequestSchema,
} from "@openbot/shared/bot-browser";
import type { ComputerControlState } from "@openbot/shared/computer-control";
import {
  type BrowserNarrationRequest,
  browserNarrationRequestSchema,
  browserNavigateRequestSchema,
  browserTabsRequestSchema,
  type LauncherState,
} from "@openbot/shared/openbot-browser";
import type { RecorderConnectionsResponse } from "@openbot/shared/recorder-api";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import { inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import type { AuditEventInput } from "../src/audit";
import { openbotAddress } from "../src/browser/address";
import {
  botBrowserInstallId,
  botBrowserNetwork,
  botBrowserRequestSeconds,
} from "../src/browser/bot-browser";
import { botRecordRefusal, SHARED_COMPUTER_RECORD } from "../src/browser/host";
import { personBrowserId } from "../src/browser/person";
import {
  CALL_BUDGET_MS,
  OPEN_BUDGET_MS,
  STATE_TIMEOUT_MS,
} from "../src/browser/routes";
import { botSeat, personSeat } from "../src/computer/computer-key";
import { createComputerGateway } from "../src/computer/gateway";
import {
  type EgressPolicy,
  pushEgressPolicies,
  pushEgressPolicy,
  withPolicyPushOnWake,
} from "../src/computer/policy-network";
import { createSharedComputerProvider } from "../src/computer/provider";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { startHttpServer } from "../src/http-server";
import { createRecorderConnectionStore } from "../src/recorder/connections";
import { createRecorderExtension } from "../src/recorder/wiring";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { SESSION_LIFETIME_MS, testEnvironment } from "./support/environment";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const connections = createRecorderConnectionStore(database);
const prefix = `bot-browser-${randomUUID()}`;
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
/** Signed in, and not somebody this Bot is shared with. */
const cy = {
  id: `${prefix}-cy`,
  email: `${prefix}-cy@example.test`,
  name: "Cy",
};
const PEOPLE = { ada, ben, cy } as const;
const BOT = `${prefix}-sales`;
const BOT_NAME = "Sales Bot";
/** A Bot that runs on each person's own seat, where BOT runs on a computer of its own (isolated) everyone shares. */
const PERSONAL = `${prefix}-notes`;
const COMPUTER_TOKEN = "bot-browser-computer-token";
const PUBLIC = "https://openbot.example.com";
const GATEWAY = "wss://gateway.example.com/socket";
/** The stand-in computer's own port. */
const COMPUTER_PORT = 7893;
/** OpenBot's own HTTP server, where a case needs what `Bun.serve` itself does to a request (its 10 s idle close). */
const SERVER_PORT = 7894;
/** Where the Bot's owner lets it go: its own policy, which a recording widens and nothing else does. */
const OWN_POLICY: EgressPolicy = {
  mode: "allowlist_only",
  rules: [{ type: "domain", value: "example.org" }],
};
/** What the Recorder in the Bot's browser must reach: OpenBot and the gateway, host and port. */
const RECORDER_RULES = [
  { type: "domain", value: "openbot.example.com", ports: "443" },
  { type: "domain", value: "gateway.example.com", ports: "443" },
];

// ---- The stand-in computer --------------------------------------------------------------------

type Bot = {
  control: ComputerControlState;
  state: BotBrowserState;
  /** The connection the computer was handed with the running recording's start. */
  connection?: { token: string; connectionId: string; openbotUrl: string };
  /** Who pressed Record, as the start said. */
  startedBy?: string;
  narrated: BrowserNarrationRequest[];
  history: string[];
};
const bots = new Map<string, Bot>();
/** Every policy pushed to each computer, oldest first. */
const pushed = new Map<string, EgressPolicy[]>();
/** Every request the computer took, as `<method> <path> <computer>`. */
const asked: string[] = [];
/** How the computer answers the next start instead of starting, when a test says so. */
let refuseNextStart: { status: number; error: string } | null = null;
/** The next hand-back happens on the computer, but its answer never reaches OpenBot, as a timeout leaves it. */
let loseNextRelease = false;
/** How long the computer takes over the next request to each of its Bot's browser routes, when a test says so: a page
 * slow to load, the last of a recording slow to reach Intelligence. */
const slowNext = new Map<string, number>();
/** While set, the Bot's browser does not answer what it is showing until this settles, as a browser that is stuck. */
let stateStuck: Promise<void> | null = null;

const recorderIdle = (): LauncherState => ({
  connected: false,
  phase: "idle",
  actions: 0,
  narration: "external",
});

function botOf(id: string): Bot {
  let bot = bots.get(id);
  if (!bot) {
    bot = {
      control: {
        holder: "bot",
        since: new Date().toISOString(),
        requested: false,
        transitioning: false,
        resumeSnapshotRequired: false,
        recoveryRequired: false,
      },
      state: {
        open: true,
        tabs: [
          {
            id: "t1",
            url: "https://example.org/",
            title: "Example",
            active: true,
          },
        ],
        recorder: recorderIdle(),
      },
      narrated: [],
      history: [],
    };
    bots.set(id, bot);
  }
  return bot;
}

/** The computer ends a recording, as it does the moment the wheel leaves the person recording, and reports it as the
 * last one stopped, with whose it was. */
function endRecording(bot: Bot) {
  const { recordingBy: ended, ...rest } = bot.state;
  // The wheel going back with nothing recording ends nothing, and keeps the last recording's report as it was.
  if (!ended) {
    bot.connection = undefined;
    bot.startedBy = undefined;
    return;
  }
  bot.state = {
    ...rest,
    recorder: {
      ...recorderIdle(),
      lastStopped: {
        recordingId: bot.state.recorder?.recordingId ?? "rec-1",
        title: bot.state.recorder?.title ?? "",
        stoppedAt: Date.now(),
        actions: 3,
        phrases: 1,
      },
    },
    lastStoppedBy: ended,
  };
  bot.connection = undefined;
  bot.startedBy = undefined;
}

/** The wheel going back on the computer alone, as a restart or a stop does it, without OpenBot being told. */
function wheelBackOnItsOwn(id: string) {
  const bot = botOf(id);
  const { heldBy: _gone, ...control } = bot.control;
  bot.control = { ...control, holder: "bot" };
  endRecording(bot);
}

const conflict = (error: string) => Response.json({ error }, { status: 409 });

/** The computer's routes as the contract types them: the token, a Bot's id in `x-openbot-bot-id` (400 for a person's
 * browser), and each body read against the contract's schema. */
const computer = Bun.serve({
  hostname: "127.0.0.1",
  port: COMPUTER_PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("x-openbot-computer-token") !== COMPUTER_TOKEN)
      return Response.json({ error: "Unauthorized." }, { status: 401 });
    const id = request.headers.get("x-openbot-bot-id") ?? "";
    asked.push(`${request.method} ${url.pathname} ${id}`);
    if (url.pathname === "/health") return Response.json({ status: "ok" });
    if (url.pathname === "/computers")
      return Response.json({
        computers: [...bots.keys()].map((botId) => ({
          botId,
          status: "running",
        })),
      });
    if (url.pathname === "/egress-policy" && request.method === "PUT") {
      const { policy } = (await request.json()) as { policy: EgressPolicy };
      pushed.set(id, [...(pushed.get(id) ?? []), policy]);
      return Response.json({ ok: true });
    }
    // A Bot's browser is a seat's, as on the real computer: the Bot, and on a computer people share, the person too.
    const person = request.headers.get("x-openbot-person-id");
    const bot = botOf(person ? `${id}/${person}` : id);
    const body =
      request.method === "POST" ? await request.json().catch(() => null) : null;
    const holds = () => bot.control.holder === "human";
    switch (url.pathname) {
      case "/control":
        return Response.json(bot.control);
      case "/control/request": {
        bot.control = {
          ...bot.control,
          requested: true,
          request: {
            id: `request-${randomUUID()}`,
            reason: body?.reason ?? "Help",
            source: "manual",
            status: "waiting",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        };
        return Response.json(bot.control);
      }
      case "/control/take": {
        if (body?.requestId !== bot.control.request?.id)
          return Response.json(
            {
              error: "That request is no longer the current handoff.",
              controlRequestError: true,
            },
            { status: 409 },
          );
        bot.control = {
          ...bot.control,
          holder: "human",
          requested: false,
          ...(typeof body?.by === "string" ? { heldBy: body.by } : {}),
        };
        return Response.json(bot.control);
      }
      case "/control/release": {
        const { heldBy: _gone, ...control } = bot.control;
        bot.control = { ...control, holder: "bot" };
        endRecording(bot);
        if (loseNextRelease) {
          loseNextRelease = false;
          return Response.json({ error: "Gateway timeout." }, { status: 504 });
        }
        return Response.json(bot.control);
      }
    }
    if (!url.pathname.startsWith("/bot-browser/"))
      return Response.json({ error: "Not found." }, { status: 404 });
    if (id.startsWith("person-"))
      return Response.json(
        { error: "A person's own browser has its own routes." },
        { status: 400 },
      );
    bot.history.push(url.pathname);
    const slow = slowNext.get(url.pathname);
    if (slow !== undefined) {
      slowNext.delete(url.pathname);
      await Bun.sleep(slow);
    }
    switch (url.pathname) {
      case botBrowserComputerPaths.state:
        if (stateStuck) await stateStuck;
        return Response.json(bot.state);
      case botBrowserComputerPaths.tabs: {
        if (!holds()) return conflict("Take control first.");
        const parsed = browserTabsRequestSchema.safeParse(body);
        if (!parsed.success)
          return Response.json({ error: "Bad request." }, { status: 400 });
        if (parsed.data.action === "new")
          bot.state.tabs = [
            ...bot.state.tabs.map((tab) => ({ ...tab, active: false })),
            {
              id: `t${bot.state.tabs.length + 1}`,
              url: parsed.data.url ?? "about:blank",
              title: "",
              active: true,
            },
          ];
        return Response.json(bot.state);
      }
      case botBrowserComputerPaths.navigate: {
        if (!holds()) return conflict("Take control first.");
        const parsed = browserNavigateRequestSchema.safeParse(body);
        if (!parsed.success)
          return Response.json({ error: "Bad request." }, { status: 400 });
        if ("url" in parsed.data) {
          const next = parsed.data.url;
          bot.state.tabs = bot.state.tabs.map((tab) =>
            tab.active ? { ...tab, url: next } : tab,
          );
        }
        return Response.json(bot.state);
      }
      case botBrowserComputerPaths.recording: {
        const parsed = botBrowserComputerRecordingRequestSchema.safeParse(body);
        if (!parsed.success)
          return Response.json({ error: "Bad request." }, { status: 400 });
        if (parsed.data.action === "start") {
          const refusal = refuseNextStart;
          refuseNextStart = null;
          if (refusal)
            return Response.json(
              { error: refusal.error },
              { status: refusal.status },
            );
          if (!holds() || bot.control.heldBy !== parsed.data.by)
            return conflict("Only the person holding control can record.");
          if (bot.state.recordingBy)
            return conflict("A recording is already running.");
          bot.connection = parsed.data.connection;
          bot.startedBy = parsed.data.by;
          bot.state = {
            ...bot.state,
            recordingBy: parsed.data.by,
            recorder: {
              connected: true,
              // As the Recorder reports itself since it names its connection.
              userId: parsed.data.connection.user.id,
              connectionId: parsed.data.connection.connectionId,
              phase: "recording",
              recordingId: "rec-1",
              title: parsed.data.title,
              startedAt: Date.now(),
              actions: 0,
              narration: "external",
            },
          };
          return Response.json(bot.state);
        }
        if (!bot.state.recordingBy)
          return conflict("Nothing is being recorded.");
        endRecording(bot);
        return Response.json(bot.state);
      }
      case botBrowserComputerPaths.clear: {
        const parsed = botBrowserComputerClearRequestSchema.safeParse(body);
        if (!parsed.success)
          return Response.json({ error: "Bad request." }, { status: 400 });
        if (!holds() || bot.control.heldBy !== parsed.data.by)
          return conflict(
            "Only the person holding control of this Bot's browser can clear it. Take control first.",
          );
        // As the computer clears it: a recording there ends and its Recorder lets the person go, the profile goes, and
        // the browser starts again with nothing in it, the wheel still the person's.
        bot.connection = undefined;
        bot.startedBy = undefined;
        bot.state = {
          open: true,
          tabs: [
            {
              id: "fresh",
              url: "about:blank",
              title: "about:blank",
              active: true,
            },
          ],
          recorder: recorderIdle(),
        };
        return Response.json(bot.state);
      }
      case botBrowserComputerPaths.narration: {
        if (!bot.state.recordingBy)
          return conflict("Nothing is being recorded.");
        const parsed = browserNarrationRequestSchema.safeParse(body);
        if (!parsed.success)
          return Response.json({ error: "Bad request." }, { status: 400 });
        bot.narrated.push(parsed.data);
        return Response.json({ ok: true });
      }
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  },
});

// ---- OpenBot, as index.ts builds it ------------------------------------------------------------

const audits: AuditEventInput[] = [];
/** An audit row that cannot be written, as when the trail is down: the store throws for this event. */
let auditFails: string | null = null;
const auditStore = {
  insert: async (event: AuditEventInput) => {
    if (event.eventType === auditFails)
      throw new Error("the audit trail is unavailable");
    audits.push(event);
  },
};
const roleRepository = { rolesForUser: async () => ["user" as const] };
const better = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const name = /test-session=(\w+)/.exec(headers.get("cookie") ?? "")?.[1];
      return name && name in PEOPLE
        ? { user: PEOPLE[name as keyof typeof PEOPLE] }
        : null;
    },
  },
};
// The Bots are shared with Ada and Ben, not with Cy: the computer routes' own access rule decides.
const profiles = {
  get: async (actor: { id: string }, botId: string) =>
    (botId === BOT || botId === PERSONAL) && actor.id !== cy.id
      ? { name: BOT_NAME, visibility: "public", ownerUserId: ada.id }
      : null,
};

const config = loadConfig(
  testEnvironment({
    OPENBOT_PUBLIC_URL: PUBLIC,
    INTELLIGENCE_GATEWAY_WS_URL: GATEWAY,
    AGENT_COMPUTER_URL: `http://127.0.0.1:${COMPUTER_PORT}`,
    COMPUTER_TOKEN,
  }),
);
// The Bot's own policy as its owner's controls give it, with the recording's widening on top (admin/controls.ts
// `duringRecording`, which index.ts sets to this).
const duringRecording = botBrowserNetwork({
  connections,
  openbotUrls: [config.publicUrl, config.appUrl],
  gatewayUrl: config.runtime.intelligence.gatewayWsUrl,
});
const policyForBot = (botId: string) => duringRecording(botId, OWN_POLICY);
const sharedComputer = createSharedComputerProvider({
  baseUrl: `http://127.0.0.1:${COMPUTER_PORT}`,
  token: COMPUTER_TOKEN,
});
const provider = withPolicyPushOnWake(sharedComputer, {
  policyForBot,
  token: COMPUTER_TOKEN,
});
const gateway = createComputerGateway({
  provider,
  auditStore,
  policy: () => undefined,
  token: COMPUTER_TOKEN,
  // BOT is isolated, so everyone who uses it works one browser of it, as these tests are about; PERSONAL runs on each
  // person's own seat (computer/computer-key.ts).
  seats: {
    seatFor: async (botId, personId) =>
      botId === BOT ? botSeat(botId) : personSeat(personId, botId),
  },
});
const recorder = createRecorderExtension({
  config,
  database,
  organizationAuth: undefined,
  roleRepository,
  peopleStore: { isRevoked: async () => false },
  personalSpaces: {
    containerFor: (userId: string) => `space-of-${userId}`,
    state: async () => ({ state: "unassigned" as const, containerId: null }),
    kick: () => {},
  },
  auditStore,
  sessionLifetimeMs: SESSION_LIFETIME_MS,
});
const args = [config] as unknown as Parameters<typeof createApp>;
args[1] = better as never;
args[2] = roleRepository;
args[7] = gateway;
args[8] = {} as never;
args[9] = profiles as never;
args[12] = auditStore;
args[34] = {
  recorder,
  botBrowser: {
    recorder,
    openbotUrl: openbotAddress(config),
    token: COMPUTER_TOKEN,
    // As index.ts pushes it: the Bot's policy, to the computer of the seat the recording is on.
    pushPolicy: async (seat) => {
      const policy = await policyForBot(seat.botId);
      await pushEgressPolicy(await gateway.locate(seat), seat.botId, policy, {
        token: COMPUTER_TOKEN,
      });
    },
  },
};
const app = createApp(...args);
/** The same OpenBot where every Bot shares the one computer, as index.ts builds it: Record refused in every Bot's browser. */
const refusingArgs = [...args] as typeof args;
refusingArgs[34] = {
  ...(args[34] as object),
  botBrowser: {
    ...(args[34] as { botBrowser: object }).botBrowser,
    recordRefused: botRecordRefusal(sharedComputer) ?? undefined,
  },
} as never;
const refusingApp = createApp(...refusingArgs);

const call = (
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
const browser = (rest = "") =>
  `/api/computers/${encodeURIComponent(BOT)}/browser${rest}`;
const post = (as: keyof typeof PEOPLE, rest: string, json: unknown) =>
  call(browser(rest), { method: "POST", as, json });
const stateFor = async (as: keyof typeof PEOPLE) =>
  (await (await call(browser(), { as })).json()) as BotBrowserApiState;
/** The connections the Bot's browser holds, live, whoever they are for. */
const held = () =>
  connections.atInstall(botBrowserInstallId(BOT), BOT_BROWSER_VIA);
const lastPushed = () => pushed.get(BOT)?.at(-1);
const auditsOf = (eventType: string) =>
  audits.filter((audit) => audit.eventType === eventType);

/** The person asks for the wheel and takes it, through OpenBot, as the Bot's screen does. */
async function takeWheel(as: keyof typeof PEOPLE) {
  const asked = await call(
    `/api/computers/${encodeURIComponent(BOT)}/control/request`,
    {
      method: "POST",
      as,
      json: { reason: "Let me show you" },
    },
  );
  expect(asked.status).toBe(200);
  const { request } = (await asked.json()) as ComputerControlState;
  const taken = await call(
    `/api/computers/${encodeURIComponent(BOT)}/control/take`,
    {
      method: "POST",
      as,
      json: { requestId: request?.id },
    },
  );
  expect(taken.status).toBe(200);
  return request?.id as string;
}

async function handBack(as: keyof typeof PEOPLE, requestId: string) {
  const released = await call(
    `/api/computers/${encodeURIComponent(BOT)}/control/release`,
    { method: "POST", as, json: { requestId } },
  );
  expect(released.status).toBe(200);
}

async function record(as: keyof typeof PEOPLE, title = "File an expense") {
  return post(as, "/recording", { action: "start", title });
}

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

describe("who reaches a Bot's browser", () => {
  test("someone who cannot use the Bot gets 404 from every route, and nothing reaches the computer", async () => {
    const before = asked.length;
    expect((await call(browser(), { as: "cy" })).status).toBe(404);
    for (const [rest, json] of [
      ["/tabs", { action: "new" }],
      ["/navigate", { url: "https://example.org/" }],
      ["/recording", { action: "start", title: "Sneaky" }],
      ["/narration", { text: "hello", startedAt: 1, endedAt: 2, sentAt: 3 }],
    ] as const) {
      const answer = await post("cy", rest, json);
      expect([rest, answer.status]).toEqual([rest, 404]);
      expect(await answer.json()).toEqual({ error: "There is no such Bot." });
    }
    expect(asked.slice(before)).toEqual([]);
    expect((await call(browser())).status).toBe(401);
  });

  test("a person's own browser has no Bot's browser routes, even for its person", async () => {
    const own = `/api/computers/${personBrowserId(ada.id)}/browser`;
    expect((await call(own, { as: "ada" })).status).toBe(404);
    expect(
      (
        await call(`${own}/recording`, {
          method: "POST",
          as: "ada",
          json: { action: "start", title: "Mine" },
        })
      ).status,
    ).toBe(404);
  });

  test("the old Teach a browser workflow routes are gone", async () => {
    expect(
      (await call(`/api/demonstrations?botId=${BOT}`, { as: "ada" })).status,
    ).toBe(404);
    expect(
      (
        await call("/api/demonstrations", {
          method: "POST",
          as: "ada",
          json: { botId: BOT, title: "Old" },
        })
      ).status,
    ).toBe(404);
  });
});

describe("the bar", () => {
  test("refuses a caller who does not hold the wheel and works for the one who does", async () => {
    // The Bot has the wheel: the bar shows where it is, and acts for nobody.
    const watching = await stateFor("ada");
    expect(watching).toMatchObject({
      open: true,
      mine: false,
      recordingIsMine: false,
    });
    expect(watching.tabs[0]?.url).toBe("https://example.org/");
    const refused = await post("ada", "/navigate", {
      url: "https://example.com/",
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "Take control of the Bot's browser first.",
    });
    expect(botOf(BOT).history).not.toContain(botBrowserComputerPaths.navigate);

    const requestId = await takeWheel("ada");
    // The computer was told who took it.
    expect(botOf(BOT).control.heldBy).toBe(ada.id);
    expect((await stateFor("ada")).mine).toBe(true);
    expect((await stateFor("ben")).mine).toBe(false);

    // Ben may use the Bot, but the wheel is Ada's.
    for (const [rest, json] of [
      ["/navigate", { url: "https://example.com/" }],
      ["/navigate", { action: "back" }],
      ["/tabs", { action: "new" }],
    ] as const) {
      const answer = await post("ben", rest, json);
      expect([rest, answer.status]).toEqual([rest, 409]);
    }
    expect(botOf(BOT).history).not.toContain(botBrowserComputerPaths.navigate);
    expect(botOf(BOT).history).not.toContain(botBrowserComputerPaths.tabs);

    const went = await post("ada", "/navigate", {
      url: "https://example.com/",
    });
    expect(went.status).toBe(200);
    const after = (await went.json()) as BotBrowserApiState;
    expect(after.mine).toBe(true);
    expect(after.tabs.find((tab) => tab.active)?.url).toBe(
      "https://example.com/",
    );
    for (const action of ["back", "forward", "reload"] as const)
      expect((await post("ada", "/navigate", { action })).status).toBe(200);
    const opened = await post("ada", "/tabs", {
      action: "new",
      url: "https://example.net/",
    });
    expect(opened.status).toBe(200);
    expect(((await opened.json()) as BotBrowserApiState).tabs).toHaveLength(2);

    // Only web addresses, as in the person's own browser: never the computer's own disk.
    for (const [rest, json] of [
      ["/navigate", { url: "file:///etc/passwd" }],
      ["/tabs", { action: "new", url: "javascript:alert(1)" }],
    ] as const) {
      const answer = await post("ada", rest, json);
      expect(answer.status).toBe(400);
      expect(await answer.json()).toEqual({
        error: "Only web addresses open here.",
      });
    }

    await handBack("ada", requestId);
    expect((await post("ada", "/navigate", { action: "reload" })).status).toBe(
      409,
    );
  });
});

describe("through OpenBot's own HTTP server", () => {
  /*
   * `Bun.serve` closes a request that has sent nothing for 10 s, its default idle timeout, while the handler is still at
   * work, and the person gets an empty reply instead of the answer or a sentence. A Bot's browser routes wait on its
   * computer for longer than that: a page that takes its time, the last of a recording on its way to Intelligence when
   * Stop is pressed, a start that connects the Recorder and records. The person's own browser's routes were measured
   * doing exactly this in #858's end-to-end run.
   */
  const http = (path: string, init: { json?: unknown } = {}) =>
    fetch(`http://127.0.0.1:${SERVER_PORT}${browser(path)}`, {
      method: init.json === undefined ? "GET" : "POST",
      headers: {
        cookie: "test-session=ada",
        ...(init.json === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
      signal: AbortSignal.timeout(40_000),
    });

  test("each route keeps the person's request open for its own waits, past Bun's 10 s, and the read keeps Bun's own", () => {
    const at = (rest: string) =>
      botBrowserRequestSeconds(
        `/api/computers/${encodeURIComponent(BOT)}/browser${rest}`,
      );
    // A start connects the Recorder and records, waiting on the computer up to 90 s; Stop waits for the last of it.
    expect((at("/recording") ?? 0) * 1000).toBeGreaterThan(
      OPEN_BUDGET_MS + STATE_TIMEOUT_MS,
    );
    for (const rest of ["/tabs", "/navigate", "/narration"])
      expect((at(rest) ?? 0) * 1000).toBeGreaterThan(
        CALL_BUDGET_MS + STATE_TIMEOUT_MS,
      );
    // A clear ends a recording and waits for the last of it, wipes the browser and starts it again.
    expect((at("/clear") ?? 0) * 1000).toBeGreaterThan(
      OPEN_BUDGET_MS + STATE_TIMEOUT_MS,
    );
    // Under the largest idle timeout Bun.serve takes.
    for (const rest of [
      "/recording",
      "/tabs",
      "/navigate",
      "/narration",
      "/clear",
    ])
      expect(at(rest)).toBeLessThanOrEqual(255);
    expect(at("")).toBeUndefined();
    expect(botBrowserRequestSeconds("/api/browser/recording")).toBeUndefined();
  });

  test("a hand-back, a cancel, a stop and a reset wait for the recording they end, past Bun's 10 s", () => {
    // Each waits on the computer for the recording in the Bot's browser to end and the last of it to be sent (20 s).
    for (const rest of [
      "/control/release",
      "/control/cancel",
      "/computers/stop",
      "/computers/reset",
    ]) {
      const seconds = botBrowserRequestSeconds(
        `/api/computers/${encodeURIComponent(BOT)}${rest}`,
      );
      expect((seconds ?? 0) * 1000).toBeGreaterThan(
        CALL_BUDGET_MS + STATE_TIMEOUT_MS,
      );
      expect(seconds).toBeLessThanOrEqual(255);
    }
    // The other control routes answer at once, and keep Bun's own.
    for (const rest of ["/control/take", "/control/request", "/control"])
      expect(
        botBrowserRequestSeconds(
          `/api/computers/${encodeURIComponent(BOT)}${rest}`,
        ),
      ).toBeUndefined();
  });

  test("a slow page and a slow Stop are answered, never with an empty reply, and a stuck browser says so in seconds", async () => {
    const server = startHttpServer({
      port: SERVER_PORT,
      config,
      resolveRequestActor: async () => {
        throw new Error("Only the live screen asks this.");
      },
      agentProfileStore: profiles as never,
      computerGateway: gateway,
      app,
    });
    let unstick = () => {};
    try {
      const requestId = await takeWheel("ada");
      expect((await record("ada", "Pay the slow vendor")).status).toBe(200);

      // A page that takes 17 s to load, and the last of the recording taking as long to reach Intelligence at Stop: past
      // the 10 s, and past the 4 s granularity of the socket timers that close a request after it (uSockets').
      slowNext.set(botBrowserComputerPaths.navigate, 17_000);
      slowNext.set(botBrowserComputerPaths.recording, 17_000);
      const [navigated, stopped] = await Promise.all([
        http("/navigate", { json: { url: "https://example.org/slow" } }),
        http("/recording", { json: { action: "stop" } }),
      ]);
      expect(navigated.status).toBe(200);
      expect(await navigated.json()).toMatchObject({ mine: true });
      expect(stopped.status).toBe(200);
      expect(await stopped.json()).toMatchObject({ recordingIsMine: false });
      expect(await held()).toEqual([]);

      // The Bot's browser stops answering what it shows: said, as the Bot's, well before the request would be closed.
      stateStuck = new Promise<void>((resolve) => {
        unstick = resolve;
      });
      const asking = Date.now();
      const stuck = await http("");
      expect(stuck.status).toBe(504);
      expect(await stuck.json()).toEqual({
        error:
          "The Bot's browser is taking too long to answer. The page may still be loading.",
      });
      expect(Date.now() - asking).toBeLessThan(10_000);
      unstick();
      stateStuck = null;
      expect((await http("")).status).toBe(200);
      await handBack("ada", requestId);
    } finally {
      unstick();
      stateStuck = null;
      slowNext.clear();
      await server.stop(true);
    }
  }, 60_000);
});

describe("recording in a Bot's browser", () => {
  test("Record mints a bot-browser connection for the person at the wheel, nobody else stops or narrates it, and Stop revokes it", async () => {
    // Nobody holds the wheel: nobody records, and no connection is made.
    const early = await record("ada");
    expect(early.status).toBe(409);
    expect(await held()).toEqual([]);

    const requestId = await takeWheel("ada");
    const notBen = await record("ben");
    expect(notBen.status).toBe(409);
    expect(await notBen.json()).toEqual({
      error: "Take control of the Bot's browser first.",
    });
    expect(await held()).toEqual([]);

    const started = await record("ada");
    expect(started.status).toBe(200);
    const recording = (await started.json()) as BotBrowserApiState;
    expect(recording).toMatchObject({
      mine: true,
      recordingIsMine: true,
      recordingBy: ada.id,
    });
    expect(recording.recorder?.title).toBe("File an expense");

    // The connection is Ada's, for this Bot's browser, made as the Recorder's own exchange makes one.
    const [connection, ...others] = await held();
    expect(others).toEqual([]);
    expect(connection).toMatchObject({
      userId: ada.id,
      via: BOT_BROWSER_VIA,
      label: `${BOT_NAME}'s browser`,
      extensionId: RECORDER_EXTENSION_ID,
      installId: botBrowserInstallId(BOT),
    });
    const handed = botOf(BOT).connection;
    expect(botOf(BOT).startedBy).toBe(ada.id);
    expect(handed?.openbotUrl).toBe(PUBLIC);
    expect(handed?.connectionId).toBe(connection?.id);
    // The token the computer was handed signs the Recorder in as Ada, and nobody else.
    const me = await call("/api/recorder/me", {
      headers: { authorization: `Bearer ${handed?.token}` },
    });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { id: string } }).user.id).toBe(
      ada.id,
    );
    expect(auditsOf("recorder.connected").at(-1)?.payload).toMatchObject({
      connectionId: connection?.id,
      via: BOT_BROWSER_VIA,
    });
    // In Settings, Browsers while it lives, named for the Bot.
    const listed = (await (
      await call("/api/recorder/connections", { as: "ada" })
    ).json()) as RecorderConnectionsResponse;
    expect(listed.connections.map((each) => [each.label, each.via])).toEqual([
      [`${BOT_NAME}'s browser`, BOT_BROWSER_VIA],
    ]);

    // Ben sees that a recording runs, and nothing of what it is.
    const seenByBen = await stateFor("ben");
    expect(seenByBen).toMatchObject({ mine: false, recordingIsMine: false });
    expect(seenByBen.recorder).toEqual({
      connected: true,
      phase: "recording",
      actions: 0,
      narration: "external",
    });
    // And cannot stop it or speak into it.
    const benStops = await post("ben", "/recording", { action: "stop" });
    expect(benStops.status).toBe(409);
    const now = Date.now();
    const benSays = await post("ben", "/narration", {
      text: "this is not my recording",
      startedAt: now - 2_000,
      endedAt: now - 500,
      sentAt: now,
    });
    expect(benSays.status).toBe(409);
    expect(botOf(BOT).narrated).toEqual([]);
    expect(botOf(BOT).state.recordingBy).toBe(ada.id);
    expect(await held()).toHaveLength(1);

    // Ada's phrase lands on the server's clock, though her computer's clock is an hour behind.
    const hourBehind = Date.now() - 3_600_000;
    const before = Date.now();
    const said = await post("ada", "/narration", {
      text: "Open the expenses page",
      startedAt: hourBehind - 2_000,
      endedAt: hourBehind - 500,
      sentAt: hourBehind,
    });
    const after = Date.now();
    expect(said.status).toBe(200);
    expect(await said.json()).toEqual({ ok: true });
    const phrase = botOf(BOT).narrated[0] as {
      text: string;
      startedAt: number;
      endedAt: number;
      sentAt: number;
    };
    expect(phrase.text).toBe("Open the expenses page");
    expect(phrase.sentAt).toBeGreaterThanOrEqual(before);
    expect(phrase.sentAt).toBeLessThanOrEqual(after);
    expect(phrase.sentAt - phrase.startedAt).toBe(2_000);
    expect(phrase.sentAt - phrase.endedAt).toBe(500);

    // A second Record while one runs is refused, and the running recording keeps its connection.
    expect((await record("ada", "Again")).status).toBe(409);
    expect((await held()).map((each) => each.id)).toEqual([
      connection?.id as string,
    ]);

    const stopped = await post("ada", "/recording", { action: "stop" });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({
      mine: true,
      recordingIsMine: false,
    });
    expect(await held()).toEqual([]);
    expect(
      (
        await call("/api/recorder/me", {
          headers: { authorization: `Bearer ${handed?.token}` },
        })
      ).status,
    ).toBe(401);
    expect(auditsOf("recorder.revoked").at(-1)?.payload).toEqual({
      connectionId: connection?.id,
      via: BOT_BROWSER_VIA,
      reason: "stopped",
    });
    // Nothing to stop now.
    expect((await post("ada", "/recording", { action: "stop" })).status).toBe(
      409,
    );

    await handBack("ada", requestId);
  });

  test("the last recording stopped in a Bot's browser is shown only to the person it was", async () => {
    const requestId = await takeWheel("ada");
    expect((await record("ada", "Pay the March invoice")).status).toBe(200);
    expect((await post("ada", "/recording", { action: "stop" })).status).toBe(
      200,
    );
    await handBack("ada", requestId);

    const ada = await stateFor("ada");
    expect(ada.lastStoppedBy).toBe(botOf(BOT).state.lastStoppedBy);
    expect(ada.recorder?.lastStopped).toMatchObject({
      title: "Pay the March invoice",
      actions: 3,
      phrases: 1,
    });
    // Ben opens the same Bot's screen next: nothing of Ada's recording, not its title, its counts or whose it was.
    const ben = await stateFor("ben");
    expect(ben).not.toHaveProperty("lastStoppedBy");
    expect(ben.recorder).toBeDefined();
    expect(ben.recorder).not.toHaveProperty("lastStopped");
    expect(JSON.stringify(ben)).not.toContain("Pay the March invoice");
  });

  test("a connection left by a recording the computer ended on its own is revoked on the next read", async () => {
    await takeWheel("ben");
    expect((await record("ben", "Reconcile the ledger")).status).toBe(200);
    const [left] = await held();
    expect(left?.userId).toBe(ben.id);

    // The computer hands the wheel back on its own (a restart, say) and the recording ends with it. OpenBot is not told.
    wheelBackOnItsOwn(BOT);
    expect(await held()).toHaveLength(1);

    // The next read of the Bot's browser, whoever asks, finds it left behind.
    const read = await stateFor("ada");
    expect(read).toMatchObject({ mine: false, recordingIsMine: false });
    expect(read.recordingBy).toBeUndefined();
    expect(await held()).toEqual([]);
    expect(auditsOf("recorder.revoked").at(-1)?.payload).toEqual({
      connectionId: left?.id,
      via: BOT_BROWSER_VIA,
      reason: "ended",
    });
  });

  test("handing the wheel back through OpenBot revokes the recording's connection at once", async () => {
    const requestId = await takeWheel("ada");
    expect((await record("ada", "Approve the invoice")).status).toBe(200);
    expect(await held()).toHaveLength(1);
    await handBack("ada", requestId);
    expect(await held()).toEqual([]);
    expect(auditsOf("recorder.revoked").at(-1)?.payload).toMatchObject({
      via: BOT_BROWSER_VIA,
      reason: "ended",
    });
  });

  test("the Bot's pushed policy carries OpenBot and the gateway only while a recording runs", async () => {
    const widened: EgressPolicy = {
      mode: "allowlist_only",
      rules: [...OWN_POLICY.rules, ...RECORDER_RULES] as EgressPolicy["rules"],
    };
    // Every push so far has been the Bot's own policy or, while one of the recordings above ran, the widened one.
    expect(
      pushed
        .get(BOT)
        ?.every((policy) =>
          [OWN_POLICY, widened].some((each) => Bun.deepEquals(each, policy)),
        ),
    ).toBe(true);
    expect(lastPushed()).toEqual(OWN_POLICY);

    await takeWheel("ada");
    expect((await record("ada", "Book travel")).status).toBe(200);
    // Pushed before the computer was asked to start: the Recorder asks OpenBot whether its connection stands as it
    // takes it.
    const history = asked.filter((line) => line.endsWith(` ${BOT}`));
    const start = history.lastIndexOf(
      `POST ${botBrowserComputerPaths.recording} ${BOT}`,
    );
    expect(history.slice(0, start).at(-1)).toBe(`PUT /egress-policy ${BOT}`);
    expect(lastPushed()).toEqual(widened);

    // The periodic push, from any server, keeps the Recorder's way out while the recording runs.
    const report = await pushEgressPolicies({
      provider: sharedComputer,
      token: COMPUTER_TOKEN,
      policyForBot,
    });
    expect(report.pushed).toContain(BOT);
    expect(lastPushed()).toEqual(widened);

    expect((await post("ada", "/recording", { action: "stop" })).status).toBe(
      200,
    );
    expect(lastPushed()).toEqual(OWN_POLICY);
    await pushEgressPolicies({
      provider: sharedComputer,
      token: COMPUTER_TOKEN,
      policyForBot,
    });
    expect(lastPushed()).toEqual(OWN_POLICY);

    // A recording the computer ended on its own: the read that finds its connection pushes the Bot its own again.
    expect((await record("ada", "Book travel again")).status).toBe(200);
    expect(lastPushed()).toEqual(widened);
    wheelBackOnItsOwn(BOT);
    await stateFor("ben");
    expect(lastPushed()).toEqual(OWN_POLICY);

    // And a hand back through OpenBot narrows it before the Bot acts again.
    const again = await takeWheel("ada");
    expect((await record("ada", "One more")).status).toBe(200);
    expect(lastPushed()).toEqual(widened);
    await handBack("ada", again);
    expect(lastPushed()).toEqual(OWN_POLICY);
  });

  test("a connection whose row cannot be written is not made, and the computer is never asked to record", async () => {
    // The connection and its recorder.connected row are one transaction (recorder/connections.ts), for a Bot's browser
    // as for every other: a trail that cannot be written makes no connection, and Record says it could not connect.
    await takeWheel("ada");
    const before = asked.length;
    auditFails = "recorder.connected";
    try {
      const refused = await record("ada", "Unaudited");
      expect(refused.status).toBe(500);
      expect(await refused.json()).toEqual({
        error: "The Recorder could not be connected. Try again.",
      });
    } finally {
      auditFails = null;
    }
    expect(await held()).toEqual([]);
    expect(
      asked
        .slice(before)
        .filter((line) => line.includes(botBrowserComputerPaths.recording)),
    ).toEqual([]);
    // Nothing was made, so the next Record makes one as usual.
    expect((await record("ada", "Audited")).status).toBe(200);
    expect(await held()).toHaveLength(1);
    expect((await post("ada", "/recording", { action: "stop" })).status).toBe(
      200,
    );
  });

  test("a Stop the computer has done is answered as done when the trail cannot take the revoke, and the hand back ends the connection", async () => {
    const requestId = await takeWheel("ada");
    expect((await record("ada", "Pay the March invoice")).status).toBe(200);
    const [connection] = await held();
    auditFails = "recorder.revoked";
    try {
      const stopped = await post("ada", "/recording", { action: "stop" });
      expect(stopped.status).toBe(200);
      expect(await stopped.json()).toMatchObject({ recordingIsMine: false });
    } finally {
      auditFails = null;
    }
    // Not ended without its row: it stands until OpenBot next finds it left behind.
    expect((await held()).map((each) => each.id)).toEqual([connection?.id]);
    await handBack("ada", requestId);
    expect(await held()).toEqual([]);
    expect(auditsOf("recorder.revoked").at(-1)?.payload).toEqual({
      connectionId: connection?.id,
      via: BOT_BROWSER_VIA,
      reason: "ended",
    });
  });

  test("someone else's recording shows only that one is running: never its count of steps or its microphone", async () => {
    const requestId = await takeWheel("ada");
    expect((await record("ada", "Approve the invoice")).status).toBe(200);
    const running = botOf(BOT).state.recorder as LauncherState;
    botOf(BOT).state.recorder = { ...running, actions: 7, voice: "listening" };

    const ada = await stateFor("ada");
    expect(ada.recorder).toMatchObject({ actions: 7, voice: "listening" });
    const ben = await stateFor("ben");
    expect(ben.recordingBy).toBe(ada.recordingBy);
    expect(ben.recorder?.phase).toBe("recording");
    expect(ben.recorder?.actions).toBe(0);
    expect(ben.recorder).not.toHaveProperty("voice");
    expect(JSON.stringify(ben)).not.toContain("Approve the invoice");
    await handBack("ada", requestId);
  });

  test("a hand-back whose answer never came still ends the recording's connection and the Bot's wider policy", async () => {
    const requestId = await takeWheel("ada");
    expect((await record("ada", "Send the reminder")).status).toBe(200);
    expect(await held()).toHaveLength(1);
    loseNextRelease = true;
    const released = await call(
      `/api/computers/${encodeURIComponent(BOT)}/control/release`,
      { method: "POST", as: "ada", json: { requestId } },
    );
    expect(released.status).not.toBe(200);
    // The computer handed it back all the same: nothing is left that the Bot could act with.
    expect(botOf(BOT).control.holder).toBe("bot");
    expect(await held()).toEqual([]);
    expect(lastPushed()).toEqual(OWN_POLICY);
  });

  test("where Bots share one computer, Record is refused before a connection is minted, and the screen says why", async () => {
    expect(botRecordRefusal(sharedComputer)).toBe(SHARED_COMPUTER_RECORD);
    expect(botRecordRefusal({ isolation: "per-person" })).toBeNull();
    expect(botRecordRefusal(undefined)).toBeNull();

    const requestId = await takeWheel("ada");
    const startsBefore = asked.filter((line) =>
      line.includes(botBrowserComputerPaths.recording),
    ).length;
    const refused = await refusingApp.request(
      `http://openbot.test${browser("/recording")}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "test-session=ada",
        },
        body: JSON.stringify({ action: "start", title: "Pay the rent" }),
      },
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: SHARED_COMPUTER_RECORD });
    expect(await held()).toEqual([]);
    expect(
      asked.filter((line) => line.includes(botBrowserComputerPaths.recording)),
    ).toHaveLength(startsBefore);

    const shown = (await (
      await refusingApp.request(`http://openbot.test${browser()}`, {
        headers: { cookie: "test-session=ada" },
      })
    ).json()) as BotBrowserApiState;
    expect(shown.recordRefused).toBe(SHARED_COMPUTER_RECORD);
    // Where each Bot has its own computer, nothing is said in place of Record.
    expect(await stateFor("ada")).not.toHaveProperty("recordRefused");
    await handBack("ada", requestId);
  });

  test("a start the computer refuses leaves no connection and no wider policy behind", async () => {
    await takeWheel("ada");
    // The Recorder in the Bot's browser could not be connected: the computer says so, for the person.
    refuseNextStart = {
      status: 502,
      error: "The Recorder could not be connected. Try again.",
    };
    const refused = await record("ada", "Will not start");
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({
      error: "The Recorder could not be connected. Try again.",
    });
    expect(await held()).toEqual([]);
    expect(auditsOf("recorder.revoked").at(-1)?.payload).toMatchObject({
      via: BOT_BROWSER_VIA,
      reason: "not-started",
    });
    expect(lastPushed()).toEqual(OWN_POLICY);
  });
});

describe("a Bot on each person's own seat", () => {
  const route = (rest: string) =>
    `/api/computers/${encodeURIComponent(PERSONAL)}${rest}`;
  async function takeOwnWheel(as: keyof typeof PEOPLE) {
    const asked = await call(route("/control/request"), {
      method: "POST",
      as,
      json: { reason: "Let me show you" },
    });
    expect(asked.status).toBe(200);
    const { request } = (await asked.json()) as ComputerControlState;
    const taken = await call(route("/control/take"), {
      method: "POST",
      as,
      json: { requestId: request?.id },
    });
    expect(taken.status).toBe(200);
    return request?.id as string;
  }
  const heldFor = async (person: string) =>
    (
      await connections.atInstall(
        botBrowserInstallId(PERSONAL),
        BOT_BROWSER_VIA,
      )
    )
      .filter((connection) => connection.userId === person)
      .map((connection) => connection.id);

  test("one person's hand-back ends only their own recording, never another person's on their own seat", async () => {
    // Ada and Ben each record in the Bot's browser on their own seat: two browsers, two recordings, two connections.
    const adaRequest = await takeOwnWheel("ada");
    await takeOwnWheel("ben");
    for (const as of ["ada", "ben"] as const)
      expect(
        (
          await call(route("/browser/recording"), {
            method: "POST",
            as,
            json: { action: "start", title: `${as}'s task` },
          })
        ).status,
      ).toBe(200);
    expect(await heldFor(ada.id)).toHaveLength(1);
    const bens = await heldFor(ben.id);
    expect(bens).toHaveLength(1);

    // Each reads only their own: Ben's screen does not show Ada's recording, nor end her connection as left behind.
    const benSees = (await (
      await call(route("/browser"), { as: "ben" })
    ).json()) as BotBrowserApiState;
    expect(benSees.recordingBy).toBe(ben.id);
    expect(await heldFor(ada.id)).toHaveLength(1);

    // Ada hands back on her seat: her connection ends, and Ben's recording goes on.
    const released = await call(route("/control/release"), {
      method: "POST",
      as: "ada",
      json: { requestId: adaRequest },
    });
    expect(released.status).toBe(200);
    expect(await heldFor(ada.id)).toEqual([]);
    expect(await heldFor(ben.id)).toEqual(bens);
  });
});

describe("clearing a Bot's browser", () => {
  const clears = () =>
    botOf(BOT).history.filter((path) => path === botBrowserComputerPaths.clear)
      .length;
  const clear = (as: keyof typeof PEOPLE) =>
    call(browser("/clear"), { method: "POST", as });

  test("only the person holding the wheel clears it: never under the Bot, never by someone watching, and it is on the trail", async () => {
    // Whoever held it last, the Bot has the wheel back now.
    wheelBackOnItsOwn(BOT);
    await stateFor("ada");
    const before = clears();
    const audited = auditsOf("computer.browser_cleared").length;

    expect((await clear("cy")).status).toBe(404);
    const underTheBot = await clear("ada");
    expect(underTheBot.status).toBe(409);
    expect(await underTheBot.json()).toEqual({
      error: "Take control of the Bot's browser first.",
    });
    const requestId = await takeWheel("ada");
    // Ben may use the Bot, but the wheel is Ada's.
    expect((await clear("ben")).status).toBe(409);
    expect(clears()).toBe(before);
    expect(auditsOf("computer.browser_cleared")).toHaveLength(audited);

    // Ada is recording when she clears it.
    expect((await record("ada", "Before the clear")).status).toBe(200);
    expect(await held()).toHaveLength(1);
    const cleared = await clear("ada");
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      open: true,
      mine: true,
      recordingIsMine: false,
      tabs: [{ url: "about:blank", active: true }],
    });
    expect(clears()).toBe(before + 1);
    // Who cleared which Bot's browser, as a reset is recorded.
    expect(auditsOf("computer.browser_cleared").slice(audited)).toEqual([
      expect.objectContaining({
        targetType: "computer",
        targetId: BOT,
        actorUserId: ada.id,
        payload: expect.objectContaining({ bot: BOT, actor: ada.id }),
      }),
    ]);
    // The recording ended with the clear: its connection goes, and the Bot is pushed its own policy again.
    expect(await held()).toEqual([]);
    expect(lastPushed()).toEqual(OWN_POLICY);
    // And the wheel is still hers.
    expect((await stateFor("ada")).mine).toBe(true);
    await handBack("ada", requestId);
  });

  test("a clear the trail cannot take is said, for the person, rather than answered as done", async () => {
    const requestId = await takeWheel("ada");
    auditFails = "computer.browser_cleared";
    try {
      const cleared = await clear("ada");
      expect(cleared.status).toBe(500);
      expect(await cleared.json()).toEqual({
        error:
          "The Bot's browser was cleared, but OpenBot couldn't finish. Clear it again.",
      });
    } finally {
      auditFails = null;
    }
    // Cleared again, it is recorded.
    expect((await clear("ada")).status).toBe(200);
    expect(auditsOf("computer.browser_cleared").at(-1)).toMatchObject({
      targetId: BOT,
      actorUserId: ada.id,
    });
    await handBack("ada", requestId);
  });
});

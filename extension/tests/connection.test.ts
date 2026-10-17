import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import {
  currentConnection,
  forgetConnection,
  handleConnectionMessage,
  handleExternalConnect,
  installConnection,
  offerDesktopConnection,
} from "../src/background/connection";
import type { RecorderPolicy } from "../src/shared/policy";
import {
  installIdFor,
  readLocal,
  readSession,
  writeLocal,
} from "../src/shared/storage";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";

type Exchange = { code: string; label: string; installId: string };
const user = { id: "u1", name: "Ada", email: "ada@example.test" };

let server: ReturnType<typeof Bun.serve>;
let origin = "";
const exchanges: Exchange[] = [];
const hits: string[] = [];
/** While set, a request to `path` reaches OpenBot (an exchange is recorded first), calls `arrived`, and has its answer
 * held until `released` resolves. */
let held: {
  path: string;
  arrived: () => void;
  released: Promise<void>;
} | null = null;
let releaseHeld = () => {};
async function holdIfAsked(path: string): Promise<void> {
  if (held?.path !== path) return;
  held.arrived();
  await held.released;
}
let meAnswer: { status: number; body: object } = {
  status: 200,
  body: { user, connectionId: "c1", capabilities: { transcription: true } },
};

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      hits.push(
        `${request.method} ${url.pathname} ${request.headers.get("authorization") ?? ""}`,
      );
      if (
        request.method === "POST" &&
        url.pathname === "/api/recorder/connections"
      ) {
        const body = (await request.json()) as Exchange;
        exchanges.push(body);
        await holdIfAsked(url.pathname);
        if (body.code === "obc_expired")
          return Response.json(
            { error: "That code has expired. Connect again from OpenBot." },
            { status: 400 },
          );
        return Response.json({
          token: "obr_fixture",
          connection: { id: "c1" },
          user,
        });
      }
      if (
        request.method === "DELETE" &&
        url.pathname === "/api/recorder/connections/current"
      ) {
        await holdIfAsked(url.pathname);
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/api/recorder/me") {
        await holdIfAsked(url.pathname);
        return Response.json(meAnswer.body, { status: meAnswer.status });
      }
      return new Response("nope", { status: 404 });
    },
  });
  origin = server.url.origin;
});
afterAll(() => server.stop(true));

let fake: ChromeFake;
let opened: string[];
let realNow: () => number;
let clock = 1_800_000_000_000;
let policy: RecorderPolicy;
let askDesktopCalls: number;
let removed: { tabId: number; pendingOrigin?: string; opened: number }[];

const openTab = async (url: string) => {
  opened.push(url);
  const id = 41 + opened.length - 1;
  fake.tabs.set(id, { id, url } as chrome.tabs.Tab);
  return id;
};
const deps = () => ({ openTab, readPolicy: async () => policy });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  fake = installChromeFake({ manifestVersion: "0.2.0" });
  opened = [];
  exchanges.length = 0;
  hits.length = 0;
  askDesktopCalls = 0;
  policy = {
    openbotUrl: null,
    openbotUrlInvalid: false,
    allowedIntelligenceUrls: null,
  };
  meAnswer = {
    status: 200,
    body: { user, connectionId: "c1", capabilities: { transcription: true } },
  };
  realNow = Date.now;
  clock = 1_800_000_000_000;
  Date.now = () => clock;
  removed = [];
  // The shared fake has no tabs.remove. This one closes the tab as Chrome does, and records what was pending and
  // how many tabs had been opened at that moment, so a test can tell what happened before the close.
  Object.assign(chrome.tabs, {
    remove: async (tabId: number) => {
      if (!fake.tabs.has(tabId)) throw new Error(`No tab with id: ${tabId}.`);
      const pending = fake.storage.session.get("pendingConnect") as
        | { origin: string }
        | undefined;
      removed.push({
        tabId,
        pendingOrigin: pending?.origin,
        opened: opened.length,
      });
      fake.tabs.delete(tabId);
    },
  });
});
afterEach(() => {
  releaseHeld();
  held = null;
  Date.now = realNow;
  Reflect.deleteProperty(chrome.tabs, "remove");
  fake.uninstall();
});

const connect = (code: string, from = origin) =>
  handleExternalConnect(
    { type: "openbot.connect", code },
    { origin: from },
    deps(),
  );

/** Holds OpenBot's answers to `path` until `release`; `arrived` resolves once a request to it has reached OpenBot. */
function holdAnswer(path: string): {
  arrived: Promise<void>;
  release: () => void;
} {
  const arrived = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  held = { path, arrived: arrived.resolve, released: released.promise };
  releaseHeld = released.resolve;
  return { arrived: arrived.promise, release: released.resolve };
}

test("a web connect is confirmed on the extension's own page and exchanged at the sender's origin", async () => {
  const answer = await connect("obc_abc");
  expect(answer).toEqual({
    ok: true,
    version: "0.2.0",
    installId: await installIdFor(origin),
    awaitingConfirmation: true,
  });
  expect(opened).toEqual([
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop/connect.html",
  ]);
  expect(
    await handleConnectionMessage({ type: "page.connect.pending" }),
  ).toEqual({
    ok: true,
    pending: { origin, via: "web" },
  });
  await handleConnectionMessage({
    type: "page.connect.decide",
    approve: true,
    label: "Chrome on macOS",
  });
  expect(exchanges).toEqual([
    {
      code: "obc_abc",
      label: "Chrome on macOS",
      installId: await installIdFor(origin),
    },
  ]);
  expect((await readLocal("connection"))?.token).toBe("obr_fixture");
  expect(await readSession("pendingConnect")).toBeUndefined();
});

test("an http origin that is not loopback is refused and nothing opens", async () => {
  expect(await connect("obc_a", "http://openbot.example.test")).toEqual({
    ok: false,
    error: "not-https",
  });
  expect(opened).toEqual([]);
  expect(await readSession("pendingConnect")).toBeUndefined();
});

test("a policy pinned to another origin refuses with pinned-elsewhere", async () => {
  policy = { ...policy, openbotUrl: "https://openbot.example.test" };
  expect(await connect("obc_a")).toEqual({
    ok: false,
    error: "pinned-elsewhere",
  });
  expect(opened).toEqual([]);
});

test("a second origin while one is pending is busy, until the person closes the first connect tab", async () => {
  expect((await connect("obc_a", "https://a.example.test")).ok).toBe(true);
  expect(await connect("obc_b", "https://b.example.test")).toEqual({
    ok: false,
    error: "busy",
  });
  expect(opened).toHaveLength(1);
  fake.tabs.delete(41);
  expect((await connect("obc_b", "https://b.example.test")).ok).toBe(true);
  expect(opened).toHaveLength(2);
  expect((await readSession("pendingConnect"))?.origin).toBe(
    "https://b.example.test",
  );
});

test("the same origin asking again reuses the open connect tab instead of opening another", async () => {
  await connect("obc_1");
  // Four asks fit Decision 22's limit of three per ten minutes only when spaced out.
  for (const code of ["obc_2", "obc_3", "obc_4"]) {
    clock += 4 * 60 * 1000;
    await connect(code);
  }
  expect(opened).toHaveLength(1);
  expect(fake.updated.map((u) => u.props)).toEqual([
    { active: true },
    { active: true },
    { active: true },
  ]);
  await handleConnectionMessage({
    type: "page.connect.decide",
    approve: true,
    label: "x",
  });
  expect(exchanges.map((e) => e.code)).toEqual(["obc_4"]);
});

test("a different origin replacing a stale pending connect closes its connect tab before anything else", async () => {
  expect((await connect("obc_a", "https://a.example.test")).ok).toBe(true);
  clock += 6 * 60 * 1000;
  expect((await connect("obc_b", "https://b.example.test")).ok).toBe(true);
  // A's tab shows A's origin but would exchange B's code at B, so it is closed while A is still the pending connect.
  expect(removed).toEqual([
    { tabId: 41, pendingOrigin: "https://a.example.test", opened: 1 },
  ]);
  expect(fake.tabs.has(41)).toBe(false);
  expect(opened).toHaveLength(2);
  expect(await readSession("pendingConnect")).toMatchObject({
    origin: "https://b.example.test",
    code: "obc_b",
    tabId: 42,
  });
});

test("the same origin asking again after five minutes still reuses its open connect tab", async () => {
  await connect("obc_1");
  clock += 6 * 60 * 1000;
  expect((await connect("obc_2")).ok).toBe(true);
  expect(opened).toHaveLength(1);
  expect(removed).toEqual([]);
  expect(fake.updated).toEqual([{ tabId: 41, props: { active: true } }]);
  expect(await readSession("pendingConnect")).toMatchObject({
    origin,
    code: "obc_2",
    requestedAt: clock,
    tabId: 41,
  });
});

test("an expired code shows the server's sentence and stores nothing", async () => {
  await connect("obc_expired");
  const answer = await handleConnectionMessage({
    type: "page.connect.decide",
    approve: true,
    label: "x",
  });
  expect(answer).toEqual({
    ok: false,
    error: "That code has expired. Connect again from OpenBot.",
  });
  expect(await readLocal("connection")).toBeUndefined();
});

test("an approve that cannot reach OpenBot shows a plain sentence, not the browser's error, and stores nothing", async () => {
  await connect("obc_abc");
  const unreachable = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(() => Promise.reject(new TypeError("Failed to fetch")), {
      preconnect: globalThis.fetch.preconnect,
    }),
  );
  try {
    expect(
      await handleConnectionMessage({
        type: "page.connect.decide",
        approve: true,
        label: "x",
      }),
    ).toEqual({ ok: false, error: "OpenBot did not answer. Try again." });
  } finally {
    unreachable.mockRestore();
  }
  expect(await readLocal("connection")).toBeUndefined();
  expect(await readSession("pendingConnect")).toMatchObject({
    origin,
    code: "obc_abc",
  });
});

test("disconnect tells OpenBot and forgets the token without a notice", async () => {
  await connect("obc_abc");
  await handleConnectionMessage({
    type: "page.connect.decide",
    approve: true,
    label: "x",
  });
  expect(await handleConnectionMessage({ type: "page.disconnect" })).toEqual({
    ok: true,
  });
  expect(hits).toContain(
    "DELETE /api/recorder/connections/current Bearer obr_fixture",
  );
  expect(await currentConnection()).toBeNull();
  expect(await readLocal("notice")).toBeUndefined();
});

test("a disconnect still telling OpenBot when a reconnect lands forgets only the connection it disconnected", async () => {
  await connected("obr_old");
  const deleting = holdAnswer("/api/recorder/connections/current");
  const disconnecting = handleConnectionMessage({ type: "page.disconnect" });
  await deleting.arrived;
  await connect("obc_abc");
  expect(
    await handleConnectionMessage({
      type: "page.connect.decide",
      approve: true,
      label: "x",
    }),
  ).toEqual({ ok: true });
  deleting.release();
  expect(await disconnecting).toEqual({ ok: true });
  expect(hits).toContain(
    "DELETE /api/recorder/connections/current Bearer obr_old",
  );
  expect((await currentConnection())?.token).toBe("obr_fixture");
  expect(await readLocal("notice")).toBeUndefined();
});

test("a forget told which token asked leaves a newer connection alone, and forgets the one that asked with a notice", async () => {
  await connected("obr_new");
  await forgetConnection("revoked", "obr_old");
  expect((await currentConnection())?.token).toBe("obr_new");
  expect(await readLocal("notice")).toBeUndefined();
  await forgetConnection("revoked", "obr_new");
  expect(await currentConnection()).toBeNull();
  expect(await readLocal("notice")).toEqual({
    kind: "signed-out",
    at: clock,
    reason: "revoked",
  });
});

test("forgetting a revoked connection leaves a signed-out notice with its reason", async () => {
  await connect("obc_abc");
  await handleConnectionMessage({
    type: "page.connect.decide",
    approve: true,
    label: "x",
  });
  await forgetConnection("organization");
  expect(await currentConnection()).toBeNull();
  expect(await readLocal("notice")).toEqual({
    kind: "signed-out",
    at: clock,
    reason: "organization",
  });
});

test("a new connection clears the signed-out notice", async () => {
  await writeLocal("notice", { kind: "signed-out", at: 1, reason: "revoked" });
  await connect("obc_abc");
  await handleConnectionMessage({
    type: "page.connect.decide",
    approve: true,
    label: "x",
  });
  expect(await readLocal("notice")).toBeUndefined();
});

test("rejecting clears the pending connect and exchanges nothing", async () => {
  await connect("obc_abc");
  await handleConnectionMessage({
    type: "page.connect.decide",
    approve: false,
    label: "x",
  });
  expect(
    await handleConnectionMessage({ type: "page.connect.pending" }),
  ).toEqual({ ok: true, pending: null });
  expect(exchanges).toEqual([]);
});

test("an approve still exchanging when another origin replaces the stale pending connect leaves the new one in place", async () => {
  const other = "https://b.example.test";
  await connect("obc_a");
  const exchange = holdAnswer("/api/recorder/connections");
  const approving = handleConnectionMessage({
    type: "page.connect.decide",
    approve: true,
    label: "x",
  });
  await exchange.arrived;
  clock += 6 * 60 * 1000;
  expect((await connect("obc_b", other)).ok).toBe(true);
  exchange.release();
  expect(await approving).toEqual({ ok: true });
  // The person approved this origin and OpenBot minted its token, so the connection stands...
  expect(exchanges.map((e) => e.code)).toEqual(["obc_a"]);
  expect(await readLocal("connection")).toMatchObject({
    openbotUrl: origin,
    token: "obr_fixture",
  });
  // ...and the other origin's connect tab still has its pending connect to show.
  expect(
    await handleConnectionMessage({ type: "page.connect.pending" }),
  ).toEqual({ ok: true, pending: { origin: other, via: "web" } });
  expect(await readSession("pendingConnect")).toMatchObject({
    code: "obc_b",
    tabId: 42,
  });
  expect(fake.tabs.has(42)).toBe(true);
});

test("a cancel that arrives while Desktop's handoff is being asked never clears Desktop's newer pending connect", async () => {
  await connect("obc_w", "https://a.example.test");
  const handoff = Promise.withResolvers<{ openbotUrl: string; code: string }>();
  const offering = offerDesktopConnection({
    askDesktop: () => handoff.promise,
    openTab,
    readPolicy: async () => policy,
  });
  const cancelling = handleConnectionMessage({
    type: "page.connect.decide",
    approve: false,
    label: "x",
  });
  await settle();
  handoff.resolve({ openbotUrl: "http://127.0.0.1:7470", code: "obc_d" });
  expect(await offering).toBe(true);
  expect(await cancelling).toEqual({ ok: true });
  // The cancel was for the web connect: Desktop's handoff replaced it (closing its tab), and the cancel leaves
  // Desktop's own pending connect and tab alone.
  expect(removed).toEqual([
    { tabId: 41, pendingOrigin: "https://a.example.test", opened: 1 },
  ]);
  expect(await readSession("pendingConnect")).toMatchObject({
    origin: "http://127.0.0.1:7470",
    via: "desktop",
    tabId: 42,
  });
  expect(fake.tabs.has(42)).toBe(true);
});

test("Desktop availability is a ping that mints nothing", async () => {
  expect(
    await handleConnectionMessage(
      { type: "page.desktop.available" },
      {
        desktopAvailable: async () => true,
        askDesktop: async () => {
          askDesktopCalls++;
          return null;
        },
      },
    ),
  ).toEqual({ ok: true, available: true });
  expect(askDesktopCalls).toBe(0);
});

test("Desktop's handoff opens the same confirm page with the Desktop wording", async () => {
  await offerDesktopConnection({
    askDesktop: async () => ({
      openbotUrl: "http://127.0.0.1:7470",
      code: "obc_d",
    }),
    openTab,
    readPolicy: async () => policy,
  });
  expect(
    await handleConnectionMessage({ type: "page.connect.pending" }),
  ).toEqual({
    ok: true,
    pending: { origin: "http://127.0.0.1:7470", via: "desktop" },
  });
  expect(opened).toHaveLength(1);
});

test("Desktop's handoff closes an open web connect tab before storing its own pending connect", async () => {
  await connect("obc_w", "https://a.example.test");
  await offerDesktopConnection({
    askDesktop: async () => ({
      openbotUrl: "http://127.0.0.1:7470",
      code: "obc_d",
    }),
    openTab,
    readPolicy: async () => policy,
  });
  expect(removed).toEqual([
    { tabId: 41, pendingOrigin: "https://a.example.test", opened: 1 },
  ]);
  expect(fake.tabs.has(41)).toBe(false);
  expect(await readSession("pendingConnect")).toMatchObject({
    origin: "http://127.0.0.1:7470",
    via: "desktop",
    tabId: 42,
  });
});

test("installing registers onInstalled and no message listener (the router owns those)", async () => {
  installConnection();
  const added = fake.calls.filter((call) => call.endsWith(".addListener"));
  expect(added).toContain("runtime.onInstalled.addListener");
  expect(added).toContain("alarms.onAlarm.addListener");
  for (const owned of [
    "runtime.onMessage.addListener",
    "runtime.onMessageExternal.addListener",
    "runtime.onConnect.addListener",
  ])
    expect(added).not.toContain(owned);
});

test("a fresh install creates its secret and offers the Desktop connection", async () => {
  installConnection({
    askDesktop: async () => ({
      openbotUrl: "http://127.0.0.1:7470",
      code: "obc_d",
    }),
    openTab,
    readPolicy: async () => policy,
  });
  fake.fireInstalled("install");
  await settle();
  expect(await readLocal("installSecret")).toBeTruthy();
  expect((await readSession("pendingConnect"))?.via).toBe("desktop");
});

test("the connect answer, the connected origin's ping and the exchange carry this copy's install id for that origin", async () => {
  const answer = await connect("obc_i");
  expect(answer).toMatchObject({
    ok: true,
    installId: await installIdFor(origin),
  });
  await handleConnectionMessage({
    type: "page.connect.decide",
    approve: true,
    label: "x",
  });
  expect(exchanges.at(-1)).toMatchObject({
    installId: await installIdFor(origin),
  });
  expect(
    await handleExternalConnect({ type: "openbot.ping" }, { origin }, deps()),
  ).toMatchObject({
    ok: true,
    installId: await installIdFor(origin),
  });
  expect(await installIdFor("https://other.example.test")).not.toBe(
    await installIdFor(origin),
  );
});

test("a policy whose address is unusable refuses with policy-invalid", async () => {
  policy = { ...policy, openbotUrlInvalid: true };
  expect(await connect("obc_a")).toEqual({
    ok: false,
    error: "policy-invalid",
  });
  expect(opened).toEqual([]);
});

test("a website that is not this copy's OpenBot learns nothing from a ping", async () => {
  const tracker = { origin: "https://tracker.example.test" };
  expect(
    await handleExternalConnect({ type: "openbot.ping" }, tracker, deps()),
  ).toEqual({ ok: true });
  expect(
    await handleExternalConnect({ type: "openbot.ping" }, { origin }, deps()),
  ).toEqual({ ok: true });
  await connect("obc_a");
  expect(
    await handleExternalConnect({ type: "openbot.ping" }, { origin }, deps()),
  ).toMatchObject({
    ok: true,
    version: "0.2.0",
  });
  expect(
    await handleExternalConnect({ type: "openbot.ping" }, tracker, deps()),
  ).toEqual({ ok: true });
  clock += 6 * 60 * 1000;
  expect(
    await handleExternalConnect({ type: "openbot.ping" }, { origin }, deps()),
  ).toEqual({ ok: true });
});

test("an origin that asks to connect over and over is told busy and opens nothing", async () => {
  await connect("obc_1");
  await connect("obc_2");
  await connect("obc_3");
  expect(await connect("obc_4")).toEqual({ ok: false, error: "busy" });
  expect(opened).toHaveLength(1);
  expect((await readSession("pendingConnect"))?.code).toBe("obc_3");
  clock += 10 * 60 * 1000 + 1;
  expect((await connect("obc_5")).ok).toBe(true);
});

test("ten connects in one tick from one origin open one tab, and the limit answers the other seven busy", async () => {
  const site = "https://a.example.test";
  const answers = await Promise.all(
    Array.from({ length: 10 }, (_, i) => connect(`obc_${i}`, site)),
  );
  const accepted = answers.flatMap((answer, i) =>
    answer.ok ? [`obc_${i}`] : [],
  );
  expect(accepted).toHaveLength(3);
  expect(answers.filter((answer) => !answer.ok)).toEqual(
    Array(7).fill({ ok: false, error: "busy" }),
  );
  expect(opened).toHaveLength(1);
  expect((await readSession("pendingConnect"))?.code).toBe(accepted[2]);
  expect((await readSession("connectRequests"))?.[site]).toHaveLength(3);
});

test("connects from two origins in one tick open one tab and answer the second busy", async () => {
  const sites = ["https://a.example.test", "https://b.example.test"];
  const answers = await Promise.all([
    connect("obc_a", sites[0]),
    connect("obc_b", sites[1]),
  ]);
  expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
  expect(answers.filter((answer) => !answer.ok)).toEqual([
    { ok: false, error: "busy" },
  ]);
  expect(opened).toHaveLength(1);
  expect(await readSession("pendingConnect")).toMatchObject({
    origin: answers[0].ok ? sites[0] : sites[1],
    tabId: 41,
  });
});

test("a web connect and Desktop's handoff at once leave one pending connect, shown in the only open connect tab", async () => {
  await Promise.all([
    connect("obc_w", "https://a.example.test"),
    offerDesktopConnection({
      askDesktop: async () => ({
        openbotUrl: "http://127.0.0.1:7470",
        code: "obc_d",
      }),
      openTab,
      readPolicy: async () => policy,
    }),
  ]);
  const pending = await readSession("pendingConnect");
  expect(pending).toMatchObject(
    pending?.via === "desktop"
      ? { origin: "http://127.0.0.1:7470", code: "obc_d" }
      : { origin: "https://a.example.test", code: "obc_w" },
  );
  const openConnectTabs = [...fake.tabs.values()]
    .filter((tab) => tab.url?.endsWith("/connect.html"))
    .map((tab) => tab.id);
  expect(openConnectTabs).toEqual([pending?.tabId]);
  // Any connect tab opened and then replaced was closed.
  expect(opened.length - removed.length).toBe(1);
});

test("a connect whose storage read fails rejects its caller, and the connect queued behind it still runs", async () => {
  const session = chrome.storage.session;
  const get = session.get;
  let failures = 1;
  Object.assign(session, {
    get: (...args: unknown[]) =>
      failures-- > 0
        ? Promise.reject(new Error("Storage is unavailable."))
        : Reflect.apply(get, session, args),
  });
  try {
    const failing = connect("obc_x");
    const next = connect("obc_y");
    await expect(failing).rejects.toThrow("Storage is unavailable.");
    expect((await next).ok).toBe(true);
  } finally {
    Object.assign(session, { get });
  }
  expect(opened).toHaveLength(1);
  expect((await readSession("pendingConnect"))?.code).toBe("obc_y");
});

test("the Desktop handoff respects a policy pinned elsewhere", async () => {
  const asking = {
    askDesktop: async () => {
      askDesktopCalls++;
      return { openbotUrl: "http://127.0.0.1:7470", code: "obc_d" };
    },
    openTab,
  };
  expect(
    await offerDesktopConnection({
      ...asking,
      readPolicy: async () => ({
        ...policy,
        openbotUrl: "https://openbot.example.test",
      }),
    }),
  ).toBe(false);
  expect(
    await offerDesktopConnection({
      ...asking,
      readPolicy: async () => ({ ...policy, openbotUrlInvalid: true }),
    }),
  ).toBe(false);
  expect(
    await offerDesktopConnection({
      ...asking,
      readPolicy: async () => ({
        ...policy,
        openbotUrl: "http://127.0.0.1:7999",
      }),
    }),
  ).toBe(false);
  expect(askDesktopCalls).toBe(1);
  expect(opened).toEqual([]);
  expect(await readSession("pendingConnect")).toBeUndefined();
});

test("Desktop's IPv6 loopback address is accepted", async () => {
  await offerDesktopConnection({
    askDesktop: async () => ({
      openbotUrl: "http://[::1]:7470",
      code: "obc_d",
    }),
    openTab,
    readPolicy: async () => policy,
  });
  expect(
    await handleConnectionMessage({ type: "page.connect.pending" }),
  ).toEqual({
    ok: true,
    pending: { origin: "http://[::1]:7470", via: "desktop" },
  });
});

async function connected(token = "obr_fixture") {
  await writeLocal("connection", {
    openbotUrl: origin,
    token,
    connectionId: "c1",
    user,
    via: "web",
    connectedAt: clock,
  });
}

test("the keep-alive uses the organization session twice a day and forgets only a signed-out connection", async () => {
  await connected();
  await writeLocal("lastKeepAliveAt", clock);
  installConnection();
  await settle();
  expect(fake.alarms.created.get("recorder-session-keepalive")).toEqual({
    periodInMinutes: 720,
  });
  expect(hits.filter((hit) => hit.includes("/me"))).toEqual([]);

  fake.alarms.fire("recorder-session-keepalive");
  await settle();
  expect(hits.filter((hit) => hit.includes("/me"))).toEqual([
    "GET /api/recorder/me Bearer obr_fixture",
  ]);
  expect(await readLocal("lastKeepAliveAt")).toBe(clock);

  clock += 1000;
  meAnswer = {
    status: 503,
    body: { error: "Try again.", code: "RECORDER_AUTHORITY_UNAVAILABLE" },
  };
  fake.alarms.fire("recorder-session-keepalive");
  await settle();
  expect(await currentConnection()).not.toBeNull();
  expect(await readLocal("lastKeepAliveAt")).toBe(clock - 1000);

  meAnswer = {
    status: 401,
    body: {
      error: "Signed out.",
      code: "RECORDER_SIGNED_OUT",
      reason: "organization",
    },
  };
  fake.alarms.fire("recorder-session-keepalive");
  await settle();
  expect(await currentConnection()).toBeNull();
  expect(await readLocal("notice")).toMatchObject({
    kind: "signed-out",
    reason: "organization",
  });
});

test("a service-worker start checks at once when the last check is over twelve hours old", async () => {
  await connected();
  await writeLocal("lastKeepAliveAt", clock - 13 * 60 * 60 * 1000);
  installConnection();
  await settle();
  expect(hits.filter((hit) => hit.includes("/me"))).toHaveLength(1);
  expect(await readLocal("lastKeepAliveAt")).toBe(clock);
});

test("a signed-out answer to a keep-alive sent with the old token leaves a reconnect's new connection alone", async () => {
  await connected("obr_old");
  await writeLocal("lastKeepAliveAt", clock);
  installConnection();
  await settle();
  const me = holdAnswer("/api/recorder/me");
  fake.alarms.fire("recorder-session-keepalive");
  await me.arrived;
  // Reconnecting this copy stores the new token and revokes the old one on OpenBot...
  await connect("obc_abc");
  expect(
    await handleConnectionMessage({
      type: "page.connect.decide",
      approve: true,
      label: "x",
    }),
  ).toEqual({ ok: true });
  // ...so the keep-alive still in flight with the old token comes back revoked.
  meAnswer = {
    status: 401,
    body: {
      error: "Signed out.",
      code: "RECORDER_SIGNED_OUT",
      reason: "revoked",
    },
  };
  me.release();
  await settle();
  expect(hits).toContain("GET /api/recorder/me Bearer obr_old");
  expect((await currentConnection())?.token).toBe("obr_fixture");
  expect(await readLocal("notice")).toBeUndefined();
});

test("a signed-out answer to a held keep-alive still forgets the connection that asked, with a notice", async () => {
  await connected();
  await writeLocal("lastKeepAliveAt", clock);
  installConnection();
  await settle();
  const me = holdAnswer("/api/recorder/me");
  fake.alarms.fire("recorder-session-keepalive");
  await me.arrived;
  meAnswer = {
    status: 401,
    body: {
      error: "Signed out.",
      code: "RECORDER_SIGNED_OUT",
      reason: "revoked",
    },
  };
  me.release();
  await settle();
  expect(await currentConnection()).toBeNull();
  expect(await readLocal("notice")).toEqual({
    kind: "signed-out",
    at: clock,
    reason: "revoked",
  });
});

const signedOut = (reason: "revoked" | "removed" | "organization") => ({
  status: 401,
  body: { error: "Signed out.", code: "RECORDER_SIGNED_OUT", reason },
});

test("a reconnect approved while a signed-out forget is removing the old connection waits for it, and stands", async () => {
  await connected("obr_old");
  await writeLocal("lastKeepAliveAt", clock);
  installConnection();
  await settle();
  await connect("obc_abc");
  const local = chrome.storage.local;
  const remove = local.remove;
  const reached = Promise.withResolvers<void>();
  const go = Promise.withResolvers<void>();
  Object.assign(local, {
    remove: async (keys: string | string[]) => {
      if ([keys].flat().includes("connection")) {
        reached.resolve();
        await go.promise;
      }
      return Reflect.apply(remove, local, [keys]);
    },
  });
  try {
    meAnswer = signedOut("revoked");
    fake.alarms.fire("recorder-session-keepalive");
    await reached.promise;
    // The forget has checked that the old connection is still stored and is removing it while the reconnect lands.
    const approving = handleConnectionMessage({
      type: "page.connect.decide",
      approve: true,
      label: "x",
    });
    await settle();
    expect(exchanges.map((e) => e.code)).toEqual(["obc_abc"]);
    go.resolve();
    expect(await approving).toEqual({ ok: true });
  } finally {
    go.resolve();
    Object.assign(local, { remove });
  }
  expect((await currentConnection())?.token).toBe("obr_fixture");
  expect(await readLocal("notice")).toBeUndefined();
});

test("a stale signed-out keep-alive answer after a deliberate Disconnect leaves no signed-out notice", async () => {
  await connected();
  await writeLocal("lastKeepAliveAt", clock);
  installConnection();
  await settle();
  const me = holdAnswer("/api/recorder/me");
  fake.alarms.fire("recorder-session-keepalive");
  await me.arrived;
  expect(await handleConnectionMessage({ type: "page.disconnect" })).toEqual({
    ok: true,
  });
  meAnswer = signedOut("revoked");
  me.release();
  await settle();
  expect(await currentConnection()).toBeNull();
  expect(await readLocal("notice")).toBeUndefined();
});

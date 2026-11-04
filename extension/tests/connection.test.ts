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
  type ConnectionLoss,
  connectThroughDesktop,
  currentConnection,
  forgetConnection,
  handleConnectionMessage,
  handleExternalConnect,
  installConnection,
  trustedConnectRule,
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
/** Another person on the same OpenBot: a code ending `_bea` is hers, and exchanges for her own token. */
const bea = { id: "u2", name: "Bea", email: "bea@example.test" };
/** What a site's server can answer an exchange with, in the Recorder's own Connect page if it were shown. */
const HOSTILE =
  "Your Recorder is out of date. Install the new one from https://evil.example.test/recorder.crx.";

let server: ReturnType<typeof Bun.serve>;
/**
 * The web OpenBot most tests connect: an https site, as a hosted OpenBot is. The Recorder takes a connect from OpenBot
 * Desktop's loopback address with no Connect page, so a site that keeps the Connect click is https; its requests reach
 * the fake OpenBot below through `fetch` (`reachWebOpenBot`), as a name the browser resolves would.
 */
const origin = "https://openbot.acme.test";
/** The fake OpenBot's own address on this computer, as OpenBot Desktop's local stack serves OpenBot. */
let loopback = "";
const realFetch = globalThis.fetch;
/** Sends what the Recorder asks of `origin` to the fake OpenBot, path and all, and everything else where it was going. */
function reachWebOpenBot(): void {
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return realFetch(
        url.origin === origin
          ? new URL(`${url.pathname}${url.search}`, loopback)
          : input,
        init,
      );
    },
    { preconnect: realFetch.preconnect },
  );
}
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
  body: { user, connectionId: "c1" },
};

/** The fake OpenBot, on 127.0.0.1 for every test and on [::1] for the one that needs it. */
async function openbot(request: Request): Promise<Response> {
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
      return Response.json({ error: HOSTILE }, { status: 400 });
    const refused = /^obc_refused_(\d{3})$/.exec(body.code);
    if (refused)
      return Response.json({ error: HOSTILE }, { status: Number(refused[1]) });
    if (body.code.endsWith("_bea"))
      return Response.json({
        token: "obr_bea",
        connection: { id: "c2" },
        user: bea,
      });
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
}

beforeAll(() => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: openbot });
  loopback = server.url.origin;
});
afterAll(() => server.stop(true));

let fake: ChromeFake;
let opened: string[];
let realNow: () => number;
let clock = 1_800_000_000_000;
let policy: RecorderPolicy;
let askDesktopCalls: number;
/** What was pending, and how many tabs had been opened, at each moment the fake closed a tab. */
let closedWhile: { pendingOrigin?: string; opened: number }[];

const openTab = async (url: string) => {
  opened.push(url);
  const id = 41 + opened.length - 1;
  fake.tabs.set(id, { id, url } as chrome.tabs.Tab);
  return id;
};
const deps = () => ({ openTab, readPolicy: async () => policy });
/** OpenBot Desktop's native host on this computer, answering `address` with `openbotUrl` (null: no OpenBot Desktop,
 * as when its host is not installed), as recorder_host.rs answers it. */
function desktopAnswers(openbotUrl: string | null): void {
  fake.native.reply = openbotUrl
    ? (message) =>
        (message as { type?: string }).type === "address"
          ? { ok: true, openbotUrl }
          : { ok: false, error: "unknown-message" }
    : null;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  reachWebOpenBot();
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
    body: { user, connectionId: "c1" },
  };
  realNow = Date.now;
  clock = 1_800_000_000_000;
  Date.now = () => clock;
  closedWhile = [];
  // So a test can tell what happened before a connect tab was closed.
  chrome.tabs.onRemoved.addListener(() => {
    const pending = fake.storage.session.get("pendingConnect") as
      | { origin: string }
      | undefined;
    closedWhile.push({ pendingOrigin: pending?.origin, opened: opened.length });
  });
});
afterEach(() => {
  releaseHeld();
  held = null;
  Date.now = realNow;
  globalThis.fetch = realFetch;
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
  expect(answer).toEqual({ ok: true, awaitingConfirmation: true });
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
    origin,
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
  for (const code of ["obc_2", "obc_3", "obc_4"]) {
    clock += 60 * 1000;
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
    origin,
  });
  expect(exchanges.map((e) => e.code)).toEqual(["obc_4"]);
});

test("a different origin replacing a stale pending connect closes its connect tab before anything else", async () => {
  expect((await connect("obc_a", "https://a.example.test")).ok).toBe(true);
  clock += 6 * 60 * 1000;
  expect((await connect("obc_b", "https://b.example.test")).ok).toBe(true);
  // A's tab shows A's origin but would exchange B's code at B, so it is closed while A is still the pending connect.
  expect(fake.removed).toEqual([41]);
  expect(closedWhile).toEqual([
    { pendingOrigin: "https://a.example.test", opened: 1 },
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
  expect(fake.removed).toEqual([]);
  expect(fake.updated).toEqual([{ tabId: 41, props: { active: true } }]);
  expect(await readSession("pendingConnect")).toMatchObject({
    origin,
    code: "obc_2",
    requestedAt: clock,
    tabId: 41,
  });
});

test("a code OpenBot refuses shows the Recorder's own sentence on the Connect page, never the text the site's server sent, and stores nothing", async () => {
  for (const [code, sentence] of [
    [
      "obc_expired",
      "This connect request has expired or was already used. Choose Connect this browser in OpenBot again.",
    ],
    [
      "obc_refused_403",
      "This OpenBot does not accept this copy of the Recorder. Ask whoever runs it to add it.",
    ],
    [
      "obc_refused_429",
      "OpenBot is taking too many connect requests just now. Try again in a few minutes.",
    ],
    ["obc_refused_500", "OpenBot could not connect this browser. Try again."],
    ["obc_refused_418", "OpenBot could not connect this browser. Try again."],
  ] as const) {
    clock += 30 * 1000;
    await connect(code);
    const answer = await handleConnectionMessage({
      type: "page.connect.decide",
      approve: true,
      label: "x",
      origin,
    });
    expect(answer).toEqual({ ok: false, error: sentence });
    expect(JSON.stringify(answer)).not.toContain("evil");
  }
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
        origin,
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
    origin,
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
      origin,
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

test("a forget answers whether it forgot a connection", async () => {
  // Nothing stored: a forget told which token asked forgets nothing, and neither does one told nothing.
  expect(await forgetConnection("revoked", "obr_old")).toBe(false);
  expect(await forgetConnection("revoked")).toBe(false);
  await connected("obr_new");
  expect(await forgetConnection("revoked", "obr_old")).toBe(false);
  expect((await currentConnection())?.token).toBe("obr_new");
  expect(await forgetConnection("revoked", "obr_new")).toBe(true);
  expect(await currentConnection()).toBeNull();
  await connected("obr_newer");
  expect(await forgetConnection("revoked")).toBe(true);
  expect(await currentConnection()).toBeNull();
});

test("forgetting a revoked connection leaves a signed-out notice with its reason", async () => {
  await connect("obc_abc");
  await handleConnectionMessage({
    type: "page.connect.decide",
    approve: true,
    label: "x",
    origin,
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
    origin,
  });
  expect(await readLocal("notice")).toBeUndefined();
});

test("rejecting clears the pending connect and exchanges nothing", async () => {
  await connect("obc_abc");
  await handleConnectionMessage({
    type: "page.connect.decide",
    approve: false,
    label: "x",
    origin,
  });
  expect(
    await handleConnectionMessage({ type: "page.connect.pending" }),
  ).toEqual({ ok: true, pending: null });
  expect(exchanges).toEqual([]);
});

const connectStatus = (from = origin) =>
  handleExternalConnect(
    { type: "openbot.connect.status" },
    { origin: from },
    deps(),
  );

test("the page that asked to connect hears at once that the person cancelled on the Connect page, or closed it, and no other site hears anything", async () => {
  // After a Cancel on the Connect page, OpenBot's Settings used to go on saying "Confirm in the OpenBot Recorder tab that
  // opened." for up to five minutes, as nothing told it the person had cancelled.
  expect(await connectStatus()).toEqual({ ok: true, connect: "none" });
  await connect("obc_abc");
  expect(await connectStatus()).toEqual({ ok: true, connect: "waiting" });
  // Another site learns nothing of this one's request.
  expect(await connectStatus("https://other.example.test")).toEqual({
    ok: true,
    connect: "none",
  });
  await handleConnectionMessage({
    type: "page.connect.decide",
    approve: false,
    label: "x",
    origin,
  });
  expect(await connectStatus()).toEqual({ ok: true, connect: "cancelled" });
  expect(await connectStatus("https://other.example.test")).toEqual({
    ok: true,
    connect: "none",
  });

  // Asked again, it waits again; the person closes the Connect tab without choosing.
  await connect("obc_def");
  expect(await connectStatus()).toEqual({ ok: true, connect: "waiting" });
  await chrome.tabs.remove(42);
  expect(await connectStatus()).toEqual({ ok: true, connect: "closed" });

  // Asked again and approved: nothing waits, and the ping says connected.
  await connect("obc_ghi");
  await handleConnectionMessage({
    type: "page.connect.decide",
    approve: true,
    label: "x",
    origin,
  });
  expect(await connectStatus()).toEqual({ ok: true, connect: "none" });
  expect(exchanges.map((exchange) => exchange.code)).toEqual(["obc_ghi"]);
});

test("a Cancel is said only while a page could still be waiting on it: not after the five minutes, nor once that OpenBot connected another way", async () => {
  const cancel = async () => {
    await connect(`obc_${clock}`);
    await handleConnectionMessage({
      type: "page.connect.decide",
      approve: false,
      label: "x",
      origin,
    });
    expect(await connectStatus()).toEqual({ ok: true, connect: "cancelled" });
  };
  // Five minutes on, nothing waits on it any more.
  await cancel();
  clock += 5 * 60 * 1000;
  expect(await connectStatus()).toEqual({ ok: true, connect: "none" });
  expect(await readSession("cancelledConnect")).toBeUndefined();

  // Cancelled on the Connect page, then connected as the organization's own OpenBot, with no Connect page.
  clock += 60 * 1000;
  await cancel();
  policy = { ...policy, openbotUrl: origin };
  expect(await connect("obc_pinned")).toMatchObject({
    ok: true,
    connected: true,
  });
  expect(await connectStatus()).toEqual({ ok: true, connect: "none" });
});

const OUT_OF_DATE =
  "This page is out of date. Close it and choose Connect this browser in OpenBot again.";

test("a decide naming a site other than the pending one is refused, stores nothing, and keeps the pending connect", async () => {
  await connect("obc_abc");
  for (const approve of [true, false])
    expect(
      await handleConnectionMessage({
        type: "page.connect.decide",
        approve,
        label: "x",
        origin: "https://other.example.test",
      }),
    ).toEqual({ ok: false, error: OUT_OF_DATE });
  expect(exchanges).toEqual([]);
  expect(await readLocal("connection")).toBeUndefined();
  expect(await readSession("pendingConnect")).toMatchObject({
    origin,
    code: "obc_abc",
  });
  // The tab that shows the pending site still connects it.
  expect(
    await handleConnectionMessage({
      type: "page.connect.decide",
      approve: true,
      label: "x",
      origin,
    }),
  ).toEqual({ ok: true });
  expect(exchanges.map((e) => e.code)).toEqual(["obc_abc"]);
  expect((await readLocal("connection"))?.openbotUrl).toBe(origin);
});

test("a connect tab Chrome failed to close cannot connect the site that replaced its pending connect", async () => {
  expect((await connect("obc_a", "https://a.example.test")).ok).toBe(true);
  const remove = spyOn(chrome.tabs, "remove").mockImplementation(() =>
    Promise.reject(
      new Error(
        "Tabs cannot be edited right now (user may be dragging a tab).",
      ),
    ),
  );
  try {
    clock += 6 * 60 * 1000;
    expect((await connect("obc_b")).ok).toBe(true);
  } finally {
    remove.mockRestore();
  }
  // A's tab is still open, showing A, while B is pending.
  expect(fake.tabs.has(41)).toBe(true);
  expect(
    await handleConnectionMessage({
      type: "page.connect.decide",
      approve: true,
      label: "x",
      origin: "https://a.example.test",
    }),
  ).toEqual({ ok: false, error: OUT_OF_DATE });
  expect(exchanges).toEqual([]);
  expect(await readLocal("connection")).toBeUndefined();
  expect(await readSession("pendingConnect")).toMatchObject({
    origin,
    code: "obc_b",
    tabId: 42,
  });
});

test("an approve still exchanging when another origin replaces the stale pending connect leaves the new one in place", async () => {
  const other = "https://b.example.test";
  await connect("obc_a");
  const exchange = holdAnswer("/api/recorder/connections");
  const approving = handleConnectionMessage({
    type: "page.connect.decide",
    approve: true,
    label: "x",
    origin,
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
  // ...and the other origin's connect tab still has its pending connect to show, which would now replace this one.
  expect(
    await handleConnectionMessage({ type: "page.connect.pending" }),
  ).toEqual({
    ok: true,
    pending: { origin: other, via: "web" },
    replaces: { origin, email: user.email },
  });
  expect(await readSession("pendingConnect")).toMatchObject({
    code: "obc_b",
    tabId: 42,
  });
  expect(fake.tabs.has(42)).toBe(true);
});

test("a web Connect's cancel that waited behind Desktop's connect leaves the connection Desktop made alone", async () => {
  await connect("obc_w", "https://a.example.test");
  const handoff = Promise.withResolvers<{ openbotUrl: string; code: string }>();
  const connecting = connectThroughDesktop({
    askDesktop: () => handoff.promise,
    openTab,
    readPolicy: async () => policy,
  });
  const cancelling = handleConnectionMessage({
    type: "page.connect.decide",
    approve: false,
    label: "x",
    origin: "https://a.example.test",
  });
  await settle();
  handoff.resolve({ openbotUrl: loopback, code: "obc_d" });
  expect(await connecting).toEqual({ connected: true });
  expect(await cancelling).toEqual({ ok: true });
  // Desktop connected this browser and closed the web Connect tab; the cancel, for the web connect, changes nothing.
  expect(fake.removed).toEqual([41]);
  expect(await readSession("pendingConnect")).toBeUndefined();
  expect(await currentConnection()).toMatchObject({
    openbotUrl: loopback,
    token: "obr_fixture",
    via: "desktop",
  });
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

test("Desktop's code connects this browser at once, with no Connect page, as an approved Connect connects it", async () => {
  // The Recorder the person's own Chrome installed from the store connects through OpenBot Desktop with nothing to click.
  const answer = await connectThroughDesktop({
    askDesktop: async () => ({ openbotUrl: loopback, code: "obc_d" }),
    openTab,
    readPolicy: async () => policy,
  });
  expect(answer).toEqual({ connected: true });
  expect(opened).toEqual([]);
  expect(await readSession("pendingConnect")).toBeUndefined();
  // Exchanged at OpenBot Desktop's OpenBot, under this copy's install id for it and the browser's own name.
  expect(exchanges).toEqual([
    {
      code: "obc_d",
      label: expect.stringContaining(" on "),
      installId: await installIdFor(loopback),
    },
  ]);
  expect(await currentConnection()).toEqual({
    openbotUrl: loopback,
    token: "obr_fixture",
    connectionId: "c1",
    user,
    via: "desktop",
    connectedAt: clock,
  });
});

/** The browser's own navigator for the length of `work`: its client hints, or none, and its user agent. */
async function asBrowser(
  browser: {
    userAgentData?: { brands: { brand: string }[]; platform: string };
    userAgent?: string;
  },
  work: () => Promise<void>,
): Promise<void> {
  const keys = ["userAgentData", "userAgent", "platform"] as const;
  const own = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(navigator, key)]),
  );
  Object.defineProperty(navigator, "userAgentData", {
    value: browser.userAgentData,
    configurable: true,
  });
  Object.defineProperty(navigator, "platform", {
    value: "MacIntel",
    configurable: true,
  });
  if (browser.userAgent)
    Object.defineProperty(navigator, "userAgent", {
      value: browser.userAgent,
      configurable: true,
    });
  try {
    await work();
  } finally {
    for (const [key, descriptor] of own)
      if (descriptor) Object.defineProperty(navigator, key, descriptor);
      else Reflect.deleteProperty(navigator, key);
  }
}

test("a connection OpenBot Desktop makes is named for the browser it is in, Edge as Edge and Chrome as Chrome, as OpenBot tells them apart", async () => {
  const desktopConnect = () =>
    connectThroughDesktop({
      askDesktop: async () => ({ openbotUrl: loopback, code: "obc_d" }),
      openTab,
      readPolicy: async () => policy,
    });
  // Microsoft Edge's client hints, as its service worker has them.
  await asBrowser(
    {
      userAgentData: {
        brands: [
          { brand: "Microsoft Edge" },
          { brand: "Chromium" },
          { brand: "Not=A?Brand" },
        ],
        platform: "macOS",
      },
    },
    async () => {
      expect(await desktopConnect()).toEqual({ connected: true });
    },
  );
  // Google Chrome's.
  await asBrowser(
    {
      userAgentData: {
        brands: [
          { brand: "Not_A Brand" },
          { brand: "Chromium" },
          { brand: "Google Chrome" },
        ],
        platform: "Windows",
      },
    },
    async () => {
      expect(await desktopConnect()).toEqual({ connected: true });
    },
  );
  // An Edge that gives no client hints is still named Edge, from its user agent.
  await asBrowser(
    {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0",
    },
    async () => {
      expect(await desktopConnect()).toEqual({ connected: true });
    },
  );
  expect(exchanges.map((exchange) => exchange.label)).toEqual([
    "Microsoft Edge on macOS",
    "Google Chrome on Windows",
    "Microsoft Edge on MacIntel",
  ]);
});

test("Desktop's connect closes an open web Connect tab, so approving that page cannot replace Desktop's connection", async () => {
  await connect("obc_w", "https://a.example.test");
  await connectThroughDesktop({
    askDesktop: async () => ({ openbotUrl: loopback, code: "obc_d" }),
    openTab,
    readPolicy: async () => policy,
  });
  expect(fake.removed).toEqual([41]);
  expect(fake.tabs.has(41)).toBe(false);
  expect(await readSession("pendingConnect")).toBeUndefined();
  expect((await currentConnection())?.via).toBe("desktop");
  expect(opened).toHaveLength(1);
});

test("a connection Desktop makes clears the signed-out notice, as an approved Connect does", async () => {
  await writeLocal("notice", {
    kind: "signed-out",
    at: clock,
    reason: "revoked",
  });
  await connectThroughDesktop({
    askDesktop: async () => ({ openbotUrl: loopback, code: "obc_d" }),
    openTab,
    readPolicy: async () => policy,
  });
  expect(await readLocal("notice")).toBeUndefined();
});

test("a code OpenBot refuses, or an OpenBot that does not answer, stores nothing and says why", async () => {
  expect(
    await connectThroughDesktop({
      askDesktop: async () => ({ openbotUrl: loopback, code: "obc_expired" }),
      openTab,
      readPolicy: async () => policy,
    }),
  ).toEqual({ connected: false, reason: "exchange-refused" });
  // Nothing listens on this port: OpenBot Desktop named an OpenBot that is not running.
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: openbot });
  const gone = closed.url.origin;
  await closed.stop(true);
  expect(
    await connectThroughDesktop({
      askDesktop: async () => ({ openbotUrl: gone, code: "obc_d" }),
      openTab,
      readPolicy: async () => policy,
    }),
  ).toEqual({ connected: false, reason: "openbot-unreachable" });
  expect(await currentConnection()).toBeNull();
  expect(opened).toEqual([]);
  expect(await readSession("pendingConnect")).toBeUndefined();
});

test("a pin elsewhere that lands while Desktop's code is exchanged keeps the connection out and revokes its new token", async () => {
  const exchange = holdAnswer("/api/recorder/connections");
  const connecting = connectThroughDesktop({
    askDesktop: async () => ({ openbotUrl: loopback, code: "obc_d" }),
    openTab,
    readPolicy: async () => policy,
  });
  await exchange.arrived;
  policy = { ...policy, openbotUrl: "https://moved.example.test" };
  exchange.release();
  expect(await connecting).toEqual({
    connected: false,
    reason: "pinned-elsewhere",
  });
  expect(await currentConnection()).toBeNull();
  expect(hits).toContain(
    "DELETE /api/recorder/connections/current Bearer obr_fixture",
  );
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

test("a fresh install creates its secret and connects through OpenBot Desktop with nothing to click, followed up as an approved Connect is", async () => {
  const followedUp: string[] = [];
  installConnection({
    askDesktop: async () => ({ openbotUrl: loopback, code: "obc_d" }),
    openTab,
    readPolicy: async () => policy,
    connected: async () => {
      followedUp.push((await currentConnection())?.token ?? "none");
    },
  });
  fake.fireInstalled("install");
  await settle();
  expect(await readLocal("installSecret")).toBeTruthy();
  expect(await currentConnection()).toMatchObject({ via: "desktop" });
  expect(opened).toEqual([]);
  expect(await readSession("pendingConnect")).toBeUndefined();
  // The recording controller hears of it once it is stored, as it hears of an approved Connect.
  expect(followedUp).toEqual(["obr_fixture"]);
});

test("an install with no OpenBot Desktop to answer connects nothing and opens nothing", async () => {
  const followedUp: string[] = [];
  installConnection({
    askDesktop: async () => ({ error: "no-answer" }),
    openTab,
    readPolicy: async () => policy,
    connected: async () => {
      followedUp.push("connected");
    },
  });
  fake.fireInstalled("install");
  await settle();
  expect(await currentConnection()).toBeNull();
  expect(opened).toEqual([]);
  expect(followedUp).toEqual([]);
});

test("the exchange and the connected origin's ping carry this copy's install id for that origin, and the connect answer before the person approves carries none", async () => {
  // Any site can ask to connect: until the person approves it, its answer says nothing of this copy. The install id is
  // stable for this copy and that origin, so a site that only asked would otherwise know this browser again.
  expect(await connect("obc_i")).toEqual({
    ok: true,
    awaitingConfirmation: true,
  });
  await handleConnectionMessage({
    type: "page.connect.decide",
    approve: true,
    label: "x",
    origin,
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

test("a website that is not this copy's OpenBot learns nothing from a ping, a site with a connect waiting for the person included, until it is connected", async () => {
  const tracker = { origin: "https://tracker.example.test" };
  const ping = (from: { origin: string }) =>
    handleExternalConnect({ type: "openbot.ping" }, from, deps());
  expect(await ping(tracker)).toEqual({ ok: true });
  expect(await ping({ origin })).toEqual({ ok: true });
  // A site that asked to connect is still any site until the person approves it.
  await connect("obc_a", tracker.origin);
  expect(await ping(tracker)).toEqual({ ok: true });
  // The person closes the tracker's Connect page; OpenBot asks.
  fake.tabs.delete(41);
  await connect("obc_b");
  expect(await ping({ origin })).toEqual({ ok: true });
  clock += 6 * 60 * 1000;
  expect(await ping({ origin })).toEqual({ ok: true });
  await handleConnectionMessage({
    type: "page.connect.decide",
    approve: true,
    label: "x",
    origin,
  });
  expect(await ping({ origin })).toEqual({
    ok: true,
    version: "0.2.0",
    installId: await installIdFor(origin),
  });
  expect(await ping(tracker)).toEqual({ ok: true });
});

test("an ordinary run of connects (connect, connect again, again after Disconnect, again after a revoke, and a couple of retries) is never refused", async () => {
  for (let i = 1; i <= 6; i++) {
    clock += 30 * 1000;
    expect((await connect(`obc_${i}`)).ok).toBe(true);
  }
  expect(opened).toHaveLength(1);
});

test("an origin that asks to connect over and over is throttled with the time left, opens nothing more, and may ask again once that time is up", async () => {
  for (let i = 1; i <= 10; i++) {
    expect((await connect(`obc_${i}`)).ok).toBe(true);
    clock += 30 * 1000;
  }
  // The first of the ten leaves the ten-minute window five minutes from now.
  expect(await connect("obc_11")).toEqual({
    ok: false,
    error: "throttled",
    retryAfterMs: 5 * 60 * 1000,
  });
  expect(opened).toHaveLength(1);
  expect((await readSession("pendingConnect"))?.code).toBe("obc_10");
  clock += 5 * 60 * 1000 - 1;
  expect(await connect("obc_12")).toEqual({
    ok: false,
    error: "throttled",
    retryAfterMs: 1,
  });
  clock += 1;
  expect((await connect("obc_13")).ok).toBe(true);
});

test("a loopback page asking to connect over and over starts OpenBot Desktop's native host no more often than the limit lets it connect", async () => {
  // Asking OpenBot Desktop for its address starts its native host, which looks for OpenBot's port with lsof or netstat.
  // The request was counted only after that, so any page on a loopback port could have it started as often as it liked.
  desktopAnswers("http://127.0.0.1:3010");
  const asked = () =>
    fake.native.sent.filter(
      (message) => (message as { type?: string }).type === "address",
    ).length;
  for (let i = 1; i <= 10; i++) {
    expect((await connect(`obc_${i}`, loopback)).ok).toBe(true);
    clock += 1_000;
  }
  expect(asked()).toBe(10);
  for (let i = 11; i <= 30; i++)
    expect(await connect(`obc_${i}`, loopback)).toMatchObject({
      ok: false,
      error: "throttled",
    });
  expect(asked()).toBe(10);
});

test("twelve connects in one tick from one origin open one tab, and the limit throttles the other two", async () => {
  const site = "https://a.example.test";
  const answers = await Promise.all(
    Array.from({ length: 12 }, (_, i) => connect(`obc_${i}`, site)),
  );
  const accepted = answers.flatMap((answer, i) =>
    answer.ok ? [`obc_${i}`] : [],
  );
  expect(accepted).toHaveLength(10);
  expect(answers.filter((answer) => !answer.ok)).toEqual(
    Array(2).fill({
      ok: false,
      error: "throttled",
      retryAfterMs: 10 * 60 * 1000,
    }),
  );
  expect(opened).toHaveLength(1);
  expect((await readSession("pendingConnect"))?.code).toBe(accepted[9]);
  expect((await readSession("connectRequests"))?.[site]).toHaveLength(10);
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

test("a web connect and Desktop's connect at once leave Desktop's connection, and a Connect tab only while a web connect is pending", async () => {
  await Promise.all([
    connect("obc_w", "https://a.example.test"),
    connectThroughDesktop({
      askDesktop: async () => ({ openbotUrl: loopback, code: "obc_d" }),
      openTab,
      readPolicy: async () => policy,
    }),
  ]);
  expect((await currentConnection())?.via).toBe("desktop");
  const pending = await readSession("pendingConnect");
  const openConnectTabs = [...fake.tabs.values()]
    .filter((tab) => tab.url?.endsWith("/connect.html"))
    .map((tab) => tab.id);
  // A web connect asked after Desktop connected waits on its page; one asked before was closed by Desktop's.
  expect(openConnectTabs).toEqual(pending ? [pending.tabId] : []);
  if (pending) expect(pending.origin).toBe("https://a.example.test");
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
    await connectThroughDesktop({
      ...asking,
      readPolicy: async () => ({
        ...policy,
        openbotUrl: "https://openbot.example.test",
      }),
    }),
  ).toEqual({ connected: false, reason: "pinned-elsewhere" });
  expect(
    await connectThroughDesktop({
      ...asking,
      readPolicy: async () => ({ ...policy, openbotUrlInvalid: true }),
    }),
  ).toEqual({ connected: false, reason: "policy-invalid" });
  expect(
    await connectThroughDesktop({
      ...asking,
      readPolicy: async () => ({
        ...policy,
        openbotUrl: "http://127.0.0.1:7999",
      }),
    }),
  ).toEqual({ connected: false, reason: "pinned-elsewhere" });
  expect(askDesktopCalls).toBe(1);
  expect(opened).toEqual([]);
  expect(exchanges).toEqual([]);
  expect(await currentConnection()).toBeNull();
});

test("Desktop's refusal reaches the popup as its code, after a good ping too, and opens nothing", async () => {
  for (const [reply, reason] of [
    [{ error: "not-signed-in" }, "not-signed-in"],
    [{ error: "not-running" }, "not-running"],
    [null, "no-answer"],
  ] as const) {
    expect(
      await handleConnectionMessage(
        { type: "page.connect.desktop" },
        {
          askDesktop: async () => reply,
          desktopAvailable: async () => true,
          openTab,
          readPolicy: async () => policy,
        },
      ),
    ).toEqual({ ok: true, connected: false, reason });
  }
  expect(
    await connectThroughDesktop({
      askDesktop: async () => ({ openbotUrl: "not a url", code: "obc_d" }),
      openTab,
      readPolicy: async () => policy,
    }),
  ).toEqual({ connected: false, reason: "invalid-address" });
  expect(opened).toEqual([]);
  expect(exchanges).toEqual([]);
  expect(await currentConnection()).toBeNull();
});

test("Desktop's IPv6 loopback address is accepted", async () => {
  const ipv6 = Bun.serve({ hostname: "::1", port: 0, fetch: openbot });
  try {
    const address = `http://[::1]:${ipv6.port}`;
    expect(
      await connectThroughDesktop({
        askDesktop: async () => ({ openbotUrl: address, code: "obc_d" }),
        openTab,
        readPolicy: async () => policy,
      }),
    ).toEqual({ connected: true });
    expect((await currentConnection())?.openbotUrl).toBe(address);
  } finally {
    await ipv6.stop(true);
  }
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
      origin,
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
      origin,
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

test("a keep-alive's signed-out answer goes to the recording controller with the connection that asked", async () => {
  await connected();
  await writeLocal("lastKeepAliveAt", clock);
  const lost: ConnectionLoss[] = [];
  installConnection({
    connectionLost: async (loss) => {
      lost.push(loss);
    },
  });
  await settle();
  meAnswer = signedOut("organization");
  fake.alarms.fire("recorder-session-keepalive");
  await settle();
  expect(lost).toEqual([
    {
      kind: "signed-out",
      reason: "organization",
      connection: expect.objectContaining({ token: "obr_fixture" }),
    },
  ]);
});

test("a policy that moves the Recorder away tells the recording controller, then revokes the old token", async () => {
  await connected();
  await writeLocal("lastKeepAliveAt", clock);
  const lost: ConnectionLoss[] = [];
  installConnection({
    readPolicy: async () => policy,
    connectionLost: async (loss) => {
      lost.push(loss);
      // The token is still live at OpenBot while the controller stops what used it.
      expect(hits.some((hit) => hit.startsWith("DELETE"))).toBe(false);
    },
  });
  await settle();
  policy = { ...policy, openbotUrl: "https://moved.example.test" };
  fake.storage.setManaged({ OpenBotUrl: "https://moved.example.test" });
  await settle();
  expect(await currentConnection()).toBeNull();
  expect(lost).toEqual([
    {
      kind: "policy",
      connection: expect.objectContaining({ token: "obr_fixture" }),
    },
  ]);
  expect(hits).toContain(
    "DELETE /api/recorder/connections/current Bearer obr_fixture",
  );
});

test("a connect page opened before a pin elsewhere cannot connect once the policy moved", async () => {
  await connect("obc_abc");
  policy = { ...policy, openbotUrl: "https://moved.example.test" };
  expect(
    await handleConnectionMessage(
      {
        type: "page.connect.decide",
        approve: true,
        label: "Chrome on macOS",
        origin,
      },
      deps(),
    ),
  ).toEqual({
    ok: false,
    error:
      "Your organization's Recorder policy does not allow this OpenBot. Ask your IT team.",
  });
  expect(exchanges).toEqual([]);
  expect(await currentConnection()).toBeNull();
  expect(await readSession("pendingConnect")).toBeUndefined();
});

test("a pin elsewhere that lands while the code is exchanged keeps the connection out and revokes its new token", async () => {
  await connect("obc_abc");
  const exchange = holdAnswer("/api/recorder/connections");
  const approving = handleConnectionMessage(
    {
      type: "page.connect.decide",
      approve: true,
      label: "Chrome on macOS",
      origin,
    },
    deps(),
  );
  await exchange.arrived;
  policy = { ...policy, openbotUrlInvalid: true };
  exchange.release();
  expect(await approving).toMatchObject({ ok: false });
  expect(await currentConnection()).toBeNull();
  expect(hits).toContain(
    "DELETE /api/recorder/connections/current Bearer obr_fixture",
  );
});

// ---- Trusted OpenBots: no Connect page (shared/recorder-page.ts TrustedConnectRule) ----------

test("only the organization's pinned OpenBot and the exact address OpenBot Desktop confirms are trusted to connect with no Connect page", () => {
  const none = { ...policy };
  const pinned = (openbotUrl: string) => ({ ...policy, openbotUrl });
  const desktop = "http://127.0.0.1:3010";
  for (const [rules, address, confirmed, rule] of [
    [none, desktop, desktop, "loopback-desktop"],
    [none, "http://[::1]:3010", "http://[::1]:3010", "loopback-desktop"],
    // Any other program can serve a page on a loopback port: one OpenBot Desktop did not confirm keeps the click.
    [none, desktop, null, null],
    [none, "http://127.0.0.1:8888", desktop, null],
    [none, "http://[::1]:3010", desktop, null],
    [none, desktop, "http://[::1]:3010", null],
    [none, "https://openbot.acme.test", desktop, null],
    // https on a loopback IP is not OpenBot Desktop's local stack, which serves plain http.
    [none, "https://127.0.0.1:3010", "https://127.0.0.1:3010", null],
    [none, "http://localhost:3010", "http://localhost:3010", null],
    [none, "http://openbot.acme.test", desktop, null],
    [none, "null", desktop, null],
    [
      pinned("https://openbot.acme.test"),
      "https://openbot.acme.test",
      null,
      "policy-pinned",
    ],
    [
      pinned("https://openbot.acme.test"),
      "https://other.acme.test",
      null,
      null,
    ],
    // A pin elsewhere keeps even OpenBot Desktop's address out.
    [pinned("https://openbot.acme.test"), desktop, desktop, null],
    [pinned(desktop), desktop, null, "policy-pinned"],
    [{ ...policy, openbotUrlInvalid: true }, desktop, desktop, null],
  ] as const)
    expect(trustedConnectRule(rules, address, confirmed)).toBe(rule);
});

test("OpenBot Desktop's own page on its loopback address connects with no Connect page, as an approved Connect connects", async () => {
  desktopAnswers(loopback);
  await writeLocal("notice", { kind: "signed-out", at: 1, reason: "revoked" });
  const answer = await connect("obc_desktop_page", loopback);
  expect(answer).toEqual({
    ok: true,
    version: "0.2.0",
    installId: await installIdFor(loopback),
    connected: true,
  });
  expect(opened).toEqual([]);
  expect(await readSession("pendingConnect")).toBeUndefined();
  // OpenBot Desktop's native host confirmed this address; nothing was minted to confirm it.
  expect(fake.native.sent).toEqual([{ type: "address" }]);
  // Exchanged at the origin Chrome reported, under this copy's install id for it and the browser's own name.
  expect(exchanges).toEqual([
    {
      code: "obc_desktop_page",
      label: expect.stringContaining(" on "),
      installId: await installIdFor(loopback),
    },
  ]);
  expect(await currentConnection()).toEqual({
    openbotUrl: loopback,
    token: "obr_fixture",
    connectionId: "c1",
    user,
    via: "web",
    connectedAt: clock,
  });
  expect(await readLocal("notice")).toBeUndefined();
  // The connected origin's ping now carries its version and install id.
  expect(
    await handleExternalConnect(
      { type: "openbot.ping" },
      { origin: loopback },
      deps(),
    ),
  ).toMatchObject({ ok: true, version: "0.2.0" });
});

test("the OpenBot the organization's policy pins connects with no Connect page", async () => {
  policy = { ...policy, openbotUrl: origin };
  expect(await connect("obc_pinned")).toEqual({
    ok: true,
    version: "0.2.0",
    installId: await installIdFor(origin),
    connected: true,
  });
  expect(opened).toEqual([]);
  expect(exchanges.map((exchange) => exchange.code)).toEqual(["obc_pinned"]);
  expect(await currentConnection()).toMatchObject({
    openbotUrl: origin,
    token: "obr_fixture",
    via: "web",
  });
});

test("a third-party https site still gets the Connect page and nothing is exchanged until the person approves it", async () => {
  desktopAnswers(loopback);
  // Not pinned by the organization, and not OpenBot Desktop's: https on a loopback IP is a site like any other.
  for (const site of [origin, `https://127.0.0.1:${server.port}`]) {
    clock += 6 * 60 * 1000;
    expect(await connect(`obc_${site.length}`, site)).toEqual({
      ok: true,
      awaitingConfirmation: true,
    });
    expect(await readSession("pendingConnect")).toMatchObject({
      origin: site,
      via: "web",
    });
  }
  expect(opened).toHaveLength(2);
  expect(exchanges).toEqual([]);
  expect(await currentConnection()).toBeNull();
});

test("a trusted OpenBot's code OpenBot refuses, or an OpenBot that does not answer, stores nothing, opens nothing and says why", async () => {
  desktopAnswers(loopback);
  expect(await connect("obc_expired", loopback)).toEqual({
    ok: false,
    error: "exchange-refused",
  });
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: openbot });
  const gone = closed.url.origin;
  await closed.stop(true);
  desktopAnswers(gone);
  expect(await connect("obc_d", gone)).toEqual({
    ok: false,
    error: "openbot-unreachable",
  });
  expect(await currentConnection()).toBeNull();
  expect(opened).toEqual([]);
  expect(await readSession("pendingConnect")).toBeUndefined();
});

test("a trusted OpenBot's connect closes a Connect page another site left open, so approving it cannot replace this connection", async () => {
  desktopAnswers(loopback);
  expect(await connect("obc_w", "https://a.example.test")).toMatchObject({
    awaitingConfirmation: true,
  });
  expect(await connect("obc_desktop_page", loopback)).toMatchObject({
    connected: true,
  });
  expect(fake.removed).toEqual([41]);
  expect(await readSession("pendingConnect")).toBeUndefined();
  expect(
    await handleConnectionMessage({
      type: "page.connect.decide",
      approve: true,
      label: "x",
      origin: "https://a.example.test",
    }),
  ).toEqual({ ok: false, error: "There is nothing to connect." });
  expect(await currentConnection()).toMatchObject({ openbotUrl: loopback });
});

test("a pin elsewhere that lands while a trusted OpenBot's code is exchanged keeps the connection out and revokes its new token", async () => {
  desktopAnswers(loopback);
  const exchange = holdAnswer("/api/recorder/connections");
  const connecting = connect("obc_desktop_page", loopback);
  await exchange.arrived;
  policy = { ...policy, openbotUrl: "https://moved.example.test" };
  exchange.release();
  expect(await connecting).toEqual({ ok: false, error: "pinned-elsewhere" });
  expect(await currentConnection()).toBeNull();
  expect(hits).toContain(
    "DELETE /api/recorder/connections/current Bearer obr_fixture",
  );
});

test("a trusted OpenBot asking to connect over and over is held to the same limit as any site", async () => {
  desktopAnswers(loopback);
  for (let i = 1; i <= 10; i++) {
    // Connected to nothing each time, as a trusted OpenBot only connects with no Connect page then.
    fake.storage.local.delete("connection");
    expect(await connect(`obc_${i}`, loopback)).toMatchObject({
      ok: true,
      connected: true,
    });
    clock += 30 * 1000;
  }
  expect(await connect("obc_11", loopback)).toEqual({
    ok: false,
    error: "throttled",
    retryAfterMs: 5 * 60 * 1000,
  });
  expect(exchanges).toHaveLength(10);
});

// ---- A loopback page is OpenBot Desktop's only when Desktop says so, and no connection is ever replaced without the
// Connect page: any program on this computer can serve a page on a loopback port, and one that connected with no click
// would receive the person's next recordings ---------------------------------------------------------------------------

test("a page on a loopback port that OpenBot Desktop did not confirm gets the Connect page, whatever serves it, and nothing is exchanged until the person approves it", async () => {
  const elsewhere = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: openbot,
  });
  try {
    for (const [why, answer] of [
      // No OpenBot Desktop on this computer: its native host is not installed.
      ["no host", () => desktopAnswers(null)],
      // OpenBot Desktop runs its OpenBot on another port: this page is a dev server, a notebook, any local app.
      ["another port", () => desktopAnswers(elsewhere.url.origin)],
      // OpenBot Desktop from before the address message.
      [
        "older host",
        () => {
          fake.native.reply = () => ({ ok: false, error: "unknown-message" });
        },
      ],
    ] as const) {
      answer();
      clock += 6 * 60 * 1000;
      expect(await connect(`obc_${why.length}`, loopback)).toEqual({
        ok: true,
        awaitingConfirmation: true,
      });
      expect(await readSession("pendingConnect")).toMatchObject({
        origin: loopback,
        via: "web",
      });
    }
    expect(exchanges).toEqual([]);
    expect(await currentConnection()).toBeNull();
    expect(opened).toHaveLength(1);
  } finally {
    await elsewhere.stop(true);
  }
});

test("a trusted OpenBot asking while this browser is connected goes through the Connect page, which names the connection it replaces, and nothing is exchanged before the click", async () => {
  desktopAnswers(loopback);
  await connected("obr_old");
  expect(await connect("obc_desktop_page_bea", loopback)).toEqual({
    ok: true,
    awaitingConfirmation: true,
  });
  // The organization's pinned OpenBot, asking again as another person, is asked about too.
  policy = { ...policy, openbotUrl: origin };
  clock += 6 * 60 * 1000;
  fake.tabs.delete(41);
  expect(await connect("obc_pinned_bea")).toEqual({
    ok: true,
    awaitingConfirmation: true,
  });
  expect(exchanges).toEqual([]);
  expect(await currentConnection()).toMatchObject({ token: "obr_old", user });
  expect(
    await handleConnectionMessage({ type: "page.connect.pending" }),
  ).toEqual({
    ok: true,
    pending: { origin, via: "web" },
    replaces: { origin, email: user.email },
  });
});

test("approving a Connect page that replaces another OpenBot's or another person's connection stops what still uses it, then revokes its token at its OpenBot", async () => {
  const events: string[] = [];
  const losses: ConnectionLoss[] = [];
  const watched = {
    ...deps(),
    connectionLost: async (loss: ConnectionLoss) => {
      losses.push(loss);
      events.push(`lost ${loss.connection.token}`);
    },
  };
  const approve = () =>
    handleConnectionMessage(
      { type: "page.connect.decide", approve: true, label: "x", origin },
      watched,
    );
  const revoked = (token: string) =>
    hits.filter(
      (hit) =>
        hit === `DELETE /api/recorder/connections/current Bearer ${token}`,
    ).length;
  const recordRevokes = () => {
    for (const token of ["obr_old", "obr_fixture"])
      if (
        revoked(token) > events.filter((e) => e === `revoked ${token}`).length
      )
        events.push(`revoked ${token}`);
  };

  // Another person on the same OpenBot.
  await connected("obr_old");
  const ada = await currentConnection();
  if (!ada) throw new Error("Not connected");
  await handleExternalConnect(
    { type: "openbot.connect", code: "obc_x_bea" },
    { origin },
    watched,
  );
  expect(await approve()).toEqual({ ok: true });
  recordRevokes();
  expect(await currentConnection()).toMatchObject({
    token: "obr_bea",
    user: bea,
  });
  expect(losses).toEqual([{ kind: "replaced", connection: ada }]);
  // The controller heard first, so nothing still sending with the old token meets its revocation.
  expect(events).toEqual(["lost obr_old", "revoked obr_old"]);

  // The same person on the same OpenBot is this copy connecting again: OpenBot revoked the old token at the exchange
  // (one live connection per person and install id), and the recording goes on under the new one.
  clock += 6 * 60 * 1000;
  await connected("obr_old");
  hits.length = 0;
  losses.length = 0;
  await handleExternalConnect(
    { type: "openbot.connect", code: "obc_y" },
    { origin },
    watched,
  );
  expect(await approve()).toEqual({ ok: true });
  expect(losses).toEqual([]);
  expect(revoked("obr_old")).toBe(0);
});

test("a connection that lands while a trusted OpenBot's code is exchanged is never replaced: the new token is revoked and the page told to try again", async () => {
  desktopAnswers(loopback);
  const exchange = holdAnswer("/api/recorder/connections");
  const connecting = connect("obc_desktop_page", loopback);
  await exchange.arrived;
  await connected("obr_old");
  exchange.release();
  expect(await connecting).toEqual({ ok: false, error: "busy" });
  expect(await currentConnection()).toMatchObject({ token: "obr_old" });
  expect(hits).toContain(
    "DELETE /api/recorder/connections/current Bearer obr_fixture",
  );
  expect(hits).not.toContain(
    "DELETE /api/recorder/connections/current Bearer obr_old",
  );
});

test("a connection OpenBot Desktop makes in place of another person's stops what still uses the old one, then revokes it", async () => {
  await writeLocal("connection", {
    openbotUrl: origin,
    token: "obr_bea",
    connectionId: "c2",
    user: bea,
    via: "web",
    connectedAt: clock,
  });
  const losses: ConnectionLoss[] = [];
  expect(
    await connectThroughDesktop({
      askDesktop: async () => ({ openbotUrl: loopback, code: "obc_d" }),
      openTab,
      readPolicy: async () => policy,
      connectionLost: async (loss) => {
        losses.push(loss);
      },
    }),
  ).toEqual({ connected: true });
  expect(losses).toEqual([
    {
      kind: "replaced",
      connection: expect.objectContaining({ token: "obr_bea", user: bea }),
    },
  ]);
  expect(hits).toContain(
    "DELETE /api/recorder/connections/current Bearer obr_bea",
  );
});

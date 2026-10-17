import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
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
      )
        return new Response(null, { status: 204 });
      if (url.pathname === "/api/recorder/me")
        return Response.json(meAnswer.body, { status: meAnswer.status });
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
});
afterEach(() => {
  Date.now = realNow;
  fake.uninstall();
});

const connect = (code: string, from = origin) =>
  handleExternalConnect(
    { type: "openbot.connect", code },
    { origin: from },
    deps(),
  );

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

async function connected() {
  await writeLocal("connection", {
    openbotUrl: origin,
    token: "obr_fixture",
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

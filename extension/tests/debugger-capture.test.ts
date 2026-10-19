import {
  afterEach,
  beforeEach,
  expect,
  type Mock,
  spyOn,
  test,
} from "bun:test";
import {
  type CapturedEvent,
  EVENT_BUDGET_BYTES,
  normaliseSecret,
  sha256HexSync,
} from "@openbot/shared/recorder-masking";
import {
  createNetworkCapture,
  type NetworkCapture,
  type NetworkMode,
} from "../src/background/network";
import type { PageFallback } from "../src/background/network/fallback";
import { NETWORK_BODY_READ_MAX_BYTES } from "../src/shared/network-body";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";
import {
  CARD_AND_PIN_CLOCK,
  CODE_CLOCK,
  leakedSecrets,
  recordedText,
} from "./support/recorded-text";

const EXTENSION_ID = "test";
const OPENBOT = "https://openbot.example.test";
const MiB = 1024 * 1024;

type Value = {
  transport: string;
  method: string;
  url: string;
  origin: string;
  route: string;
  status: number | null;
  durationMs: number;
  completedAt: number;
  outcome: string;
  capturedBy: string;
  request: { headers: Record<string, string>; body: Record<string, unknown> };
  response: {
    url?: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  };
};

let fake: ChromeFake;
let capture: NetworkCapture;
let emitted: CapturedEvent[] = [];
let statuses: [NetworkMode | "stopped", string | undefined][] = [];
let digests = new Set<string>();
let fallbackCalls: string[] = [];
let fallbackStarts = true;
/** Response bodies by request id, as Network.getResponseBody answers them. */
let bodies: Record<string, { body: string; base64Encoded: boolean }> = {};
let postData: Record<string, string> = {};
let fetches = 0;
const realFetch = globalThis.fetch;
/** Date.now(), held at a reading that holds the tests' secrets' digits (support/recorded-text.ts says why). */
let clock: Mock<typeof Date.now>;

const fallback: PageFallback = {
  start: async (tabIds) => {
    fallbackCalls.push(`start ${tabIds.join(",")}`);
    return fallbackStarts;
  },
  addTab: async (tabId) => {
    fallbackCalls.push(`addTab ${tabId}`);
  },
  onCommitted: async (tabId, frameId) => {
    fallbackCalls.push(`onCommitted ${tabId} ${frameId}`);
  },
  stop: async () => {
    fallbackCalls.push("stop");
  },
  active: () => false,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => sleep(20);
// performance.now(), not Date.now(): the wall clock is pinned in these tests.
async function until(check: () => boolean, label: string) {
  const deadline = performance.now() + 3_000;
  while (!check()) {
    if (performance.now() > deadline)
      throw new Error(`Timed out waiting: ${label}`);
    await sleep(2);
  }
}
const value = (event: CapturedEvent | undefined) =>
  (event?.value ?? {}) as unknown as Value;
const commandsTo = (method: string) =>
  fake.debugger.commands.filter((command) => command.method === method);

beforeEach(() => {
  clock = spyOn(Date, "now").mockReturnValue(CARD_AND_PIN_CLOCK);
  fake = installChromeFake({ extensionId: EXTENSION_ID });
  emitted = [];
  statuses = [];
  digests = new Set();
  fallbackCalls = [];
  fallbackStarts = true;
  bodies = {};
  postData = {};
  fetches = 0;
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      fetches += 1;
      return realFetch(input, init);
    },
    { preconnect: realFetch.preconnect },
  );
  fake.debugger.respond("Network.getResponseBody", (params) => {
    const answer = bodies[(params as { requestId: string }).requestId];
    if (!answer) throw new Error("No resource with given identifier found");
    return answer;
  });
  fake.debugger.respond("Network.getRequestPostData", (params) => ({
    postData: postData[(params as { requestId: string }).requestId] ?? "",
  }));
  capture = createNetworkCapture(
    {
      openbotUrl: () => OPENBOT,
      emit: (event) => emitted.push(event),
      status: (mode, reason) => statuses.push([mode, reason]),
      digests: () => digests,
    },
    { fallback },
  );
});

afterEach(async () => {
  await capture.stop();
  globalThis.fetch = realFetch;
  fake.uninstall();
  clock.mockRestore();
});

type RequestSpec = {
  id: string;
  url: string;
  method?: string;
  type?: string;
  headers?: Record<string, string>;
  postData?: string;
  hasPostData?: boolean;
  status?: number;
  responseHeaders?: Record<string, string>;
  mimeType?: string;
  body?: string;
  base64Encoded?: boolean;
  failed?: { canceled: boolean };
  sessionId?: string;
  frameId?: string;
  /** No action of the person's came before it: the page made it on its own. */
  unprompted?: boolean;
  /** Seconds since the epoch the request was sent (CDP's wallTime); SENT unless a test says otherwise. */
  wallTime?: number;
  /** How long it ran, in seconds (0.25 unless a test says otherwise). */
  duration?: number;
};

/** When the requests below are sent, unless a test says otherwise (CDP's wallTime, in seconds). */
const SENT = Math.floor(Date.now() / 1000);

/** A request as Chrome reports it: sent, answered, then finished (or failed). */
function request(tabId: number, spec: RequestSpec) {
  const target = spec.sessionId
    ? { tabId, sessionId: spec.sessionId }
    : { tabId };
  const type = spec.type ?? "Fetch";
  const wallTime = spec.wallTime ?? SENT;
  // CDP's monotonic clock, in step with the wall clock.
  const sentAt = 100 + (wallTime - SENT);
  const endAt = sentAt + (spec.duration ?? 0.25);
  // The person's click just before: the call is theirs (causality.ts).
  if (!spec.unprompted) capture.action(tabId, wallTime * 1000 - 100);
  if (spec.body !== undefined)
    bodies[spec.id] = {
      body: spec.body,
      base64Encoded: spec.base64Encoded ?? false,
    };
  fake.debugger.emit(target, "Network.requestWillBeSent", {
    requestId: spec.id,
    type,
    timestamp: sentAt,
    wallTime,
    ...(spec.frameId !== undefined ? { frameId: spec.frameId } : {}),
    request: {
      url: spec.url,
      method: spec.method ?? "GET",
      headers: spec.headers ?? {},
      ...(spec.postData !== undefined ? { postData: spec.postData } : {}),
      ...(spec.hasPostData ? { hasPostData: true } : {}),
    },
  });
  if (spec.failed) {
    fake.debugger.emit(target, "Network.loadingFailed", {
      requestId: spec.id,
      timestamp: endAt,
      type,
      errorText: "net::ERR_FAILED",
      canceled: spec.failed.canceled,
    });
    return;
  }
  fake.debugger.emit(target, "Network.responseReceived", {
    requestId: spec.id,
    type,
    timestamp: endAt,
    response: {
      url: spec.url,
      status: spec.status ?? 200,
      headers: spec.responseHeaders ?? {
        "content-type": spec.mimeType ?? "application/json",
      },
      mimeType: spec.mimeType ?? "application/json",
    },
  });
  fake.debugger.emit(target, "Network.loadingFinished", {
    requestId: spec.id,
    timestamp: endAt,
  });
}

// ---- Requests --------------------------------------------------------------------------------

test("a fetch becomes a masked network event for Intelligence, credentials removed before it leaves", async () => {
  expect(await capture.start(7, "https://crm.example.test/deals")).toBe(
    "debugger",
  );
  request(7, {
    id: "1",
    url: "https://api.example.test/v1/deals/42?token=abc",
    method: "PUT",
    headers: { Authorization: "Bearer s", "Content-Type": "application/json" },
    postData: '{"stage":"won","password":"x"}',
    responseHeaders: {
      "content-type": "application/json",
      "set-cookie": "a=b",
    },
    body: '{"ok":true,"token":"t"}',
  });
  await until(() => emitted.length === 1, "the event");
  const [event] = emitted;
  expect(event?.name).toBe("network");
  expect(value(event)).toMatchObject({
    transport: "fetch",
    method: "PUT",
    url: "https://api.example.test/v1/deals/42?token=[redacted]",
    origin: "https://api.example.test",
    route: "/v1/deals/42",
    status: 200,
    outcome: "ok",
    durationMs: 250,
    capturedBy: "debugger",
  });
  expect(value(event).request.headers.Authorization).toBe("[redacted]");
  expect(value(event).response.headers["set-cookie"]).toBe("[redacted]");
  expect(JSON.parse(value(event).request.body.text as string)).toEqual({
    stage: "won",
    password: "[redacted]",
  });
  expect(JSON.parse(value(event).response.body.text as string)).toEqual({
    ok: true,
    token: "[redacted]",
  });
  const text = JSON.stringify(event);
  expect(text).not.toContain("Bearer s");
  expect(text).not.toContain("a=b");
  expect(statuses).toEqual([["debugger", undefined]]);
});

test("every read is recorded too, an XHR included", async () => {
  await capture.start(7, "https://crm.example.test/");
  request(7, {
    id: "1",
    url: "https://crm.example.test/api/deals",
    body: "[]",
  });
  request(7, {
    id: "2",
    url: "https://crm.example.test/api/me",
    type: "XHR",
    body: "{}",
  });
  await until(() => emitted.length === 2, "two events");
  expect(
    emitted.map((event) => [value(event).method, value(event).transport]),
  ).toEqual([
    ["GET", "fetch"],
    ["GET", "xhr"],
  ]);
});

test("images, scripts, stylesheets, fonts and a document request outside the top frame are not recorded", async () => {
  await capture.start(7, "https://crm.example.test/");
  for (const [id, type] of [
    ["1", "Image"],
    ["2", "Script"],
    ["3", "Stylesheet"],
    ["4", "Document"],
    ["5", "Font"],
  ] as const)
    request(7, {
      id,
      url: `https://cdn.example.test/${id}`,
      type,
      mimeType: "text/plain",
      body: "x",
    });
  request(7, { id: "6", url: "https://crm.example.test/api", body: "{}" });
  await until(() => emitted.length === 1, "the fetch");
  await settle();
  expect(emitted.map((event) => value(event).url)).toEqual([
    "https://crm.example.test/api",
  ]);
  expect(commandsTo("Network.getResponseBody")).toHaveLength(1);
});

test("calls to OpenBot itself are ignored", async () => {
  await capture.start(7, "https://crm.example.test/");
  request(7, {
    id: "1",
    url: `${OPENBOT}/api/copilotkit/trajectory/x/connect`,
    method: "POST",
    body: "{}",
  });
  request(7, { id: "2", url: "https://crm.example.test/api", body: "{}" });
  await until(() => emitted.length === 1, "one event");
  await settle();
  expect(value(emitted[0]).url).toBe("https://crm.example.test/api");
});

test("a value typed into a sensitive field is scrubbed from a request body, a URL and a response", async () => {
  digests.add(sha256HexSync(normaliseSecret("4111111111111111")));
  digests.add(sha256HexSync(normaliseSecret("hunter-two")));
  await capture.start(7, "https://shop.example.test/");
  request(7, {
    id: "1",
    url: "https://shop.example.test/api/pay?code=hunter-two",
    method: "POST",
    headers: { "content-type": "text/plain" },
    postData: "card 4111 1111 1111 1111 please",
    body: '{"echo":"hunter-two"}',
  });
  await until(() => emitted.length === 1, "the event");
  const text = recordedText(emitted[0]);
  expect(text).not.toContain("4111");
  expect(text).not.toContain("hunter-two");
  expect(text).toContain("[redacted]");
});

test("post data that is not inline is fetched", async () => {
  await capture.start(7, "https://crm.example.test/");
  postData["1"] = '{"note":"long"}';
  request(7, {
    id: "1",
    url: "https://crm.example.test/api/notes",
    method: "POST",
    headers: { "content-type": "application/json" },
    hasPostData: true,
    body: "{}",
  });
  await until(() => emitted.length === 1, "the event");
  expect(commandsTo("Network.getRequestPostData")).toEqual([
    {
      target: { tabId: 7 },
      method: "Network.getRequestPostData",
      params: { requestId: "1" },
    },
  ]);
  expect(value(emitted[0]).request.body).toEqual({
    status: "complete",
    text: '{"note":"long"}',
    encoding: "utf-8",
  });
});

test("a binary response is unavailable, and its body is never asked for", async () => {
  await capture.start(7, "https://crm.example.test/");
  request(7, {
    id: "1",
    url: "https://crm.example.test/api/export",
    mimeType: "application/pdf",
    body: "JVBERi0=",
    base64Encoded: true,
  });
  await until(() => emitted.length === 1, "the event");
  expect(value(emitted[0]).response.body).toEqual({
    status: "unavailable",
    reason: "binary",
  });
  expect(commandsTo("Network.getResponseBody")).toEqual([]);
});

test("a text response Chrome hands over as base64 is decoded", async () => {
  await capture.start(7, "https://crm.example.test/");
  request(7, {
    id: "1",
    url: "https://crm.example.test/api/hello",
    mimeType: "text/plain",
    body: btoa("hello"),
    base64Encoded: true,
  });
  await until(() => emitted.length === 1, "the event");
  expect(value(emitted[0]).response.body.text).toBe("hello");
});

test("a failed request is an error with no status; a cancelled one is not recorded at all", async () => {
  await capture.start(7, "https://crm.example.test/");
  request(7, {
    id: "1",
    url: "https://crm.example.test/api/a",
    failed: { canceled: false },
  });
  request(7, {
    id: "2",
    url: "https://crm.example.test/api/b",
    failed: { canceled: true },
  });
  await until(() => emitted.length === 1, "the failed call");
  await settle();
  expect(
    emitted.map((event) => [
      value(event).url,
      value(event).outcome,
      value(event).status,
    ]),
  ).toEqual([["https://crm.example.test/api/a", "error", null]]);
  expect(value(emitted[0]).response.body).toEqual({
    status: "unavailable",
    reason: "no-response",
  });
});

test("a large body is trimmed to fit one event and is never sent or stored anywhere else", async () => {
  await capture.start(7, "https://crm.example.test/");
  request(7, {
    id: "1",
    url: "https://crm.example.test/api/rows",
    body: JSON.stringify({ rows: "x".repeat(200 * 1024) }),
  });
  await until(() => emitted.length === 1, "the event");
  const bytes = new TextEncoder().encode(JSON.stringify(emitted[0])).length;
  expect(bytes).toBeLessThanOrEqual(EVENT_BUDGET_BYTES);
  expect(value(emitted[0]).response.body).toMatchObject({
    status: "truncated",
    truncated: true,
  });
  expect(value(emitted[0])).not.toHaveProperty("bodyRef");
  expect(fetches).toBe(0);
});

test("a body over 2 MiB is read to its first 2 MiB only, and the event says how large it was", async () => {
  expect(NETWORK_BODY_READ_MAX_BYTES).toBe(2 * MiB);
  await capture.start(7, "https://crm.example.test/");
  request(7, {
    id: "1",
    url: "https://crm.example.test/api/dump",
    mimeType: "text/plain",
    body: "a".repeat(3 * MiB),
  });
  await until(() => emitted.length === 1, "the event");
  expect(value(emitted[0]).response.body).toMatchObject({
    status: "truncated",
    bytes: 3 * MiB,
  });
});

// ---- Tabs, frames and the debugger bar -------------------------------------------------------

test("cross-site iframes are captured through their own session", async () => {
  await capture.start(7, "https://crm.example.test/");
  expect(fake.debugger.attached).toEqual([{ tabId: 7 }]);
  expect(commandsTo("Network.enable")).toEqual([
    {
      target: { tabId: 7 },
      method: "Network.enable",
      params: { maxPostDataSize: 65536 },
    },
  ]);
  expect(commandsTo("Target.setAutoAttach")).toEqual([
    {
      target: { tabId: 7 },
      method: "Target.setAutoAttach",
      params: {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      },
    },
  ]);
  fake.debugger.emit({ tabId: 7 }, "Target.attachedToTarget", {
    sessionId: "frame-1",
    targetInfo: { type: "iframe", url: "https://widgets.example.test/" },
    waitingForDebugger: false,
  });
  fake.debugger.emit({ tabId: 7 }, "Target.attachedToTarget", {
    sessionId: "worker-1",
    targetInfo: {
      type: "service_worker",
      url: "https://crm.example.test/sw.js",
    },
    waitingForDebugger: false,
  });
  await until(
    () => commandsTo("Network.enable").length === 2,
    "the frame's Network.enable",
  );
  await settle();
  expect(commandsTo("Network.enable")[1]?.target as unknown).toEqual({
    tabId: 7,
    sessionId: "frame-1",
  });
  expect(commandsTo("Target.setAutoAttach")[1]?.target as unknown).toEqual({
    tabId: 7,
    sessionId: "frame-1",
  });
  request(7, {
    id: "f1",
    sessionId: "frame-1",
    url: "https://widgets.example.test/api",
    body: '{"a":1}',
  });
  await until(() => emitted.length === 1, "the frame's call");
  expect(value(emitted[0]).url).toBe("https://widgets.example.test/api");
  expect(
    commandsTo("Network.getResponseBody").at(-1)?.target as unknown,
  ).toEqual({
    tabId: 7,
    sessionId: "frame-1",
  });
});

test("a detach by the person stops network capture without falling back", async () => {
  await capture.start(7, "https://crm.example.test/");
  await capture.addTab(8, "https://crm.example.test/report");
  fake.debugger.detach({ tabId: 7 }, "canceled_by_user");
  await settle();
  expect(statuses.at(-1)).toEqual([
    "stopped",
    "You closed Chrome's debugging bar, so network calls are no longer recorded.",
  ]);
  expect(fallbackCalls).toEqual([]);
  expect(fake.debugger.attached).toEqual([]);
  // Nothing attaches again for the rest of the recording.
  await capture.addTab(9, "https://crm.example.test/x");
  await capture.onCommitted(7, 0, "https://crm.example.test/y");
  expect(fake.debugger.attached).toEqual([]);
  request(8, { id: "late", url: "https://crm.example.test/api", body: "{}" });
  await settle();
  expect(emitted).toEqual([]);
});

test("a closed tab is dropped and the other followed tabs keep capturing", async () => {
  await capture.start(7, "https://crm.example.test/");
  await capture.addTab(8, "https://crm.example.test/report");
  expect(fake.debugger.attached).toEqual([{ tabId: 7 }, { tabId: 8 }]);
  fake.debugger.detach({ tabId: 8 }, "target_closed");
  await settle();
  request(7, { id: "1", url: "https://crm.example.test/api", body: "{}" });
  await until(() => emitted.length === 1, "tab 7's call");
  expect(statuses.map(([mode]) => mode)).not.toContain("stopped");
});

test("a tab the recorded tab opened is attached the same way, and one not yet on a website waits for its first page", async () => {
  await capture.start(7, "https://crm.example.test/");
  await capture.addTab(8, "https://crm.example.test/report");
  expect(fake.debugger.attached).toEqual([{ tabId: 7 }, { tabId: 8 }]);
  await capture.addTab(9, "about:blank");
  expect(fake.debugger.attached).toEqual([{ tabId: 7 }, { tabId: 8 }]);
  await capture.onCommitted(9, 2, "https://crm.example.test/frame");
  expect(fake.debugger.attached).toHaveLength(2);
  await capture.onCommitted(9, 0, "https://crm.example.test/opened");
  expect(fake.debugger.attached).toEqual([
    { tabId: 7 },
    { tabId: 8 },
    { tabId: 9 },
  ]);
});

test("a recording started on the New Tab page attaches once the tab opens a website", async () => {
  expect(await capture.start(7, "chrome://newtab/")).toBe("waiting");
  expect(statuses).toEqual([
    ["waiting", "Network calls are recorded once this tab opens a website."],
  ]);
  expect(fake.debugger.attached).toEqual([]);
  await capture.onCommitted(7, 0, "https://crm.example.test/");
  expect(fake.debugger.attached).toEqual([{ tabId: 7 }]);
  expect(statuses.at(-1)).toEqual(["debugger", undefined]);
});

test("a refused attach on a real site falls back to page capture", async () => {
  fake.debugger.refuseAttach = "Cannot attach to this target.";
  expect(await capture.start(7, "https://crm.example.test/")).toBe("page");
  expect(fallbackCalls).toEqual(["start 7"]);
  expect(statuses.at(-1)).toEqual([
    "page",
    "Chrome refused its debugger here.",
  ]);
});

test("a refused attach with no page capture either is off, with Chrome's reason", async () => {
  fake.debugger.refuseAttach = "Cannot attach to this target.";
  fallbackStarts = false;
  expect(await capture.start(7, "https://crm.example.test/")).toBe("off");
  expect(statuses.at(-1)).toEqual([
    "off",
    "Chrome would not let the Recorder record network calls here (Cannot attach to this target.).",
  ]);
});

test("in page mode the capture forwards new tabs and commits to the fallback it owns, and stops it", async () => {
  fake.debugger.refuseAttach = "Cannot attach to this target.";
  await capture.start(7, "https://crm.example.test/");
  await capture.addTab(8, "https://crm.example.test/report");
  await capture.onCommitted(7, 3, "https://widgets.example.test/");
  await capture.stop();
  expect(fallbackCalls).toEqual([
    "start 7",
    "addTab 8",
    "onCommitted 7 3",
    "stop",
  ]);
});

test("a resumed capture re-attaches to every followed tab, detaching a stale session of its own first", async () => {
  fake.tabs.set(7, {
    id: 7,
    url: "https://crm.example.test/",
  } as chrome.tabs.Tab);
  fake.tabs.set(8, {
    id: 8,
    url: "https://crm.example.test/b",
  } as chrome.tabs.Tab);
  await chrome.debugger.attach({ tabId: 7 }, "1.3"); // left over from the worker that went away
  fake.calls.length = 0;
  const mode = await capture.resume(
    [
      { tabId: 7, url: "https://crm.example.test/" },
      { tabId: 8, url: "https://crm.example.test/b" },
      { tabId: 9, url: "chrome://settings/" },
    ],
    "debugger",
  );
  expect(mode).toBe("debugger");
  expect(
    fake.calls.filter((call) =>
      /^debugger\.(attach|detach|sendCommand|getTargets)$/.test(call),
    ),
  ).toEqual([
    "debugger.getTargets",
    "debugger.detach",
    "debugger.attach",
    "debugger.sendCommand",
    "debugger.sendCommand",
    "debugger.attach",
    "debugger.sendCommand",
    "debugger.sendCommand",
  ]);
  expect(fake.debugger.attached).toEqual([{ tabId: 7 }, { tabId: 8 }]);
  expect(commandsTo("Network.enable").map((command) => command.target)).toEqual(
    [{ tabId: 7 }, { tabId: 8 }],
  );
  await capture.onCommitted(9, 0, "https://crm.example.test/c");
  expect(fake.debugger.attached).toHaveLength(3);
});

test("a resumed capture the person had stopped stays stopped, and one in page mode resumes the page capture", async () => {
  expect(
    await capture.resume(
      [{ tabId: 7, url: "https://crm.example.test/" }],
      "stopped",
    ),
  ).toBe("stopped");
  expect(fake.debugger.attached).toEqual([]);
  await capture.stop();
  capture = createNetworkCapture(
    {
      openbotUrl: () => OPENBOT,
      emit: (event) => emitted.push(event),
      status: (mode, reason) => statuses.push([mode, reason]),
      digests: () => digests,
    },
    { fallback },
  );
  fallbackCalls = [];
  expect(
    await capture.resume(
      [
        { tabId: 7, url: "https://crm.example.test/" },
        { tabId: 8, url: "https://crm.example.test/b" },
      ],
      "page",
    ),
  ).toBe("page");
  expect(fallbackCalls).toEqual(["start 7,8"]);
  expect(fake.debugger.attached).toEqual([]);
});

test("stop detaches every tab, and nothing in flight is emitted after it", async () => {
  await capture.start(7, "https://crm.example.test/");
  await capture.addTab(8, "https://crm.example.test/b");
  fake.debugger.emit({ tabId: 7 }, "Network.requestWillBeSent", {
    requestId: "1",
    type: "Fetch",
    timestamp: 1,
    request: {
      url: "https://crm.example.test/api",
      method: "GET",
      headers: {},
    },
  });
  await capture.stop();
  expect(fake.debugger.attached).toEqual([]);
  fake.debugger.emit({ tabId: 7 }, "Network.loadingFinished", {
    requestId: "1",
    timestamp: 2,
  });
  await settle();
  expect(emitted).toEqual([]);
});

test("a page-level event is trimmed to fit one event and emitted", async () => {
  await capture.start(7, "https://crm.example.test/");
  const now = Date.now();
  capture.action(7, now - 50);
  const big: CapturedEvent = {
    type: "CUSTOM",
    name: "network",
    timestamp: now,
    value: {
      method: "GET",
      url: "https://crm.example.test/api",
      status: 200,
      completedAt: now,
      durationMs: 20,
      capturedBy: "page",
      response: {
        headers: { "content-type": "text/plain" },
        body: { status: "complete", text: "y".repeat(300 * 1024) },
      },
    },
  };
  await capture.recordPageEvent(7, big);
  expect(emitted).toHaveLength(1);
  expect(
    new TextEncoder().encode(JSON.stringify(emitted[0])).length,
  ).toBeLessThanOrEqual(EVENT_BUDGET_BYTES);
  expect(value(emitted[0]).capturedBy).toBe("page");
});

test("a page-level event for a call to OpenBot itself is dropped, like the debugger drops it", async () => {
  await capture.start(7, "https://crm.example.test/");
  const now = Date.now();
  capture.action(7, now - 50);
  const pageEvent = (url: string, responseUrl = url): CapturedEvent => ({
    type: "CUSTOM",
    name: "network",
    timestamp: now,
    value: {
      method: "POST",
      url,
      status: 200,
      completedAt: now,
      durationMs: 20,
      capturedBy: "page",
      response: {
        url: responseUrl,
        headers: { "content-type": "application/json" },
        body: { status: "complete", text: '{"code":"obc_live_connect_code"}' },
      },
    },
  });
  await capture.recordPageEvent(
    7,
    pageEvent(`${OPENBOT}/api/recorder/connect-codes`),
  );
  // A call that a redirect landed on OpenBot.
  await capture.recordPageEvent(
    7,
    pageEvent("https://crm.example.test/go", `${OPENBOT}/api/recorder/me`),
  );
  await capture.recordPageEvent(7, pageEvent("https://crm.example.test/api"));
  expect(emitted.map((event) => value(event).url)).toEqual([
    "https://crm.example.test/api",
  ]);
});

// ---- Only what the person's actions cause -----------------------------------------------------

test("a click's API call is recorded; the beacons, polling, prefetch, iframe and aborted calls around it are not", async () => {
  fake.tabs.set(7, {
    id: 7,
    url: "https://crm.example.test/deals/42",
  } as chrome.tabs.Tab);
  await capture.start(7, "https://crm.example.test/deals/42");
  // Everything happened half a minute ago, so nothing below waits for an action still on its way.
  const click = SENT - 30;
  const at = (seconds: number) => ({
    wallTime: click + seconds,
    unprompted: true,
  });
  // The page polls on its own before the person does anything.
  request(7, {
    id: "poll-1",
    url: "https://crm.example.test/api/unread",
    body: "{}",
    ...at(-10),
  });
  capture.action(7, click * 1000);
  // The person's click: the note they add, and the deal the response handler reloads 1.2 s in, past the window.
  request(7, {
    id: "note",
    url: "https://crm.example.test/api/deals/42/notes",
    method: "POST",
    headers: { "content-type": "application/json" },
    postData: '{"text":"Call back Tuesday"}',
    body: '{"id":7}',
    duration: 1.1,
    ...at(0.08),
  });
  request(7, {
    id: "deal",
    url: "https://crm.example.test/api/deals/42",
    body: "{}",
    ...at(1.25),
  });
  // Around it, all the page's own: the same poll again, analytics, a beacon, a prefetch, a cancelled call, images and
  // scripts, and an iframe loading with its own ad call.
  request(7, {
    id: "poll-2",
    url: "https://crm.example.test/api/unread",
    body: "{}",
    ...at(0.1),
  });
  request(7, {
    id: "ga",
    url: "https://www.google-analytics.com/g/collect?v=2&en=click",
    method: "POST",
    ...at(0.12),
  });
  request(7, {
    id: "beacon",
    url: "https://crm.example.test/api/events",
    method: "POST",
    type: "Ping",
    ...at(0.13),
  });
  request(7, {
    id: "prefetch",
    url: "https://crm.example.test/deals/43",
    headers: { "next-router-prefetch": "1", rsc: "1" },
    body: "{}",
    ...at(0.14),
  });
  request(7, {
    id: "cancelled",
    url: "https://crm.example.test/api/search?q=a",
    failed: { canceled: true },
    ...at(0.15),
  });
  request(7, {
    id: "img",
    url: "https://crm.example.test/logo.png",
    type: "Image",
    mimeType: "image/png",
    ...at(0.16),
  });
  request(7, {
    id: "js",
    url: "https://crm.example.test/chunk.js",
    type: "Script",
    mimeType: "text/javascript",
    ...at(0.17),
  });
  request(7, {
    id: "frame-doc",
    url: "https://widgets.example.test/embed",
    type: "Document",
    frameId: "frame-1",
    sessionId: "frame-session",
    mimeType: "text/html",
    body: "<html></html>",
    ...at(0.18),
  });
  request(7, {
    id: "frame-ad",
    url: "https://securepubads.g.doubleclick.net/gampad/ads?iu=x",
    sessionId: "frame-session",
    ...at(0.2),
  });
  // Ten seconds on, with nothing done since: the page refreshing on its own.
  request(7, {
    id: "idle",
    url: "https://crm.example.test/api/activity",
    body: "[]",
    ...at(10),
  });
  await until(() => emitted.length === 2, "the click's two calls");
  await settle();
  expect(
    emitted.map((event) => [value(event).method, value(event).url]),
  ).toEqual([
    ["POST", "https://crm.example.test/api/deals/42/notes"],
    ["GET", "https://crm.example.test/api/deals/42"],
  ]);
  expect(JSON.parse(value(emitted[0]).request.body.text as string)).toEqual({
    text: "Call back Tuesday",
  });
  // Nothing dropped had its body asked for.
  expect(
    commandsTo("Network.getResponseBody").map(
      (command) => (command.params as { requestId: string }).requestId,
    ),
  ).toEqual(["note", "deal"]);
});

test("a form the person posts in the top frame is recorded as a document request; an iframe's document never is", async () => {
  fake.tabs.set(7, {
    id: 7,
    url: "https://crm.example.test/login",
  } as chrome.tabs.Tab);
  await capture.start(7, "https://crm.example.test/login");
  request(7, {
    id: "post",
    url: "https://crm.example.test/session",
    method: "POST",
    type: "Document",
    frameId: "target-7",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    postData: "user=ada&password=hunter2",
    mimeType: "text/html",
    body: "<html>Welcome</html>",
  });
  request(7, {
    id: "frame",
    url: "https://crm.example.test/embed",
    type: "Document",
    frameId: "child-frame",
    mimeType: "text/html",
    body: "<html></html>",
  });
  await until(() => emitted.length === 1, "the form post");
  await settle();
  expect(value(emitted[0])).toMatchObject({
    transport: "document",
    method: "POST",
    url: "https://crm.example.test/session",
  });
  expect(value(emitted[0]).request.body.text).toBe(
    "user=ada&password=[redacted]",
  );
});

test("a call that is answered before word of the click arrives waits for it, then is recorded", async () => {
  await capture.start(7, "https://crm.example.test/");
  const sent = Date.now() / 1000;
  request(7, {
    id: "cached",
    url: "https://crm.example.test/api/deals/42",
    body: "{}",
    wallTime: sent,
    duration: 0.002,
    unprompted: true,
  });
  await settle();
  expect(emitted).toEqual([]);
  capture.action(7, sent * 1000 - 30);
  await until(() => emitted.length === 1, "the held call");
  expect(value(emitted[0]).url).toBe("https://crm.example.test/api/deals/42");
});

test("through the page-level hook, only the click's call is kept as well", async () => {
  await capture.start(7, "https://crm.example.test/");
  const click = Date.now() - 30_000;
  const pageCall = (
    url: string,
    startedAt: number,
    extra: {
      method?: string;
      outcome?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
  ): CapturedEvent => ({
    type: "CUSTOM",
    name: "network",
    timestamp: startedAt + 120,
    value: {
      transport: "fetch",
      method: extra.method ?? "GET",
      url,
      status: extra.outcome === "aborted" ? null : 200,
      outcome: extra.outcome ?? "ok",
      completedAt: startedAt + 120,
      durationMs: 120,
      capturedBy: "page",
      request: {
        headers: extra.headers ?? {},
        body:
          extra.body === undefined
            ? { status: "empty" }
            : { status: "complete", text: extra.body },
      },
      response: { headers: {}, body: { status: "empty" } },
    },
  });
  await capture.recordPageEvent(
    7,
    pageCall("https://crm.example.test/api/unread", click - 5_000),
  );
  capture.action(7, click);
  for (const event of [
    pageCall("https://crm.example.test/api/deals/42/notes", click + 60, {
      method: "POST",
      body: '{"text":"Call back"}',
    }),
    pageCall("https://crm.example.test/api/unread", click + 70),
    pageCall("https://eu.i.posthog.com/e/", click + 80, { method: "POST" }),
    pageCall("https://crm.example.test/deals/43", click + 90, {
      headers: { "next-router-prefetch": "1" },
    }),
    pageCall("https://crm.example.test/api/search?q=a", click + 95, {
      outcome: "aborted",
    }),
    pageCall("https://crm.example.test/api/activity", click + 8_000),
  ])
    await capture.recordPageEvent(7, event);
  // The same click seen from another tab explains nothing there.
  await capture.recordPageEvent(
    8,
    pageCall("https://crm.example.test/api/deals/9", click + 60),
  );
  await settle();
  expect(emitted.map((event) => value(event).url)).toEqual([
    "https://crm.example.test/api/deals/42/notes",
  ]);
});

test("in the e2e build a forced refusal makes start fall back as a refused attach would", async () => {
  const previous = process.env.RECORDER_VARIANT;
  process.env.RECORDER_VARIANT = "e2e";
  try {
    fake.storage.local.set("RECORDER_E2E_FORCE_ATTACH_REFUSAL", true);
    expect(await capture.start(7, "https://crm.example.test/")).toBe("page");
    expect(fake.debugger.attached).toEqual([]);
    expect(fallbackCalls).toEqual(["start 7"]);
  } finally {
    if (previous === undefined) delete process.env.RECORDER_VARIANT;
    else process.env.RECORDER_VARIANT = previous;
  }
});

// ---- Credentials in form and oversized bodies --------------------------------------------------

// A realistic sign-in and payment. None of these may reach Intelligence.
const PASSWORD = "hunter2";
const PIN = "4921";
const CARD = "4111 1111 1111 1111";
const SESSION_TOKEN = "sess_9f8e7d6c";
const signInForm = new URLSearchParams({
  username: "alice",
  password: PASSWORD,
  pin: PIN,
  card_number: CARD,
  session_token: SESSION_TOKEN,
}).toString();
const leaked = (events: CapturedEvent[]) =>
  leakedSecrets(events, [PASSWORD, PIN, "4111", SESSION_TOKEN]);

test("a form post keeps none of its credentials, whether Chrome reports it as a form or as plain text", async () => {
  await capture.start(7, "https://bank.example.test/");
  request(7, {
    id: "1",
    url: "https://bank.example.test/session",
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    postData: signInForm,
    body: "{}",
  });
  request(7, {
    id: "2",
    url: "https://bank.example.test/session",
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    postData: signInForm,
    body: "{}",
  });
  await until(() => emitted.length === 2, "two events");
  for (const event of emitted)
    expect(value(event).request.body.text).toBe(
      "username=alice&password=[redacted]&pin=[redacted]&card_number=[redacted]&session_token=[redacted]",
    );
  expect(leaked(emitted)).toEqual([]);
});

test("a JSON body over 2 MiB, sent or received, keeps none of the credentials in the part that is read", async () => {
  const big = JSON.stringify({
    user: { name: "alice", password: PASSWORD },
    session_token: SESSION_TOKEN,
    payment: { pin: PIN, card_number: CARD },
    rows: "x".repeat(3 * MiB),
  });
  await capture.start(7, "https://bank.example.test/");
  postData["1"] = big;
  request(7, {
    id: "1",
    url: "https://bank.example.test/api/sync",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    hasPostData: true,
    body: big,
  });
  request(7, { id: "2", url: "https://bank.example.test/api/me", body: big });
  await until(() => emitted.length === 2, "two events");
  const [sent, received] = emitted;
  expect(value(sent).request.body.status).toBe("truncated");
  expect(value(sent).response.body.status).toBe("truncated");
  // Trimming empties the response first, so the request's opening is what is left to read.
  expect(value(sent).request.body.text as string).toContain(
    '"password":"[redacted]"',
  );
  expect(value(received).response.body.text as string).toContain(
    '"password":"[redacted]"',
  );
  expect(leaked(emitted)).toEqual([]);
});

test("a form body over 2 MiB sent as plain text keeps none of its credentials", async () => {
  await capture.start(7, "https://bank.example.test/");
  postData["1"] = `${signInForm}&notes=${"n".repeat(3 * MiB)}`;
  request(7, {
    id: "1",
    url: "https://bank.example.test/session",
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    hasPostData: true,
    body: "{}",
  });
  await until(() => emitted.length === 1, "the event");
  expect(value(emitted[0]).request.body.status).toBe("truncated");
  expect(leaked(emitted)).toEqual([]);
});

test("the verification code a sign-in posts, and the code an OAuth callback carries, never leave through the debugger", async () => {
  clock.mockReturnValue(CODE_CLOCK);
  await capture.start(7, "https://app.example.test/login");
  request(7, {
    id: "1",
    url: "https://app.example.test/api/devices/confirm",
    method: "POST",
    headers: { "content-type": "application/json" },
    postData: '{"verificationCode":"880261","rememberDevice":true}',
    body: '{"code":"NOT_FOUND","message":"No pending sign-in"}',
  });
  request(7, {
    id: "2",
    url: "https://app.example.test/integrations/slack?code=SplxlOBeZQQYbYS6WxSbIA&state=af0ifjsldkj",
    body: '{"ok":true}',
  });
  request(7, {
    id: "3",
    url: "https://id.example.test/oauth/token",
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    postData:
      "grant_type=authorization_code&code=Q7XK2MPLOK&code_verifier=dBjftJeZ4CVPmB92K27uhbUJU1p1r",
    body: '{"token_type":"Bearer","expires_in":3600}',
  });
  await until(() => emitted.length === 3, "the events");
  const text = recordedText(emitted);
  for (const secret of [
    "880261",
    "SplxlOBeZQQYbYS6WxSbIA",
    "af0ifjsldkj",
    "Q7XK2MPLOK",
    "dBjftJeZ4CVPmB92K27uhbUJU1p1r",
  ])
    expect([secret, text.includes(secret)]).toEqual([secret, false]);
  const [confirm] = emitted;
  expect(JSON.parse(value(confirm).request.body.text as string)).toEqual({
    verificationCode: "[redacted]",
    rememberDevice: true,
  });
  // An ordinary response code on an address that is no sign-in endpoint survives.
  expect(JSON.parse(value(confirm).response.body.text as string)).toEqual({
    code: "NOT_FOUND",
    message: "No pending sign-in",
  });
});

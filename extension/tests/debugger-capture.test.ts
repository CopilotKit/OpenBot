import {
  afterEach,
  beforeEach,
  expect,
  type Mock,
  spyOn,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CapturedEvent,
  normaliseSecret,
  sha256HexSync,
} from "@openbot/shared/recorder-masking";
import type { AgentObservation } from "../src/background/agent/observation";
import {
  createNetworkCapture,
  type NetworkCapture,
  type NetworkMode,
} from "../src/background/network";
import type { PageFallback } from "../src/background/network/fallback";
import type { StepCall } from "../src/background/steps";
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

/** A write's exchange as the steps get it (steps.ts StepCall), seen as the request a step would carry. */
type Value = {
  method: string;
  url: string;
  status: number | null;
  request: { body: Record<string, unknown> };
  response: { body: Record<string, unknown> };
};

let fake: ChromeFake;
let capture: NetworkCapture;
/** Every call the capture handed to the steps, reads included. */
let calls: StepCall[] = [];
/** The writes among them, each as the request a step would carry. */
let emitted: CapturedEvent[] = [];
/** The writes the capture said were in flight, and the ones it said ended. */
let started: string[] = [];
let ended: string[] = [];
let statuses: [NetworkMode | "stopped", string | undefined][] = [];
/** What the capture handed the agent events. */
let agentSeen: AgentObservation[] = [];
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
  calls = [];
  emitted = [];
  started = [];
  ended = [];
  statuses = [];
  agentSeen = [];
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
  capture = createNetworkCapture(captureDeps(), { fallback });
});

function captureDeps() {
  return {
    openbotUrl: () => OPENBOT,
    call: (call: StepCall) => {
      calls.push(call);
      if (call.exchange)
        emitted.push({
          type: "CUSTOM",
          name: "network",
          timestamp: call.endedAt,
          value: {
            method: call.method,
            url: call.exchange.url,
            status: call.exchange.status,
            request: { body: call.exchange.body },
            response: { body: call.exchange.response },
          },
        });
    },
    writeStarted: (id: string) => started.push(id),
    writeEnded: (id: string) => ended.push(id),
    agent: (observation: AgentObservation) => agentSeen.push(observation),
    status: (mode: NetworkMode | "stopped", reason?: string) =>
      statuses.push([mode, reason]),
    digests: () => digests,
  };
}

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
  /** Seconds since the epoch the request was sent (CDP's wallTime); SENT unless a test says otherwise. */
  wallTime?: number;
  /** How long it ran, in seconds (0.25 unless a test says otherwise). */
  duration?: number;
};

/** When the requests below are sent, unless a test says otherwise (CDP's wallTime, in seconds). */
const SENT = Math.floor(Date.now() / 1000);

/** A request as Chrome reports it: sent, answered, then finished (or failed). A POST unless the spec names a method: a
 * write's bodies are read, a read's never are. */
function request(tabId: number, spec: RequestSpec) {
  const target = spec.sessionId
    ? { tabId, sessionId: spec.sessionId }
    : { tabId };
  const type = spec.type ?? "Fetch";
  const wallTime = spec.wallTime ?? SENT;
  // CDP's monotonic clock, in step with the wall clock.
  const sentAt = 100 + (wallTime - SENT);
  const endAt = sentAt + (spec.duration ?? 0.25);
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
      method: spec.method ?? "POST",
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

test("a write reaches the steps masked, its headers left out and its credentials removed before it leaves", async () => {
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
  await until(() => emitted.length === 1, "the write");
  const [call] = calls;
  expect(call).toMatchObject({
    tabId: 7,
    method: "PUT",
    url: "https://api.example.test/v1/deals/42?token=[redacted]",
    startedAt: SENT * 1000,
    respondedAt: SENT * 1000 + 250,
    endedAt: SENT * 1000 + 250,
  });
  expect(value(emitted[0])).toMatchObject({
    method: "PUT",
    url: "https://api.example.test/v1/deals/42?token=[redacted]",
    status: 200,
  });
  expect(JSON.parse(value(emitted[0]).request.body.text as string)).toEqual({
    stage: "won",
    password: "[redacted]",
  });
  expect(JSON.parse(value(emitted[0]).response.body.text as string)).toEqual({
    ok: true,
    token: "[redacted]",
  });
  // A step carries a save's address, status and bodies: never a header.
  expect(Object.keys(calls[0]?.exchange ?? {}).sort()).toEqual([
    "body",
    "response",
    "status",
    "url",
  ]);
  expect(leakedSecrets(emitted, ["Bearer s", "a=b", "Authorization"])).toEqual(
    [],
  );
  expect(statuses).toEqual([["debugger", undefined]]);
});

test("a read reaches the steps with when it ran and nothing of its bodies, which are never read", async () => {
  await capture.start(7, "https://crm.example.test/");
  request(7, {
    id: "1",
    url: "https://crm.example.test/api/deals?token=abc",
    method: "GET",
    body: "[]",
  });
  request(7, {
    id: "2",
    url: "https://crm.example.test/api/me",
    method: "GET",
    type: "XHR",
    body: "{}",
  });
  await until(() => calls.length === 2, "two reads");
  expect(calls).toEqual([
    {
      tabId: 7,
      method: "GET",
      url: "https://crm.example.test/api/deals?token=[redacted]",
      startedAt: SENT * 1000,
      respondedAt: SENT * 1000 + 250,
      endedAt: SENT * 1000 + 250,
    },
    {
      tabId: 7,
      method: "GET",
      url: "https://crm.example.test/api/me",
      startedAt: SENT * 1000,
      respondedAt: SENT * 1000 + 250,
      endedAt: SENT * 1000 + 250,
    },
  ]);
  expect(commandsTo("Network.getResponseBody")).toEqual([]);
  expect(started).toEqual([]);
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

test("calls to OpenBot itself are ignored, by the steps and by the agent events alike", async () => {
  await capture.start(7, "https://crm.example.test/");
  // The Recorder's own capture pass and connect code, had a tab made them: a pass answers join credentials as an
  // Intelligence run does, and neither is ever followed.
  request(7, {
    id: "1",
    url: `${OPENBOT}/api/copilotkit/trajectory/x/connect`,
    method: "POST",
    postData: "{}",
    body: '{"joinToken":"join-token-1","realtime":{"clientUrl":"wss://intelligence.example.test/client","topic":"trajectory:x"}}',
  });
  request(7, {
    id: "3",
    url: `${OPENBOT}/api/recorder/connect-codes`,
    method: "POST",
    postData: "{}",
    body: '{"code":"obc_live_connect_code"}',
  });
  request(7, { id: "2", url: "https://crm.example.test/api", body: "{}" });
  await until(() => emitted.length === 1, "one event");
  await settle();
  expect(value(emitted[0]).url).toBe("https://crm.example.test/api");
  expect(agentSeen).toEqual([]);
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
    emitted.map((event) => [value(event).url, value(event).status]),
  ).toEqual([["https://crm.example.test/api/a", null]]);
  expect(value(emitted[0]).response.body).toEqual({
    status: "unavailable",
    reason: "no-response",
  });
});

test("a large body reaches the steps whole, for the step to cut to fit, and is never sent or stored anywhere else", async () => {
  await capture.start(7, "https://crm.example.test/");
  request(7, {
    id: "1",
    url: "https://crm.example.test/api/rows",
    body: JSON.stringify({ rows: "x".repeat(200 * 1024) }),
  });
  await until(() => emitted.length === 1, "the write");
  expect(value(emitted[0]).response.body).toMatchObject({
    status: "complete",
  });
  expect(String(value(emitted[0]).response.body.text).length).toBeGreaterThan(
    200 * 1024,
  );
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
    "You closed Chrome's debugging bar, so what each step saves is no longer recorded.",
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

test("a tab whose page commits while it is being attached is attached once, and captures", async () => {
  // A tab the person switched to joins at the page it shows while that page is still committing (a tab the browser
  // discarded loads again when it is switched to): the commit came while the attach was under way, attached a second
  // time, and Chrome's refusal of the second marked the tab refused, so none of its calls were recorded.
  await capture.start(7, "https://crm.example.test/");
  const joining = capture.addTab(8, "https://crm.example.test/report");
  const committing = capture.onCommitted(
    8,
    0,
    "https://crm.example.test/report",
  );
  await Promise.all([joining, committing]);
  expect(fake.debugger.attached).toEqual([{ tabId: 7 }, { tabId: 8 }]);
  request(8, { id: "1", url: "https://crm.example.test/api", body: "{}" });
  await until(() => emitted.length === 1, "tab 8's call");
});

test("a recording started on the New Tab page attaches once the tab opens a website", async () => {
  expect(await capture.start(7, "chrome://newtab/")).toBe("waiting");
  expect(statuses).toEqual([
    [
      "waiting",
      "What each step saves is recorded once this tab opens a website.",
    ],
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
    "Chrome would not let the Recorder see what each step saves here (Cannot attach to this target.).",
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
  capture = createNetworkCapture(captureDeps(), { fallback });
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

test("a page-level write reaches the steps with its exchange, a read with when it ran", async () => {
  await capture.start(7, "https://crm.example.test/");
  const now = Date.now();
  const pageCall = (method: string, url: string): CapturedEvent => ({
    type: "CUSTOM",
    name: "network",
    timestamp: now,
    value: {
      transport: "fetch",
      method,
      url,
      status: 200,
      outcome: "ok",
      completedAt: now,
      durationMs: 20,
      capturedBy: "page",
      request: {
        headers: { "content-type": "application/json" },
        body: { status: "complete", text: '{"name":"Acme"}' },
      },
      response: {
        headers: { "content-type": "application/json" },
        body: { status: "complete", text: '{"id":1}' },
      },
    },
  });
  await capture.recordPageEvent(
    7,
    pageCall("POST", "https://crm.example.test/api/companies"),
  );
  await capture.recordPageEvent(
    7,
    pageCall("GET", "https://crm.example.test/api/companies/1"),
  );
  expect(calls).toEqual([
    {
      tabId: 7,
      startedAt: now - 20,
      endedAt: now,
      method: "POST",
      url: "https://crm.example.test/api/companies",
      exchange: {
        url: "https://crm.example.test/api/companies",
        status: 200,
        body: { status: "complete", text: '{"name":"Acme"}' },
        response: { status: "complete", text: '{"id":1}' },
      },
    },
    {
      tabId: 7,
      startedAt: now - 20,
      endedAt: now,
      method: "GET",
      url: "https://crm.example.test/api/companies/1",
    },
  ]);
});

test("a page-level event for a call to OpenBot itself is dropped, like the debugger drops it", async () => {
  await capture.start(7, "https://crm.example.test/");
  const now = Date.now();
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
  expect(calls.map((call) => call.url)).toEqual([
    "https://crm.example.test/api",
  ]);
});

// ---- The screens: what never reaches the steps -------------------------------------------------

test("telemetry, a beacon, a prefetch, a cancelled call, a repeat, an iframe's document and images never reach the steps", async () => {
  fake.tabs.set(7, {
    id: 7,
    url: "https://crm.example.test/deals/42",
  } as chrome.tabs.Tab);
  await capture.start(7, "https://crm.example.test/deals/42");
  request(7, {
    id: "poll-1",
    url: "https://crm.example.test/api/unread",
    method: "GET",
    body: "{}",
    wallTime: SENT - 10,
  });
  request(7, {
    id: "note",
    url: "https://crm.example.test/api/deals/42/notes",
    headers: { "content-type": "application/json" },
    postData: '{"text":"Call back Tuesday"}',
    body: '{"id":7}',
  });
  request(7, {
    id: "poll-2",
    url: "https://crm.example.test/api/unread",
    method: "GET",
    body: "{}",
  });
  request(7, {
    id: "ga",
    url: "https://www.google-analytics.com/g/collect?v=2&en=click",
  });
  request(7, {
    id: "beacon",
    url: "https://crm.example.test/api/events",
    type: "Ping",
  });
  request(7, {
    id: "prefetch",
    url: "https://crm.example.test/deals/43",
    method: "GET",
    headers: { "next-router-prefetch": "1", rsc: "1" },
    body: "{}",
  });
  request(7, {
    id: "cancelled",
    url: "https://crm.example.test/api/search?q=a",
    failed: { canceled: true },
  });
  request(7, {
    id: "img",
    url: "https://crm.example.test/logo.png",
    method: "GET",
    type: "Image",
    mimeType: "image/png",
  });
  request(7, {
    id: "frame-doc",
    url: "https://widgets.example.test/embed",
    method: "GET",
    type: "Document",
    frameId: "frame-1",
    sessionId: "frame-session",
    mimeType: "text/html",
    body: "<html></html>",
  });
  request(7, {
    id: "frame-ad",
    url: "https://securepubads.g.doubleclick.net/gampad/ads?iu=x",
    sessionId: "frame-session",
  });
  await until(() => calls.length === 2, "the two calls that pass");
  await settle();
  expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
    "GET https://crm.example.test/api/unread",
    "POST https://crm.example.test/api/deals/42/notes",
  ]);
  // Only the note's bodies were read: nothing screened out cost a body read.
  expect(
    commandsTo("Network.getResponseBody").map(
      (command) => (command.params as { requestId: string }).requestId,
    ),
  ).toEqual(["note"]);
});

test("CopilotKit's own capture batch is never a step's save, through the debugger or the page, its body inline or read late", async () => {
  // The batches end-to-end runs 1 and 2 attached to Send and to Approve as their save.
  const [send, , approve] = (
    JSON.parse(
      readFileSync(
        join(import.meta.dir, "fixtures/e2e-learning-batches.json"),
        "utf8",
      ),
    ) as { batches: { url: string; body: string; response: string }[] }
  ).batches;
  if (!send || !approve) throw new Error("the fixture's batches");
  const json = { "content-type": "application/json" };
  await capture.start(7, "http://127.0.0.1:7620/learning/deals/deal-1");
  request(7, {
    id: "batch",
    url: send.url,
    headers: json,
    postData: send.body,
    body: send.response,
  });
  // A batch past the 64 KiB Chrome sends inline, posted to a route the app chose: its body is read, then screened.
  postData.late = approve.body;
  request(7, {
    id: "late",
    url: "http://127.0.0.1:7620/api/copilot-capture",
    headers: json,
    hasPostData: true,
    body: approve.response,
  });
  request(7, {
    id: "note",
    url: "http://127.0.0.1:7620/api/deals/deal-1/notes",
    headers: json,
    postData: '{"text":"Approved without the agent"}',
    body: '{"id":7}',
  });
  await until(
    () => calls.some((call) => call.url.endsWith("/notes")),
    "the note",
  );
  // The inline batch is screened as it starts, so no step ever waits for it; the one read late waits until it is read.
  await until(() => ended.length === 2, "every write ended");
  await settle();
  expect([...started].sort()).toEqual(["7//late", "7//note"]);
  // The page hook's copy of the same batch, masked as the page sends it.
  const now = Date.now();
  await capture.recordPageEvent(7, {
    type: "CUSTOM",
    name: "network",
    timestamp: now,
    value: {
      transport: "fetch",
      method: "POST",
      url: send.url,
      status: 200,
      outcome: "ok",
      completedAt: now,
      durationMs: 20,
      capturedBy: "page",
      request: {
        headers: json,
        body: { status: "complete", text: send.body },
      },
      response: {
        headers: json,
        body: { status: "complete", text: send.response },
      },
    },
  });
  expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
    "POST http://127.0.0.1:7620/api/deals/deal-1/notes",
  ]);
  expect([...started].sort()).toEqual([...ended].sort());
});

test("a write is in flight from its start until the steps have it; one the screens drop as it starts never is", async () => {
  await capture.start(7, "https://crm.example.test/");
  fake.debugger.emit({ tabId: 7 }, "Network.requestWillBeSent", {
    requestId: "w1",
    type: "Fetch",
    timestamp: 100,
    wallTime: SENT,
    request: {
      url: "https://crm.example.test/api/save",
      method: "POST",
      headers: {},
      postData: "{}",
    },
  });
  fake.debugger.emit({ tabId: 7 }, "Network.requestWillBeSent", {
    requestId: "r1",
    type: "Fetch",
    timestamp: 100,
    wallTime: SENT,
    request: {
      url: "https://crm.example.test/api/me",
      method: "GET",
      headers: {},
    },
  });
  expect(started).toEqual(["7//w1"]);
  expect(ended).toEqual([]);
  bodies.w1 = { body: "{}", base64Encoded: false };
  fake.debugger.emit({ tabId: 7 }, "Network.responseReceived", {
    requestId: "w1",
    type: "Fetch",
    timestamp: 100.2,
    response: {
      url: "https://crm.example.test/api/save",
      status: 200,
      headers: { "content-type": "application/json" },
      mimeType: "application/json",
    },
  });
  fake.debugger.emit({ tabId: 7 }, "Network.loadingFinished", {
    requestId: "w1",
    timestamp: 100.2,
  });
  await until(() => ended.length === 1, "the write's end");
  // The steps had the write before they heard it ended.
  expect(calls.map((call) => call.url)).toEqual([
    "https://crm.example.test/api/save",
  ]);
  request(7, {
    id: "w2",
    url: "https://www.google-analytics.com/g/collect",
  });
  await settle();
  expect(started).toEqual(["7//w1"]);
  expect(ended).toEqual(["7//w1"]);
  expect(calls).toHaveLength(1);
});

test("a form the person posts in the top frame reaches the steps as a document request; an iframe's document never does", async () => {
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
    method: "POST",
    type: "Document",
    frameId: "child-frame",
    mimeType: "text/html",
    body: "<html></html>",
  });
  await until(() => emitted.length === 1, "the form post");
  await settle();
  expect(value(emitted[0])).toMatchObject({
    method: "POST",
    url: "https://crm.example.test/session",
  });
  expect(value(emitted[0]).request.body.text).toBe(
    "user=ada&password=[redacted]",
  );
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

test("a tab on a site the person keeps out of their recordings is never attached to, until it reaches another site", async () => {
  await capture.stop();
  capture = createNetworkCapture(
    {
      ...captureDeps(),
      recordable: (url: string) => !url.startsWith("https://bank.example.test"),
    },
    { fallback },
  );
  expect(await capture.start(7, "https://bank.example.test/accounts")).toBe(
    "waiting",
  );
  expect(fake.debugger.attached).toEqual([]);
  await capture.onCommitted(7, 0, "https://bank.example.test/transfers");
  expect(fake.debugger.attached).toEqual([]);
  await capture.onCommitted(7, 0, "https://crm.example.test/deals");
  expect(fake.debugger.attached).toEqual([{ tabId: 7 }]);
});

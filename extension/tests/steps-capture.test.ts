// The capture and the steps together, as the recording runs them: what Chrome reports about a click amid the page's
// noise reaches Intelligence only as that click's save, on both capture paths.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import {
  createNetworkCapture,
  type NetworkCapture,
} from "../src/background/network";
import type { PageFallback } from "../src/background/network/fallback";
import {
  createStepAssembler,
  type StepAssembler,
} from "../src/background/steps";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";
import { CARD_AND_PIN_CLOCK, leakedSecrets } from "./support/recorded-text";

const OPENBOT = "https://openbot.example.test";
/** When each test begins, in seconds since the epoch: the pinned clock, from which the steps' own clock runs on. */
const CLICK = CARD_AND_PIN_CLOCK / 1000;
/** The steps' timing, shortened so a test runs in a moment; every rule is the same. */
const TIMING = {
  windowMs: 400,
  chainGapMs: 100,
  maxDepth: 2,
  horizonMs: 600,
  leadMs: 100,
  settleMs: 150,
  redirectMs: 50,
  inflightCapMs: 3_000,
};

let fake: ChromeFake;
let capture: NetworkCapture;
let steps: StepAssembler;
let sent: CapturedEvent[] = [];
let bodies: Record<string, string> = {};
let clock: { mockRestore(): void };

const pageFallback: PageFallback = {
  start: async () => true,
  addTab: async () => {},
  onCommitted: async () => {},
  stop: async () => {},
  active: () => false,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string) {
  const deadline = performance.now() + 3_000;
  while (!check()) {
    if (performance.now() > deadline)
      throw new Error(`Timed out waiting: ${label}`);
    await sleep(2);
  }
}

beforeEach(() => {
  clock = spyOn(Date, "now").mockReturnValue(CARD_AND_PIN_CLOCK);
  fake = installChromeFake({ extensionId: "test" });
  sent = [];
  bodies = {};
  fake.debugger.respond("Network.getResponseBody", (params) => {
    const body = bodies[(params as { requestId: string }).requestId];
    if (body === undefined)
      throw new Error("No resource with given identifier found");
    return { body, base64Encoded: false };
  });
  // Date.now() stays pinned for the leak checks; the steps run on a clock that starts there and moves on.
  const began = performance.now();
  steps = createStepAssembler({
    emit: (event) => sent.push(event),
    now: () => CARD_AND_PIN_CLOCK + (performance.now() - began),
    tuning: TIMING,
  });
  capture = createNetworkCapture(
    {
      openbotUrl: () => OPENBOT,
      call: (call) => steps.call(call),
      writeStarted: (id, tabId, startedAt) =>
        steps.writeStarted(id, tabId, startedAt),
      writeEnded: (id) => steps.writeEnded(id),
      status: () => {},
      digests: () => new Set(),
      agent: () => {},
    },
    { fallback: pageFallback },
  );
});

afterEach(async () => {
  await capture.stop();
  steps.clear();
  fake.uninstall();
  clock.mockRestore();
});

/** A request as Chrome reports it, `at` seconds after the click. */
function request(spec: {
  id: string;
  url: string;
  at: number;
  method?: string;
  type?: string;
  headers?: Record<string, string>;
  postData?: string;
  body?: string;
  sessionId?: string;
  canceled?: boolean;
}) {
  const target = spec.sessionId
    ? { tabId: 7, sessionId: spec.sessionId }
    : { tabId: 7 };
  const type = spec.type ?? "Fetch";
  if (spec.body !== undefined) bodies[spec.id] = spec.body;
  fake.debugger.emit(target, "Network.requestWillBeSent", {
    requestId: spec.id,
    type,
    timestamp: 100 + spec.at,
    wallTime: CLICK + spec.at,
    request: {
      url: spec.url,
      method: spec.method ?? "GET",
      headers: spec.headers ?? {},
      ...(spec.postData !== undefined ? { postData: spec.postData } : {}),
    },
  });
  if (spec.canceled) {
    fake.debugger.emit(target, "Network.loadingFailed", {
      requestId: spec.id,
      timestamp: 100 + spec.at + 0.05,
      type,
      canceled: true,
    });
    return;
  }
  fake.debugger.emit(target, "Network.responseReceived", {
    requestId: spec.id,
    type,
    timestamp: 100 + spec.at + 0.08,
    response: {
      url: spec.url,
      status: 200,
      headers: { "content-type": "application/json" },
      mimeType: "application/json",
    },
  });
  fake.debugger.emit(target, "Network.loadingFinished", {
    requestId: spec.id,
    timestamp: 100 + spec.at + 0.08,
  });
}

const step = (
  name: string,
  at: number,
  value: Record<string, unknown>,
): CapturedEvent => ({
  type: "CUSTOM",
  name,
  timestamp: Math.round((CLICK + at) * 1000),
  value: value as CapturedEvent["value"],
});

const saves = () =>
  sent.map((event) => {
    const saved = (event.value as { request?: { method: string; url: string } })
      .request;
    return saved ? `${saved.method} ${new URL(saved.url).pathname}` : null;
  });

test("through the debugger, a click amid the page's noise carries only its save, and steps stay in order", async () => {
  await capture.start(7, "https://crm.example.test/deals/42");
  // The page polls before the person does anything.
  request({
    id: "poll-1",
    url: "https://crm.example.test/api/unread",
    at: -5,
    body: "{}",
  });
  steps.step(
    7,
    step("click", 0, {
      step: "click",
      target: { tag: "button", role: "button", name: "Mark as read" },
    }),
  );
  // Around the click, all the page's own: the poll again, analytics, a beacon, a prefetch, a cancelled search, a
  // configuration read through a POST, and an ad in an iframe.
  request({
    id: "poll-2",
    url: "https://crm.example.test/api/unread",
    at: 0.05,
    body: "{}",
  });
  request({
    id: "ga",
    url: "https://www.google-analytics.com/g/collect?v=2",
    method: "POST",
    at: 0.06,
  });
  request({
    id: "beacon",
    url: "https://crm.example.test/api/events",
    method: "POST",
    type: "Ping",
    at: 0.07,
  });
  request({
    id: "prefetch",
    url: "https://crm.example.test/deals/43",
    headers: { "next-router-prefetch": "1" },
    at: 0.08,
    body: "{}",
  });
  request({
    id: "search",
    url: "https://crm.example.test/api/search?q=a",
    method: "POST",
    at: 0.09,
    canceled: true,
  });
  request({
    id: "config",
    url: "https://crm.example.test/api/user-attributes/fetch",
    method: "POST",
    postData: '{"keys":["theme"]}',
    at: 0.1,
    body: '{"theme":"dark"}',
  });
  request({
    id: "ad",
    url: "https://securepubads.g.doubleclick.net/gampad/ads?iu=x",
    method: "POST",
    sessionId: "frame-session",
    at: 0.11,
  });
  // The click's own save.
  request({
    id: "read",
    url: "https://crm.example.test/api/notifications/9/MARKED_AS_READ",
    method: "PUT",
    at: 0.12,
    body: '{"ok":true}',
  });
  // The next step, a page change after it, and a later step that saves nothing.
  steps.step(
    7,
    step("click", 0.5, {
      step: "click",
      target: { tag: "a", role: "link", name: "Contacts" },
    }),
  );
  steps.navigation(
    7,
    step("navigation", 0.55, {
      step: "navigate",
      to: "https://crm.example.test/contacts",
    }),
  );
  steps.step(
    7,
    step("click", 0.8, {
      step: "click",
      target: { tag: "a", role: "link", name: "Ada Lovelace" },
    }),
  );
  await until(() => sent.length === 4, "every step");
  expect(sent.map((event) => (event.value as { step: string }).step)).toEqual([
    "click",
    "click",
    "navigate",
    "click",
  ]);
  expect(saves()).toEqual([
    "PUT /api/notifications/9/MARKED_AS_READ",
    null,
    null,
    null,
  ]);
  // Only the save had its bodies read: nothing else was ever more than a time.
  expect(
    fake.debugger.commands
      .filter((command) => command.method === "Network.getResponseBody")
      .map((command) => (command.params as { requestId: string }).requestId)
      .sort(),
  ).toEqual(["config", "read"]);
  expect(sent.filter((event) => event.name === "network")).toEqual([]);
});

test("through the debugger, a typed form's submit carries the request holding the typed values, not the draft save before it", async () => {
  await capture.start(7, "https://crm.example.test/companies/new");
  steps.step(
    7,
    step("input", 0, {
      step: "change",
      eventType: "change",
      target: { tag: "input", name: "Name", value: "Acme Holdings" },
    }),
  );
  steps.step(
    7,
    step("input", 0.3, {
      step: "change",
      eventType: "change",
      target: { tag: "input", name: "City", value: "Lyon" },
    }),
  );
  steps.step(
    7,
    step("submit", 0.6, {
      step: "submit",
      target: { tag: "form", role: "form", name: "New company" },
    }),
  );
  request({
    id: "draft",
    url: "https://crm.example.test/api/drafts/save",
    method: "POST",
    postData: '{"draft":true}',
    at: 0.62,
    body: "{}",
  });
  request({
    id: "create",
    url: "https://crm.example.test/api/companies",
    method: "POST",
    headers: { "content-type": "application/json" },
    postData: '{"name":"Acme Holdings","city":"Lyon","password":"x"}',
    at: 0.65,
    body: '{"id":81}',
  });
  await until(() => sent.length === 3, "the three steps");
  expect(saves()).toEqual([null, null, "POST /api/companies"]);
  const save = (sent[2]?.value ?? {}) as {
    request: { body: { text: string } };
  };
  // Masked as every request is.
  expect(JSON.parse(save.request.body.text)).toEqual({
    name: "Acme Holdings",
    city: "Lyon",
    password: "[redacted]",
  });
});

test("through the page-level hook, a click amid the page's noise carries only its save", async () => {
  await capture.start(7, "https://crm.example.test/deals/42");
  const page = (
    method: string,
    url: string,
    at: number,
    body?: string,
  ): CapturedEvent => ({
    type: "CUSTOM",
    name: "network",
    timestamp: Math.round((CLICK + at) * 1000) + 80,
    value: {
      method,
      url,
      status: 200,
      outcome: "ok",
      completedAt: Math.round((CLICK + at) * 1000) + 80,
      durationMs: 80,
      capturedBy: "page",
      request: {
        headers: {},
        body:
          body === undefined
            ? { status: "empty" }
            : { status: "complete", text: body },
      },
      response: {
        headers: {},
        body: { status: "complete", text: '{"ok":true}' },
      },
    },
  });
  await capture.recordPageEvent(
    7,
    page("GET", "https://crm.example.test/api/unread", -5),
  );
  steps.step(
    7,
    step("click", 0, {
      step: "click",
      target: { tag: "button", role: "button", name: "Send" },
    }),
  );
  for (const event of [
    page("GET", "https://crm.example.test/api/unread", 0.02),
    page("POST", "https://eu.i.posthog.com/e/", 0.03, "{}"),
    page(
      "POST",
      "https://crm.example.test/api/user-attributes/fetch",
      0.04,
      '{"keys":["theme"]}',
    ),
    page(
      "POST",
      "https://crm.example.test/rpc/com.example.EngineService/sendMessage",
      0.1,
      '{"message":"hi"}',
    ),
  ])
    await capture.recordPageEvent(7, event);
  await until(() => sent.length === 1, "the click");
  expect(saves()).toEqual(["POST /rpc/com.example.EngineService/sendMessage"]);
  expect(leakedSecrets(sent, ["theme", "posthog"])).toEqual([]);
});

test("a step waits for its save still in flight through the debugger, then carries it", async () => {
  await capture.start(7, "https://crm.example.test/deals/42");
  steps.step(
    7,
    step("click", 0, {
      step: "click",
      target: { tag: "button", role: "button", name: "Send" },
    }),
  );
  fake.debugger.emit({ tabId: 7 }, "Network.requestWillBeSent", {
    requestId: "slow",
    type: "Fetch",
    timestamp: 100.05,
    wallTime: CLICK + 0.05,
    request: {
      url: "https://crm.example.test/api/messages/send",
      method: "POST",
      headers: {},
      postData: "{}",
    },
  });
  await sleep(TIMING.horizonMs + TIMING.settleMs + 300);
  // Its window closed, the step still waits for the save.
  expect(sent).toEqual([]);
  bodies.slow = '{"turn":1}';
  fake.debugger.emit({ tabId: 7 }, "Network.responseReceived", {
    requestId: "slow",
    type: "Fetch",
    timestamp: 101.5,
    response: {
      url: "https://crm.example.test/api/messages/send",
      status: 200,
      headers: { "content-type": "application/json" },
      mimeType: "application/json",
    },
  });
  fake.debugger.emit({ tabId: 7 }, "Network.loadingFinished", {
    requestId: "slow",
    timestamp: 101.5,
  });
  await until(() => sent.length === 1, "the step with its save");
  expect(saves()).toEqual(["POST /api/messages/send"]);
});

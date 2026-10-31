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

// ---- Saves the end-to-end run left off its steps, and steps it held -------------------------------------------------

/** A request of the tab's top frame's own document (a link followed, a form posted), as Chrome reports a navigation:
 * its request id is its loader's, and a redirect comes as a second requestWillBeSent for the same id carrying the
 * redirect's response. */
function documentRequest(spec: {
  id: string;
  at: number;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  postData?: string;
  redirect?: { at: number; status: number; to: string };
  respondedAt: number;
}) {
  const target = { tabId: 7 };
  const base = {
    requestId: spec.id,
    loaderId: spec.id,
    type: "Document",
    frameId: "target-7",
    initiator: { type: "other" },
  };
  fake.debugger.emit(target, "Network.requestWillBeSent", {
    ...base,
    documentURL: spec.url,
    timestamp: 100 + spec.at,
    wallTime: CLICK + spec.at,
    request: {
      url: spec.url,
      method: spec.method ?? "GET",
      headers: spec.headers ?? {},
      ...(spec.postData !== undefined
        ? { postData: spec.postData, hasPostData: true }
        : {}),
    },
  });
  let url = spec.url;
  if (spec.redirect) {
    fake.debugger.emit(target, "Network.requestWillBeSent", {
      ...base,
      documentURL: spec.redirect.to,
      timestamp: 100 + spec.redirect.at,
      wallTime: CLICK + spec.redirect.at,
      redirectHasExtraInfo: true,
      redirectResponse: {
        url: spec.url,
        status: spec.redirect.status,
        statusText: "See Other",
        headers: {
          "content-type": "text/html;charset=utf-8",
          "content-length": "0",
          location: spec.redirect.to,
          server: "Heroku",
        },
        mimeType: "text/html",
      },
      request: { url: spec.redirect.to, method: "GET", headers: {} },
    });
    url = spec.redirect.to;
  }
  bodies[spec.id] = "<html><body>The Internet</body></html>";
  fake.debugger.emit(target, "Network.responseReceived", {
    ...base,
    timestamp: 100 + spec.respondedAt,
    response: {
      url,
      status: 200,
      headers: { "content-type": "text/html;charset=utf-8" },
      mimeType: "text/html",
    },
  });
  fake.debugger.emit(target, "Network.loadingFinished", {
    requestId: spec.id,
    timestamp: 100 + spec.respondedAt + 0.01,
  });
}

/** A write the page starts and Chrome never reports again: its page went away under it. */
function abandonedWrite(spec: {
  id: string;
  at: number;
  url: string;
  method: string;
  postData: string;
}) {
  fake.debugger.emit({ tabId: 7 }, "Network.requestWillBeSent", {
    requestId: spec.id,
    loaderId: "page-loader",
    type: "Fetch",
    frameId: "target-7",
    timestamp: 100 + spec.at,
    wallTime: CLICK + spec.at,
    request: {
      url: spec.url,
      method: spec.method,
      headers: { "content-type": "application/json" },
      postData: spec.postData,
    },
  });
}

const followTab = (url: string) =>
  fake.tabs.set(7, { id: 7, url, title: "" } as chrome.tabs.Tab);

test("archiving the same order twice is two saves: a write the tab already made is the person's, never screened as the page's repeat", async () => {
  // End-to-end run 5, rows 57006 and 57015: the second Archive order, the same PATCH with the same body, carried nothing.
  followTab("http://127.0.0.1:7420/orders/1043");
  await capture.start(7, "http://127.0.0.1:7420/orders/1043");
  const archive = (at: number) => {
    steps.step(
      7,
      step("click", at, {
        step: "click",
        target: { tag: "button", ariaRole: "button", name: "Archive order" },
      }),
    );
    request({
      id: `archive-${at}`,
      url: "http://127.0.0.1:7420/api/orders/1043",
      method: "PATCH",
      headers: { "content-type": "application/json" },
      postData: '{"archived":true}',
      at: at + 0.002,
      body: `{"id":1043,"archived":true,"archivedAt":"2026-10-21T02:2${at}:35.252Z"}`,
    });
    // The page's polling, the same read each time: still the page's own repeat.
    request({
      id: `poll-${at}`,
      url: "http://127.0.0.1:7420/api/notifications/count",
      at: at + 0.05,
      body: '{"unread":2}',
    });
  };
  archive(0);
  archive(0.7);
  await until(() => sent.length === 2, "both clicks");
  expect(saves()).toEqual(["PATCH /api/orders/1043", "PATCH /api/orders/1043"]);
});

test("a one-time code checked, a phone confirmed and a backup code redeemed are each their step's save, the code redacted", async () => {
  // End-to-end run 1, rows 8072 to 8092: the shop's three code forms. Each code arrives redacted in its edit and its
  // request, so neither matches the other, and none of verify, confirm or redeem was a word for a save.
  followTab("http://127.0.0.1:7420/security");
  await capture.start(7, "http://127.0.0.1:7420/security");
  const form = (
    at: number,
    field: string,
    button: string,
    path: string,
    body: string,
  ) => {
    steps.step(
      7,
      step("input", at, {
        step: "input",
        eventType: "input",
        target: {
          tag: "input",
          ariaRole: "textbox",
          name: field,
          value: "[redacted]",
        },
      }),
    );
    steps.step(
      7,
      step("click", at + 0.1, {
        step: "click",
        target: {
          tag: "button",
          ariaRole: "button",
          name: button,
          input: "keyboard",
        },
      }),
    );
    request({
      id: path,
      url: `http://127.0.0.1:7420${path}`,
      method: "POST",
      headers: { "content-type": "application/json" },
      postData: body,
      at: at + 0.105,
      body: '{"verified":true,"accessToken":"[redacted]"}',
    });
  };
  form(
    0,
    "Code from your authenticator app",
    "Verify app",
    "/api/mfa/verify",
    '{"code":"[redacted]","method":"app"}',
  );
  form(
    0.5,
    "Enter the code we texted you",
    "Confirm phone",
    "/api/phone/confirm",
    '{"phoneNumber":"+44 7700 900123","smsCode":"[redacted]"}',
  );
  form(
    1,
    "Digit 6",
    "Use backup",
    "/api/backup/redeem",
    '{"value":"[redacted]"}',
  );
  await until(() => sent.length === 6, "every step");
  expect(saves()).toEqual([
    null,
    "POST /api/mfa/verify",
    null,
    "POST /api/phone/confirm",
    null,
    "POST /api/backup/redeem",
  ]);
});

test("a form posted as a page load and answered with a redirect is the save of the click that sent it: the-internet's sign-in and password reset", async () => {
  // End-to-end run 2, rows 89010 to 89012 and 89032 to 89034: the-internet.herokuapp.com answers POST /authenticate and
  // POST /forgot_password with 303 See Other, and neither post reached its click.
  followTab("https://the-internet.herokuapp.com/login");
  await capture.start(7, "https://the-internet.herokuapp.com/login");
  steps.step(
    7,
    step("input", -0.6, {
      step: "input",
      eventType: "input",
      target: {
        tag: "input",
        ariaRole: "textbox",
        name: "Username",
        value: "tomsmith",
      },
    }),
  );
  steps.step(
    7,
    step("click", 0, {
      step: "click",
      target: {
        tag: "button",
        ariaRole: "button",
        name: "Login",
        input: "pointer",
      },
    }),
  );
  documentRequest({
    id: "login-loader",
    at: 0.01,
    url: "https://the-internet.herokuapp.com/authenticate",
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    postData: "username=tomsmith&password=SuperSecretPassword%21",
    redirect: {
      at: 0.18,
      status: 303,
      to: "https://the-internet.herokuapp.com/secure",
    },
    respondedAt: 0.3,
  });
  steps.navigation(
    7,
    step("navigation", 0.31, {
      step: "navigate",
      to: "https://the-internet.herokuapp.com/secure",
      navigationType: "push",
      transitionType: "form_submit",
      transitionQualifiers: ["server_redirect"],
    }),
  );
  steps.step(
    7,
    step("input", 0.7, {
      step: "input",
      eventType: "input",
      target: {
        tag: "input",
        ariaRole: "textbox",
        name: "E-mail",
        value: "[redacted]",
      },
    }),
  );
  steps.step(
    7,
    step("click", 0.8, {
      step: "click",
      target: {
        tag: "button",
        ariaRole: "button",
        name: "Retrieve password",
        input: "pointer",
      },
    }),
  );
  documentRequest({
    id: "reset-loader",
    at: 0.81,
    url: "https://the-internet.herokuapp.com/forgot_password",
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    postData: "email=ada%40example.test",
    redirect: {
      at: 0.95,
      status: 303,
      to: "https://the-internet.herokuapp.com/email_sent",
    },
    respondedAt: 1.05,
  });
  await until(() => sent.length === 5, "every step");
  expect(saves()).toEqual([
    null,
    "POST /authenticate",
    null,
    null,
    "POST /forgot_password",
  ]);
  const login = (
    sent[1]?.value as { request?: Record<string, unknown> } | undefined
  )?.request;
  expect(login).toMatchObject({
    method: "POST",
    url: "https://the-internet.herokuapp.com/authenticate",
    status: 303,
    body: { status: "complete", text: "username=tomsmith&password=[redacted]" },
    response: { status: "empty" },
  });
  expect(leakedSecrets(sent, ["SuperSecretPassword"])).toEqual([]);
});

test("a link click whose page sends telemetry on every click leaves once its window closes, not when the in-flight cap runs out", async () => {
  // End-to-end run 1, rows 8019, 8060, 8065, 8068, 8094 and 8113: the shop posts /api/telemetry/events on every click, a
  // link's page change cancels it, and Chrome never reports the cancelled call. Each such click waited out the cap.
  followTab("http://127.0.0.1:7420/orders/1043");
  await capture.start(7, "http://127.0.0.1:7420/orders/1043");
  const began = performance.now();
  steps.step(
    7,
    step("click", 0, {
      step: "click",
      target: {
        tag: "a",
        ariaRole: "link",
        name: "Ceramic mug, blue 1 x 58.20",
      },
    }),
  );
  abandonedWrite({
    id: "telemetry",
    at: 0.002,
    url: "http://127.0.0.1:7420/api/telemetry/events",
    method: "POST",
    postData: '{"type":"click","sid":"k2j3h4","path":"/orders/1043"}',
  });
  documentRequest({
    id: "products-loader",
    at: 0.004,
    url: "http://127.0.0.1:7420/products/7",
    respondedAt: 0.012,
  });
  steps.navigation(
    7,
    step("navigation", 0.013, {
      step: "navigate",
      to: "http://127.0.0.1:7420/products/7",
      navigationType: "push",
      transitionType: "link",
    }),
  );
  await until(() => sent.length >= 1, "the click");
  expect(performance.now() - began).toBeLessThan(TIMING.inflightCapMs / 2);
  expect(saves()[0]).toBeNull();
});

test("a save the page started and its page change cancelled no longer holds the click: the top frame's next document ends it", async () => {
  // A draft the page autosaves as the person follows a link: the new page's answer means the old page, and the save it
  // had in flight, are gone; Chrome sends no loadingFailed for it once that page's document is swapped out.
  followTab("http://127.0.0.1:7420/checkout?order=1043");
  await capture.start(7, "http://127.0.0.1:7420/checkout?order=1043");
  const began = performance.now();
  steps.step(
    7,
    step("click", 0, {
      step: "click",
      target: { tag: "a", ariaRole: "link", name: "Account" },
    }),
  );
  abandonedWrite({
    id: "draft",
    at: 0.003,
    url: "http://127.0.0.1:7420/api/refund-drafts/1043",
    method: "PUT",
    postData: '{"fullName":"Grace Hopper","reason":"Parcel arrived damaged"}',
  });
  documentRequest({
    id: "account-loader",
    at: 0.005,
    url: "http://127.0.0.1:7420/account",
    respondedAt: 0.014,
  });
  await until(() => sent.length >= 1, "the click");
  expect(performance.now() - began).toBeLessThan(TIMING.inflightCapMs / 2);
});

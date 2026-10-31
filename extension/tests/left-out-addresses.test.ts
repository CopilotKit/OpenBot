// Nothing of a site the person leaves out reaches Intelligence, not even as the address a later page change came from,
// end to end: the real service worker and the real offscreen document over a fake Intelligence, as held-steps.test.ts
// runs them. The service worker's step timers run on the test's clock; the document runs on the browser's timers.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from "fake-indexeddb";
import {
  installRecording,
  type RecordingDeps,
} from "../src/background/recording";
import { installRouter } from "../src/background/router";
import { createOffscreenController } from "../src/offscreen/index";
import { openOutbox } from "../src/offscreen/outbox";
import {
  type PageResponse,
  PORT_CONTENT,
  PORT_OFFSCREEN,
} from "../src/protocol/messages";
import type { DrainRecord } from "../src/shared/storage";
import {
  type ChromeFake,
  type FakePort,
  installChromeFake,
} from "./support/chrome-fake";
import { type FakeGateway, startFakeGateway } from "./support/fake-gateway";
import { fakeMicrophone, fakeSpeech } from "./support/fake-speech";

const EXTENSION_ID = "test";
const ada = { id: "p1", name: "Ada", email: "ada@example.test" };
const SHOP = "http://127.0.0.1:7420/orders/1043";
/** The site the person leaves out, and where they go next. */
const LEFT_OUT = "https://example.org/account/statements?month=10";
const NEXT = "https://httpbin.org/forms/post";

type Globals = { indexedDB?: IDBFactory; IDBKeyRange?: unknown };
const globals = globalThis as unknown as Globals;
let saved: Globals = {};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => sleep(20);
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 8_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting: ${label}`);
    await sleep(5);
  }
}

// ---- The fake OpenBot and Intelligence --------------------------------------------------------

let gateway: FakeGateway;
function route(request: Request): Response | null {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/api/recorder/"))
    return Response.json({ error: "Not found." }, { status: 404 });
  const pass = /^\/api\/copilotkit\/trajectory\/([^/]+)\/connect$/.exec(path);
  if (!pass || request.method !== "POST") return null;
  const trajectoryId = decodeURIComponent(pass[1] ?? "");
  return Response.json({
    joinToken: gateway.mintToken(trajectoryId),
    realtime: {
      clientUrl: `${gateway.url}/client`,
      topic: `trajectory:${trajectoryId}`,
    },
  });
}
const sent = (trajectoryId: string) =>
  gateway.events(trajectoryId).map((entry) => entry.raw as CapturedEvent);
const names = (trajectoryId: string) =>
  sent(trajectoryId).map((event) => event.name);

// ---- Time --------------------------------------------------------------------------------------

let clock = 0;
type Due = { id: number; at: number; fn: () => void };
const due: Due[] = [];
let nextTimer = 0;
/** The service worker's step timers, which only `advanceTo` fires. */
const stepTimers = {
  set(fn: () => void, ms: number) {
    nextTimer += 1;
    due.push({ id: nextTimer, at: clock + Math.max(0, ms), fn });
    return nextTimer;
  },
  clear(handle: unknown) {
    const index = due.findIndex((timer) => timer.id === handle);
    if (index >= 0) due.splice(index, 1);
  },
};
async function advanceTo(to: number) {
  for (;;) {
    const next = due
      .filter((timer) => timer.at <= to)
      .sort((a, b) => a.at - b.at)[0];
    if (!next) break;
    due.splice(due.indexOf(next), 1);
    clock = Math.max(clock, next.at);
    next.fn();
    await settle();
  }
  clock = Math.max(clock, to);
  await settle();
}

// ---- The service worker and the document ------------------------------------------------------

let fake: ChromeFake;
let databaseName = "";
let databaseCounter = 0;
const documentTimers = new Set<ReturnType<typeof setTimeout>>();

function runDocument(): void {
  const speech = fakeSpeech();
  const microphone = fakeMicrophone();
  fake.runAs("offscreen-document", () =>
    createOffscreenController({
      openOutbox: () => openOutbox(databaseName),
      connectPort: () => chrome.runtime.connect({ name: PORT_OFFSCREEN }),
      now: () => clock,
      timers: {
        set(fn: () => void, ms: number) {
          const handle = setTimeout(() => {
            documentTimers.delete(handle);
            fn();
          }, ms);
          documentTimers.add(handle);
          return handle;
        },
        clear(handle: unknown) {
          clearTimeout(handle as ReturnType<typeof setTimeout>);
          documentTimers.delete(handle as ReturnType<typeof setTimeout>);
        },
      },
      voice: {
        Recognition: speech.Recognition,
        getUserMedia: microphone.getUserMedia,
      },
    }),
  );
}

function startWorker() {
  const deps: Partial<RecordingDeps> = {
    createNetworkCapture: () => ({
      start: async () => "debugger",
      addTab: async () => {},
      onCommitted: async () => {},
      resume: async () => "debugger",
      recordPageEvent: async () => {},
      recordPageAgent: () => {},
      stop: async () => {},
    }),
    createPageFallback: () => ({
      start: async () => false,
      addTab: async () => {},
      onCommitted: async () => {},
      stop: async () => {},
      active: () => false,
    }),
    acceptPageNetworkEvent: () => null,
    readPolicy: async () => ({
      openbotUrl: null,
      openbotUrlInvalid: false,
      allowedIntelligenceUrls: null,
    }),
    hasHostPermission: async () => true,
    now: () => clock,
    timers: { set: () => 0, clear: () => {} },
    stepTimers,
  };
  installRouter(installRecording(deps));
}

const page = (message: object) =>
  fake.sendFromPage(message) as Promise<PageResponse & { error?: string }>;

/** A frame's content script in a tab, at `url`: its top frame says hello, as the content script does. */
function frame(tabId: number, url: string): FakePort {
  const port = fake.connectFrom(PORT_CONTENT, {
    id: EXTENSION_ID,
    tab: { id: tabId } as chrome.tabs.Tab,
    frameId: 0,
    url,
  });
  port.postMessage({ type: "content.hello", top: true, url });
  return port;
}

/** The tab's top frame reached `url` by a link, as Chrome reports it. */
function goTo(tabId: number, url: string) {
  fake.tabs.set(tabId, {
    ...fake.tabs.get(tabId),
    id: tabId,
    url,
  } as chrome.tabs.Tab);
  fake.webNavigation.commit({
    tabId,
    frameId: 0,
    url,
    transitionType: "link",
    timeStamp: clock,
  });
}

/** Records on tab 7, on the shop, and resolves with the recording's trajectory once its start reached Intelligence. */
async function record(): Promise<string> {
  clock = 1_793_000_000_000;
  fake.tabs.set(7, {
    id: 7,
    url: SHOP,
    title: "Order 1043 - Corner Shop admin",
  } as chrome.tabs.Tab);
  expect(
    await page({ type: "page.record", title: "Find order 1043", tabId: 7 }),
  ).toEqual({ ok: true });
  const active = fake.storage.local.get("activeRecording") as DrainRecord;
  const trajectoryId = active.trajectoryIds[0] ?? "";
  await until(
    () => names(trajectoryId).includes("outcome"),
    "the recording's start in Intelligence",
  );
  return trajectoryId;
}

/** The person presses "Don't record example.org" on the mark in tab `tabId`, which shows the left-out page. */
async function leaveOut(tabId: number) {
  const mark = frame(tabId, LEFT_OUT);
  await until(
    () =>
      mark.messages.some(
        (message) => (message as { site?: string }).site === "example.org",
      ),
    "the mark on the page",
  );
  mark.postMessage({ type: "content.site", recorded: false });
  await until(
    () =>
      JSON.stringify(fake.storage.local.get("excludedSites")) ===
      '["example.org"]',
    "the site left out",
  );
}

async function stop(trajectoryId: string) {
  await advanceTo(clock + 5_000);
  expect(await page({ type: "page.stop" })).toEqual({ ok: true });
  await until(
    () => names(trajectoryId).filter((name) => name === "outcome").length === 2,
    "the recording stopped",
  );
}

/** Every page change Intelligence holds, as where it came from and where it went. */
const pageChanges = (trajectoryId: string) =>
  sent(trajectoryId)
    .filter((event) => event.name === "navigation")
    .map((event) => {
      const value = event.value as { from?: string; to?: string };
      return { from: value.from, to: value.to };
    });

beforeEach(async () => {
  saved = { indexedDB: globals.indexedDB, IDBKeyRange: globals.IDBKeyRange };
  globals.indexedDB = new IDBFactory();
  globals.IDBKeyRange = FakeIDBKeyRange;
  databaseName = `left-out-${Date.now()}-${databaseCounter++}`;
  due.length = 0;
  gateway = await startFakeGateway({ extraRoutes: route });
  fake = installChromeFake({
    extensionId: EXTENSION_ID,
    manifestVersion: "0.3.0",
  });
  fake.offscreen.onDocumentCreated.addListener(() => {
    setTimeout(runDocument, 0);
  });
  fake.storage.local.set("connection", {
    openbotUrl: gateway.httpUrl,
    token: "obr_one",
    connectionId: "c-obr_one",
    user: ada,
    via: "web",
    connectedAt: 0,
  });
  startWorker();
}, 15_000);

afterEach(async () => {
  await settle();
  for (const handle of documentTimers) clearTimeout(handle);
  documentTimers.clear();
  await gateway.stop();
  fake.uninstall();
  for (const key of ["indexedDB", "IDBKeyRange"] as const) {
    if (saved[key] === undefined) Reflect.deleteProperty(globals, key);
    else Object.assign(globals, { [key]: saved[key] });
  }
}, 15_000);

test("a page change away from a site left out comes from nowhere: the left-out address is never sent", async () => {
  // The person leaves example.com out and goes on to httpbin.org in the same tab: that page change used to reach
  // Intelligence as `navigation from:"https://example.com/" to:"https://httpbin.org/forms/post"`.
  const trajectoryId = await record();
  frame(7, SHOP);
  await advanceTo(clock + 2_000);
  goTo(7, LEFT_OUT);
  await advanceTo(clock + 500);
  await leaveOut(7);
  await advanceTo(clock + 6_000);
  goTo(7, NEXT);
  frame(7, NEXT);
  await stop(trajectoryId);

  // The shop's page, left with nothing done on it, gives way to the next page change, as any page passed through does.
  expect(pageChanges(trajectoryId)).toEqual([{ from: "", to: NEXT }]);
  expect(JSON.stringify(sent(trajectoryId))).not.toContain("example.org");
}, 20_000);

test("a tab a left-out page opened is recorded as opened from nowhere: its opener's address is never sent", async () => {
  const trajectoryId = await record();
  frame(7, SHOP);
  await advanceTo(clock + 2_000);
  goTo(7, LEFT_OUT);
  await advanceTo(clock + 500);
  await leaveOut(7);
  await advanceTo(clock + 6_000);
  // The left-out page opens a link in a new tab, which the recording follows.
  fake.tabs.set(9, { id: 9, url: "" } as chrome.tabs.Tab);
  fake.webNavigation.createdTarget({ sourceTabId: 7, tabId: 9, url: NEXT });
  await until(
    () =>
      (
        fake.storage.session.get("recorder") as { tabIds?: number[] }
      )?.tabIds?.includes(9) === true,
    "the new tab followed",
  );
  goTo(9, NEXT);
  frame(9, NEXT);
  await stop(trajectoryId);

  // The shop's page, left with nothing done on it, gives way to the next page change, as any page passed through does.
  expect(pageChanges(trajectoryId)).toEqual([{ from: "", to: NEXT }]);
  expect(JSON.stringify(sent(trajectoryId))).not.toContain("example.org");
}, 20_000);

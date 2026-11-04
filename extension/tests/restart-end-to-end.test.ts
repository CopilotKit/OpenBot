// Kept recordings, end to end: the real service worker and the real offscreen document run side by side, each with the
// chrome its context has (the document gets only chrome.runtime's messaging, getURL and id, as in Chrome), over a fake
// OpenBot and a fake Intelligence. What a document kept in its IndexedDB outbox reaches Intelligence once a browser
// restart's recovery, or the person connecting again, hands it to a document.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type {
  CapturedEvent,
  JsonValue,
} from "@openbot/shared/recorder-masking";
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from "fake-indexeddb";
import {
  installRecording,
  type RecordingDeps,
} from "../src/background/recording";
import { recoverInterruptedRecording } from "../src/background/recovery";
import { installRouter } from "../src/background/router";
import { createOffscreenController } from "../src/offscreen/index";
import { openOutbox } from "../src/offscreen/outbox";
import {
  type PageResponse,
  PORT_CONTENT,
  PORT_OFFSCREEN,
} from "../src/protocol/messages";
import { isRecordablePage } from "../src/shared/origin";
import type { ConnectionRecord, DrainRecord } from "../src/shared/storage";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";
import { type FakeGateway, startFakeGateway } from "./support/fake-gateway";

const EXTENSION_ID = "test";
const ada = { id: "p1", name: "Ada", email: "ada@example.test" };
const DEAL = "https://crm.example.test/deals/42";

type Globals = { indexedDB?: IDBFactory; IDBKeyRange?: unknown };
const globals = globalThis as unknown as Globals;
let saved: Globals = {};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => sleep(25);
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting: ${label}`);
    await sleep(5);
  }
}

// ---- The fake OpenBot and Intelligence --------------------------------------------------------
//
// One server: OpenBot's capture pass route beside the gateway it hands out.

type Pass = {
  trajectoryId: string;
  authorization: string | null;
  bot: string | null;
};
let gateway: FakeGateway;
let passes: Pass[] = [];
/** The answer OpenBot gives a pass while set; a grant when null. */
let passAnswer: (() => Response) | null = null;
/** Every request to OpenBot's recorder routes, but the reports of what the Recorder is doing (activity.ts), which hold
 * nothing recorded. */
let recorderRequests: string[] = [];

/** Only an operator can fix it: the events are parked in the outbox. */
const parked = () =>
  Response.json(
    {
      code: "INTELLIGENCE_RUNTIME_REQUIRED",
      message: "Intelligence is not configured.",
    },
    { status: 503 },
  );

function route(request: Request): Response | null {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/api/recorder/")) {
    if (path !== "/api/recorder/activity")
      recorderRequests.push(`${request.method} ${path}`);
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  const pass = /^\/api\/copilotkit\/trajectory\/([^/]+)\/connect$/.exec(path);
  if (!pass || request.method !== "POST") return null;
  const trajectoryId = decodeURIComponent(pass[1] ?? "");
  passes.push({
    trajectoryId,
    authorization: request.headers.get("authorization"),
    bot: request.headers.get("x-openbot-recorder-bot"),
  });
  if (passAnswer) return passAnswer();
  return Response.json({
    joinToken: gateway.mintToken(trajectoryId),
    realtime: {
      clientUrl: `${gateway.url}/client`,
      topic: `trajectory:${trajectoryId}`,
    },
  });
}

const names = (trajectoryId: string) =>
  gateway.events(trajectoryId).map((entry) => entry.name);
const values = (trajectoryId: string) =>
  gateway
    .events(trajectoryId)
    .map((entry) => (entry.raw as { value: Record<string, JsonValue> }).value);

// ---- The two contexts -------------------------------------------------------------------------

let fake: ChromeFake;
let databaseName = "";
let databaseCounter = 0;
/** The service worker's clock and timers: no test here moves them. */
const now = 1_800_000_000_000;
const workerTimers = { set: () => 0, clear: () => {} };

/** Every offscreen document Chrome opened, with the timers it runs on: a document the browser closed is never
 * advanced again, so it does nothing more, as a closed document does. */
let documents: { timers: Map<number, () => void> }[] = [];

function runDocument(): void {
  const pending = new Map<number, () => void>();
  let next = 0;
  // Each document starts an hour after the one before, as the next browser start does: its sequencer then starts above
  // every seq issued before.
  const startedAt = now + documents.length * 3_600_000;
  documents.push({ timers: pending });
  // The document's own code, with the chrome an offscreen document has, exactly as its entry point starts it.
  fake.runAs("offscreen-document", () =>
    createOffscreenController({
      openOutbox: () => openOutbox(databaseName),
      connectPort: () => chrome.runtime.connect({ name: PORT_OFFSCREEN }),
      now: () => startedAt,
      timers: {
        set(fn) {
          next += 1;
          pending.set(next, fn);
          return next;
        },
        clear(handle) {
          pending.delete(handle as number);
        },
      },
    }),
  );
}

function doubles(): Partial<RecordingDeps> {
  return {
    createNetworkCapture: () => ({
      start: async (_tabId, url) =>
        isRecordablePage(url) ? "debugger" : "waiting",
      addTab: async () => {},
      onCommitted: async () => {},
      resume: async () => "debugger",
      action: () => {},
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
    now: () => now,
    timers: workerTimers,
  };
}

let handlers: ReturnType<typeof installRecording>;
function startWorker() {
  handlers = installRecording(doubles());
  installRouter(handlers);
}

function connect(token: string) {
  fake.storage.local.set("connection", {
    openbotUrl: gateway.httpUrl,
    token,
    connectionId: `c-${token}`,
    user: ada,
    via: "web",
    connectedAt: now,
  });
}

const page = (message: object) =>
  fake.sendFromPage(message) as Promise<PageResponse & { error?: string }>;
const drains = () =>
  (fake.storage.local.get("drains") as DrainRecord[] | undefined) ?? [];
const click = (text: string): CapturedEvent => ({
  type: "CUSTOM",
  name: "click",
  timestamp: 1_700_000_000_000,
  value: { text },
});

/** Records on tab 7, clicks twice, and resolves with the recording's trajectory once the document holds it all. */
async function recordTwoClicks(): Promise<string> {
  fake.tabs.set(7, { id: 7, url: DEAL } as chrome.tabs.Tab);
  expect(
    await page({
      type: "page.record",
      title: "Update deal",
      tabId: 7,
    }),
  ).toEqual({ ok: true });
  const active = fake.storage.local.get("activeRecording") as DrainRecord;
  const trajectoryId = active.trajectoryIds[0] ?? "";
  const content = fake.connectFrom(PORT_CONTENT, {
    id: EXTENSION_ID,
    tab: { id: 7 } as chrome.tabs.Tab,
    frameId: 0,
    url: DEAL,
  });
  content.postMessage({ type: "content.event", event: click("Edit") });
  content.postMessage({ type: "content.event", event: click("Save") });
  return trajectoryId;
}

beforeEach(async () => {
  saved = { indexedDB: globals.indexedDB, IDBKeyRange: globals.IDBKeyRange };
  globals.indexedDB = new IDBFactory();
  globals.IDBKeyRange = FakeIDBKeyRange;
  databaseName = `restart-end-to-end-${Date.now()}-${databaseCounter++}`;
  passes = [];
  passAnswer = null;
  recorderRequests = [];
  documents = [];
  gateway = await startFakeGateway({ extraRoutes: route });
  fake = installChromeFake({
    extensionId: EXTENSION_ID,
    manifestVersion: "0.3.0",
  });
  fake.offscreen.onDocumentCreated.addListener(() => {
    setTimeout(runDocument, 0);
  });
  connect("obr_one");
  startWorker();
});

afterEach(async () => {
  await settle();
  await gateway.stop();
  fake.uninstall();
  for (const key of ["indexedDB", "IDBKeyRange"] as const) {
    if (saved[key] === undefined) Reflect.deleteProperty(globals, key);
    else Object.assign(globals, { [key]: saved[key] });
  }
});

test("a browser restart mid-recording: a new document sends what the old one kept, with an interrupted outcome, and the drain is forgotten", async () => {
  // Intelligence cannot be reached while the person records: everything waits in the document's outbox.
  passAnswer = parked;
  const trajectoryId = await recordTwoClicks();
  await until(
    async () =>
      (await (await openOutbox(databaseName)).count(trajectoryId)) === 5,
    "the outbox holds the recording's five events: its start, its first page and two clicks",
  );
  expect(names(trajectoryId)).toEqual([]);

  // The browser closes and starts again: the service worker, storage.session and the document go; storage.local and the
  // outbox stay.
  await settle();
  fake.restartServiceWorker();
  fake.storage.session.clear();
  fake.offscreen.open = false;
  passAnswer = null;
  startWorker();
  await recoverInterruptedRecording();

  await until(
    () => drains().length === 0,
    "the kept recording sent and forgotten",
  );
  expect(documents).toHaveLength(2);
  expect(names(trajectoryId)).toEqual([
    "recording.started",
    "outcome",
    "navigation",
    "click",
    "click",
    "outcome",
  ]);
  expect(values(trajectoryId).at(-1)).toMatchObject({
    phase: "failed",
    reason: "interrupted",
  });
  expect(passes.at(-1)).toEqual({
    trajectoryId,
    authorization: "Bearer obr_one",
    // No Bot is named: the recording is the person's, and joins their own Learning space.
    bot: null,
  });
  expect(await (await openOutbox(databaseName)).count(trajectoryId)).toBe(0);
  await until(() => !fake.offscreen.open, "the document closed");
  expect(recorderRequests).toEqual([]);
});

test("a recording kept when its connection was revoked is sent once the person connects again", async () => {
  const trajectoryId = await recordTwoClicks();
  await until(() => names(trajectoryId).length === 5, "the clicks streamed");

  // OpenBot answers that the connection was revoked (as the connection check sees it): the recording stops, and what
  // the document had not sent yet, its failed outcome included, is kept for the person.
  const connection = fake.storage.local.get("connection") as ConnectionRecord;
  await handlers.connectionLost({
    kind: "signed-out",
    reason: "revoked",
    connection,
  });
  await until(
    () => drains()[0]?.kept?.waitingForReconnect === true,
    "the recording kept for its person",
  );
  expect(fake.storage.local.get("connection")).toBeUndefined();
  expect(names(trajectoryId)).toHaveLength(5);

  connect("obr_two");
  await handlers.connected();
  await until(
    () => drains().length === 0,
    "the kept recording sent and forgotten",
  );
  expect(names(trajectoryId)).toEqual([
    "recording.started",
    "outcome",
    "navigation",
    "click",
    "click",
    "outcome",
  ]);
  expect(values(trajectoryId).at(-1)).toMatchObject({
    phase: "failed",
    reason: "signed-out",
  });
  expect(passes.at(-1)).toMatchObject({
    trajectoryId,
    authorization: "Bearer obr_two",
  });
});

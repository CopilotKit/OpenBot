// The steps a service worker holds, end to end: the real service worker and the real offscreen document side by side
// over a fake Intelligence. The service worker's clock and timers are the test's, so a worker Chrome stopped does
// nothing more, as a stopped one does; the document runs on the browser's timers. The steps and phrases are rows of
// the full end-to-end run (fixtures/e2e-held-steps.json, fixtures/e2e-run1b-narration.json).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CapturedEvent,
  JsonValue,
} from "@openbot/shared/recorder-masking";
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from "fake-indexeddb";
import type { NetworkCaptureDeps } from "../src/background/network";
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
const ORDER = "http://127.0.0.1:7420/orders/1043";

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8"));
const rows = fixture<{
  archiveClick: CapturedEvent;
  archiveSave: {
    url: string;
    method: string;
    status: number;
    body: JsonValue;
    response: JsonValue;
  };
  notifyClick: CapturedEvent;
  reasonClick: CapturedEvent;
  reasonInput: CapturedEvent;
}>("e2e-held-steps.json");
const narration = fixture<{ rows: CapturedEvent[] }>(
  "e2e-run1b-narration.json",
).rows;
const quitRun = fixture<{
  quitAt: number;
  startedAt: number;
  nameClick: CapturedEvent;
  nameInput: CapturedEvent;
  reasonClick: CapturedEvent;
  reasonInput: CapturedEvent;
}>("e2e-quit-duplicate.json");

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

/** One clock for the whole browser: the service worker's and the document's. */
let clock = 0;
type Due = { id: number; at: number; fn: () => void };
/** A service worker's timers, which only `advance` fires: a worker Chrome stopped keeps its own, never fired again. */
function workerTimers() {
  const due: Due[] = [];
  let next = 0;
  return {
    due,
    set(fn: () => void, ms: number) {
      next += 1;
      due.push({ id: next, at: clock + Math.max(0, ms), fn });
      return next;
    },
    clear(handle: unknown) {
      const index = due.findIndex((timer) => timer.id === handle);
      if (index >= 0) due.splice(index, 1);
    },
  };
}
/** The document's timers: the browser's, until the browser quits. */
function documentTimers() {
  const handles = new Set<ReturnType<typeof setTimeout>>();
  let quit = false;
  return {
    set(fn: () => void, ms: number) {
      const handle = setTimeout(() => {
        handles.delete(handle);
        if (!quit) fn();
      }, ms);
      handles.add(handle);
      return handle;
    },
    clear(handle: unknown) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
      handles.delete(handle as ReturnType<typeof setTimeout>);
    },
    quit() {
      quit = true;
      for (const handle of handles) clearTimeout(handle);
    },
  };
}

let worker: ReturnType<typeof workerTimers>;
/** Moves the clock to `to`, firing the live service worker's timers that fall due on the way, in order. */
async function advanceTo(to: number) {
  for (;;) {
    const next = worker.due
      .filter((timer) => timer.at <= to)
      .sort((a, b) => a.at - b.at)[0];
    if (!next) break;
    worker.due.splice(worker.due.indexOf(next), 1);
    clock = Math.max(clock, next.at);
    next.fn();
    await settle();
  }
  clock = Math.max(clock, to);
  await settle();
}

/** Fires the live service worker's timers already due at `to`, in order, and none they set: the browser quits right
 * after, before a timer set meanwhile (a 0 ms one too) gets its turn. */
async function fireDueAt(to: number) {
  const due = worker.due
    .filter((timer) => timer.at <= to)
    .sort((a, b) => a.at - b.at);
  for (const timer of due) {
    worker.due.splice(worker.due.indexOf(timer), 1);
    clock = Math.max(clock, timer.at);
    timer.fn();
  }
  clock = Math.max(clock, to);
  await settle();
}

// ---- The two contexts -------------------------------------------------------------------------

let fake: ChromeFake;
let databaseName = "";
let databaseCounter = 0;
let documents: ReturnType<typeof documentTimers>[] = [];
let speech = fakeSpeech();
let microphone = fakeMicrophone();

function runDocument(): void {
  const timers = documentTimers();
  documents.push(timers);
  fake.runAs("offscreen-document", () =>
    createOffscreenController({
      openOutbox: () => openOutbox(databaseName),
      connectPort: () => chrome.runtime.connect({ name: PORT_OFFSCREEN }),
      now: () => clock,
      timers,
      voice: {
        Recognition: speech.Recognition,
        getUserMedia: microphone.getUserMedia,
      },
    }),
  );
}

/** The network capture's side the test plays: a finished call from the debugger. */
let network: NetworkCaptureDeps | null = null;

function startWorker() {
  worker = workerTimers();
  const deps: Partial<RecordingDeps> = {
    createNetworkCapture: (captureDeps) => {
      network = captureDeps;
      return {
        start: async () => "debugger",
        addTab: async () => {},
        onCommitted: async () => {},
        resume: async () => "debugger",
        recordPageEvent: async () => {},
        recordPageAgent: () => {},
        stop: async () => {},
      };
    },
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
    // The controller's own waits (the ready timeout, the stop watchdog, the connection check) never fire here.
    timers: { set: () => 0, clear: () => {} },
    stepTimers: worker,
  };
  installRouter(installRecording(deps));
}

/** Chrome stops the service worker (from chrome://serviceworker-internals, or for being idle) and starts it again for
 * the next event: its memory and timers go, while storage, the tabs and the document stay. */
async function restartWorker() {
  fake.restartServiceWorker();
  startWorker();
  await recoverInterruptedRecording();
}

/** The browser quits and starts again: the service worker, storage.session and the document go; storage.local and the
 * outbox stay. */
async function restartBrowser() {
  fake.restartServiceWorker();
  fake.storage.session.clear();
  for (const timers of documents) timers.quit();
  fake.offscreen.open = false;
  startWorker();
  await recoverInterruptedRecording();
}

const page = (message: object) =>
  fake.sendFromPage(message) as Promise<PageResponse & { error?: string }>;
const drains = () =>
  (fake.storage.local.get("drains") as DrainRecord[] | undefined) ?? [];

function contentPort(): FakePort {
  return fake.connectFrom(PORT_CONTENT, {
    id: EXTENSION_ID,
    tab: { id: 7 } as chrome.tabs.Tab,
    frameId: 0,
    url: ORDER,
  });
}

/** Records on tab 7 from `at`, and resolves with the recording's trajectory once its start reached Intelligence. */
async function record(at: number, title: string): Promise<string> {
  clock = at;
  fake.tabs.set(7, {
    id: 7,
    url: ORDER,
    title: "Order 1043 - Corner Shop admin",
  } as chrome.tabs.Tab);
  expect(await page({ type: "page.record", title, tabId: 7 })).toEqual({
    ok: true,
  });
  const active = fake.storage.local.get("activeRecording") as DrainRecord;
  const trajectoryId = active.trajectoryIds[0] ?? "";
  await until(
    () => names(trajectoryId).includes("outcome"),
    "the recording's start in Intelligence",
  );
  return trajectoryId;
}

beforeEach(async () => {
  saved = { indexedDB: globals.indexedDB, IDBKeyRange: globals.IDBKeyRange };
  globals.indexedDB = new IDBFactory();
  globals.IDBKeyRange = FakeIDBKeyRange;
  databaseName = `held-steps-${Date.now()}-${databaseCounter++}`;
  documents = [];
  network = null;
  speech = fakeSpeech();
  microphone = fakeMicrophone();
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
  for (const timers of documents) timers.quit();
  await gateway.stop();
  fake.uninstall();
  for (const key of ["indexedDB", "IDBKeyRange"] as const) {
    if (saved[key] === undefined) Reflect.deleteProperty(globals, key);
    else Object.assign(globals, { [key]: saved[key] });
  }
}, 15_000);

test("Chrome stops the service worker 600 ms after the person clicks Archive order: the click and its PATCH reach Intelligence after the restart, in order", async () => {
  // Run 5: the person clicks Archive order, which PATCHes the order, and Chrome stops the service worker 600 ms later.
  // The click was still held (its window open for the call that saves it) and never reached Intelligence.
  const click = rows.archiveClick;
  const trajectoryId = await record(
    click.timestamp - 7_000,
    "Reconnect and restart: refund order 1043",
  );
  const before = contentPort();
  await advanceTo(click.timestamp - 3_000);
  clock = click.timestamp;
  before.postMessage({ type: "content.event", event: click });
  await settle();
  // The debugger saw the PATCH start a few milliseconds after the click and finish 8 ms later.
  const save = rows.archiveSave;
  network?.call({
    tabId: 7,
    startedAt: click.timestamp + 2,
    respondedAt: click.timestamp + 9,
    endedAt: click.timestamp + 10,
    method: save.method,
    url: save.url,
    exchange: {
      url: save.url,
      status: save.status,
      body: save.body,
      response: save.response,
    },
  });
  await advanceTo(click.timestamp + 600);
  expect(names(trajectoryId)).not.toContain("click");

  await restartWorker();
  // The document reconnects its port (its backoff's first try), and the person goes on: they tick Notify 4.4 s after
  // the click, as in the run.
  const after = contentPort();
  clock = click.timestamp + 4_415;
  const notify = { ...rows.notifyClick, timestamp: clock };
  after.postMessage({ type: "content.event", event: notify });
  await advanceTo(clock + 5_000);
  await until(
    () => names(trajectoryId).filter((name) => name === "click").length === 2,
    "both clicks in Intelligence",
  );

  const events = sent(trajectoryId);
  expect(events.map((event) => event.name)).toEqual([
    "recording.started",
    "outcome",
    "navigation",
    "click",
    "click",
  ]);
  const archive = events[3]?.value as Record<string, JsonValue>;
  expect((archive.target as Record<string, JsonValue>).name).toBe(
    "Archive order",
  );
  // The click carries the PATCH it sent, as it would have without the restart.
  expect(archive.request).toEqual({
    method: "PATCH",
    url: "http://127.0.0.1:7420/api/orders/1043",
    status: 200,
    body: save.body,
    response: save.response,
  });
  // Every row in time order: Intelligence numbers them in the order they happened.
  const times = events.map((event) => event.timestamp);
  expect(times).toEqual([...times].sort((a, b) => a - b));
  // Nothing held is left behind once the steps have gone.
  await until(
    () => fake.storage.local.get("heldSteps") === undefined,
    "the held steps forgotten",
  );
}, 15_000);

test("the browser quits 400 ms after the person typed a reason: the next start sends the click and the typing, then the interrupted outcome", async () => {
  // Edge run: the last click and the typing before the browser quit never reached Intelligence. These are run 4's
  // click on Reason and what was typed into it.
  const click = rows.reasonClick;
  const typed = rows.reasonInput;
  const trajectoryId = await record(
    click.timestamp - 5_000,
    "Edge restart: archive, start a refund, then the browser quits",
  );
  const port = contentPort();
  await advanceTo(click.timestamp - 1);
  clock = click.timestamp;
  port.postMessage({ type: "content.event", event: click });
  await advanceTo(typed.timestamp);
  port.postMessage({ type: "content.event", event: typed });
  await advanceTo(typed.timestamp + 400);
  expect(names(trajectoryId)).not.toContain("input");

  await restartBrowser();
  await until(() => drains().length === 0, "the recording sent and forgotten");
  expect(names(trajectoryId)).toEqual([
    "recording.started",
    "outcome",
    "navigation",
    "click",
    "input",
    "outcome",
  ]);
  const events = sent(trajectoryId);
  expect(events[4]?.value).toMatchObject({
    target: { name: "Reason", value: "Sent while the socket was down" },
  });
  expect(events.at(-1)?.value).toMatchObject({
    phase: "failed",
    reason: "interrupted",
  });
  expect(fake.storage.local.get("heldSteps")).toBeUndefined();
}, 15_000);

test("a narrated recording reaches Intelligence in time order: each phrase goes in ahead of the steps taken while it was said", async () => {
  // Run 1b: the person talks while they work. Each phrase's transcript is stamped with its start but exists only when
  // the phrase ends, 4 to 9 s later; the steps taken meanwhile had already gone, so 10 of its 120 rows were out of order.
  const transcripts = narration.filter((row) => row.name === "transcript");
  const phrase = (index: number) => {
    const row = transcripts[index];
    if (!row) throw new Error("no phrase");
    const value = row.value as { text: string; endedAt: string };
    return {
      text: value.text,
      startedAt: row.timestamp,
      endedAt: Date.parse(value.endedAt),
    };
  };
  const [first, second, third] = [phrase(0), phrase(1), phrase(2)];
  const trajectoryId = await record(
    first.startedAt - 2_000,
    "Find order 1043 and refund it",
  );
  await until(() => speech.instances.length === 1, "the speech recognition");
  const listening = speech.instances[0];
  if (!listening) throw new Error("no recognition");
  listening.begin();
  const port = contentPort();

  // What the browser's speech service hands over, and when: Chrome shows a phrase while the one before is still
  // going, so each one starts where the one before it ended.
  const heard: [number, () => void][] = [
    [first.startedAt, () => listening.say([[first.text, false]])],
    [
      first.endedAt - 100,
      () =>
        listening.say([
          [first.text, false],
          [second.text, false],
        ]),
    ],
    [
      first.endedAt,
      () =>
        listening.say([
          [first.text, true],
          [second.text, false],
        ]),
    ],
    [
      second.endedAt,
      () =>
        listening.say(
          [
            [first.text, true],
            [second.text, true],
            [third.text, false],
          ],
          1,
        ),
    ],
    [
      third.endedAt,
      () =>
        listening.say(
          [
            [first.text, true],
            [second.text, true],
            [third.text, true],
          ],
          2,
        ),
    ],
  ];
  // The person's steps, as the content script and Chrome's navigation events delivered them.
  const done: [number, () => void][] = narration
    .filter((row) => row.name !== "transcript")
    .map((row) => [
      Math.floor(row.timestamp),
      row.name === "navigation"
        ? () =>
            fake.webNavigation.historyUpdate({
              tabId: 7,
              frameId: 0,
              url: String((row.value as { to: string }).to),
              timeStamp: row.timestamp,
            })
        : () => port.postMessage({ type: "content.event", event: row }),
    ]);
  for (const [at, happen] of [...heard, ...done].sort((a, b) => a[0] - b[0])) {
    await advanceTo(at);
    happen();
    await settle();
  }
  await advanceTo(third.endedAt + 6_000);
  expect(await page({ type: "page.stop" })).toEqual({ ok: true });
  await until(
    () => names(trajectoryId).filter((name) => name === "outcome").length === 2,
    "the recording stopped",
  );

  const events = sent(trajectoryId);
  const spoken = events.filter((event) => event.name === "transcript");
  expect(spoken.map((event) => event.timestamp)).toEqual([
    first.startedAt,
    second.startedAt,
    third.startedAt,
  ]);
  expect(
    events.filter((event) =>
      ["click", "input", "key", "submit"].includes(event.name),
    ),
  ).toHaveLength(10);
  // Seq order is time order: no row of the recording goes before one that happened earlier.
  const times = events.map((event) => event.timestamp);
  expect(times).toEqual([...times].sort((a, b) => a - b));
}, 15_000);

test("Stop while a phrase is being said: the phrase goes in ahead of the steps taken while it was said, then the outcome", async () => {
  // The last phrase of a recording is the one the person is saying as they click Stop: it ends only when Stop asks the
  // speech service for it, after the steps taken while it was said were held.
  const trajectoryId = await record(
    rows.archiveClick.timestamp - 4_000,
    "Archive order 1043",
  );
  await until(() => speech.instances.length === 1, "the speech recognition");
  const listening = speech.instances[0];
  if (!listening) throw new Error("no recognition");
  listening.begin();
  const port = contentPort();
  await advanceTo(rows.archiveClick.timestamp - 1_000);
  listening.say([["now I archive the order", false]]);
  await advanceTo(rows.archiveClick.timestamp);
  port.postMessage({ type: "content.event", event: rows.archiveClick });
  await advanceTo(rows.archiveClick.timestamp + 1_500);
  const stopping = page({ type: "page.stop" });
  await until(() => listening.stops === 1, "Stop asks for the phrase");
  listening.say([["now I archive the order and stop", true]]);
  listening.end();
  expect(await stopping).toEqual({ ok: true });
  await until(
    () => names(trajectoryId).filter((name) => name === "outcome").length === 2,
    "the recording stopped",
  );
  expect(names(trajectoryId)).toEqual([
    "recording.started",
    "outcome",
    "navigation",
    "transcript",
    "click",
    "outcome",
  ]);
  const times = sent(trajectoryId).map((event) => event.timestamp);
  expect(times).toEqual([...times].sort((a, b) => a - b));
}, 15_000);

test("the browser quits 2 ms after the typed name left for Intelligence: the next start never sends it again, and sends the click and typing still held once", async () => {
  // The final run's Edge restart (trajectory 88456df7): the name's window closed as the click on Reason began, so it left
  // a second later, at 57.772, and reached Intelligence as the browser quit at 57.774. The held steps in storage still
  // listed it, and the restarted browser sent it a second time, with the same timestamp.
  const steps = [
    quitRun.nameClick,
    quitRun.nameInput,
    quitRun.reasonClick,
    quitRun.reasonInput,
  ];
  const trajectoryId = await record(
    quitRun.startedAt,
    "Edge restart: archive, start a refund, then the browser quits",
  );
  const port = contentPort();
  // Each step reaches the service worker as the collector stamps it.
  for (const step of steps) {
    await advanceTo(step.timestamp);
    port.postMessage({ type: "content.event", event: step });
    await settle();
  }
  const leaves = quitRun.reasonClick.timestamp - 250 + 1_000; // its window closed 250 ms before the next step; then 1 s to settle
  expect(leaves).toBe(quitRun.quitAt - 2);
  await fireDueAt(leaves);
  const typedName = () =>
    sent(trajectoryId).filter(
      (event) =>
        event.name === "input" &&
        (event.value as { target?: { value?: string } }).target?.value ===
          "Rita Restart",
    );
  await until(() => typedName().length === 1, "the name in Intelligence");
  expect(fake.storage.local.get("heldSteps")).toBeDefined();

  clock = quitRun.quitAt;
  await restartBrowser();
  await until(() => drains().length === 0, "the recording sent and forgotten");
  expect(names(trajectoryId)).toEqual([
    "recording.started",
    "outcome",
    "navigation",
    "click",
    "input",
    "click",
    "input",
    "outcome",
  ]);
  expect(typedName()).toHaveLength(1);
  const events = sent(trajectoryId);
  expect(
    events.slice(3, 7).map((event) => [event.name, event.timestamp]),
  ).toEqual(steps.map((step) => [step.name, step.timestamp]));
  // The steps sent after the quit still name the tab they were taken in.
  expect(
    events.slice(2, 7).map((event) => (event.value as { tab?: number }).tab),
  ).toEqual([1, 1, 1, 1, 1]);
  expect(events.at(-1)?.value).toMatchObject({
    phase: "failed",
    reason: "interrupted",
  });
  expect(fake.storage.local.get("heldSteps")).toBeUndefined();
}, 15_000);

test("Chrome stops the service worker 2 ms after the typed name left: the restarted worker sends the steps it still held once, and never the name again", async () => {
  // The same moment as the Edge restart above, with Chrome stopping only the service worker: the restarted worker takes
  // up the held steps storage still lists, the name among them.
  const steps = [
    quitRun.nameClick,
    quitRun.nameInput,
    quitRun.reasonClick,
    quitRun.reasonInput,
  ];
  const trajectoryId = await record(
    quitRun.startedAt,
    "Edge restart: archive, start a refund, then the browser quits",
  );
  const port = contentPort();
  for (const step of steps) {
    await advanceTo(step.timestamp);
    port.postMessage({ type: "content.event", event: step });
    await settle();
  }
  await fireDueAt(quitRun.quitAt - 2);
  const typedName = () =>
    sent(trajectoryId).filter(
      (event) =>
        event.name === "input" &&
        (event.value as { target?: { value?: string } }).target?.value ===
          "Rita Restart",
    );
  await until(() => typedName().length === 1, "the name in Intelligence");

  clock = quitRun.quitAt;
  await restartWorker();
  await advanceTo(quitRun.quitAt + 5_000);
  expect(await page({ type: "page.stop" })).toEqual({ ok: true });
  await until(
    () => names(trajectoryId).filter((name) => name === "outcome").length === 2,
    "the recording stopped",
  );
  expect(names(trajectoryId)).toEqual([
    "recording.started",
    "outcome",
    "navigation",
    "click",
    "input",
    "click",
    "input",
    "outcome",
  ]);
  expect(typedName()).toHaveLength(1);
}, 15_000);

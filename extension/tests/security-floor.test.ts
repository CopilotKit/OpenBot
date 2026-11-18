import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  SECURITY_FLOOR_ADDRESSES,
  SECURITY_FLOOR_SENTENCE,
} from "@openbot/shared/security-floor";
import cases from "../../shared/fixtures/security-floor/cases.json";
import { installRecording } from "../src/background/recording";
import { installRouter } from "../src/background/router";
import {
  installSecurityFloor,
  SECURITY_FLOOR_ALARM,
} from "../src/background/security-floor";
import { IDLE_STATE, type RecorderState } from "../src/protocol/messages";
import type { ConnectionRecord, DrainRecord } from "../src/shared/storage";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";

// The Recorder below the security floor, through the service worker as index.ts installs it: the recording controller
// behind the floor, behind the router. The floor documents are the shared fixtures, signed with their own throwaway key;
// "current" puts the Recorder's floor at 1.1.2 and lists https://cloud.openbot.example as OpenBot Cloud.

const CLOUD = "https://cloud.openbot.example";
const COMPANY = "https://openbot.company.example";
const DESKTOP = "http://127.0.0.1:43117";
const BELOW = "1.1.1";

const doc = (name: string): string => {
  const found = cases.cases.find((c) => c.name === name);
  if (!found) throw new Error(`no case ${name}`);
  return found.document;
};

/** The feed: each floor address answers `text`, or every one fails as it does offline. */
function feed(text: string | null) {
  const asked: string[] = [];
  const get = (async (input: string | URL | Request) => {
    asked.push(String(input));
    if (text === null) throw new TypeError("fetch failed");
    return new Response(text, { status: 200 });
  }) as unknown as typeof fetch;
  return { get, asked };
}

const connection = (openbotUrl: string): ConnectionRecord => ({
  openbotUrl,
  token: "obr_ada",
  connectionId: "c-obr_ada",
  user: { id: "p1", name: "Ada", email: "ada@example.test" },
  via: "web",
  connectedAt: 1,
});

/** OpenBot, as every request the service worker sends it reaches it: answered, and listed. */
let openbot: string[] = [];
const realFetch = globalThis.fetch;
let fake: ChromeFake;

beforeEach(() => {
  openbot = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    openbot.push(String(input instanceof Request ? input.url : input));
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  fake?.uninstall();
});

/** The service worker, started with `stored` in storage.local, the floor feed answering `published`. */
async function start(options: {
  version?: string;
  connectedTo?: string | null;
  held?: string | null;
  published?: string | null;
  desktop?: string | null;
  local?: Record<string, unknown>;
  session?: Record<string, unknown>;
}) {
  fake = installChromeFake({ manifestVersion: options.version ?? BELOW });
  // Website access comes with the install.
  fake.permissions.granted.add("<all_urls>");
  if (options.connectedTo)
    fake.storage.local.set("connection", connection(options.connectedTo));
  if (options.held) fake.storage.local.set("securityFloor", options.held);
  for (const [key, value] of Object.entries(options.local ?? {}))
    fake.storage.local.set(key, value);
  for (const [key, value] of Object.entries(options.session ?? {}))
    fake.storage.session.set(key, value);
  fake.native.reply = () =>
    options.desktop
      ? { ok: true, openbotUrl: options.desktop }
      : { ok: false, error: "not-running" };
  const published = feed(options.published ?? null);
  const controller = installRecording();
  const lost: string[] = [];
  const connectionLost = controller.connectionLost;
  controller.connectionLost = async (loss) => {
    lost.push(loss.kind);
    await connectionLost(loss);
  };
  const floor = installSecurityFloor(controller, {
    keys: [cases.publicKey],
    read: published.get,
  });
  installRouter(floor.recording);
  // The start's own read of the feed has finished, so nothing of it runs on after the test.
  await until(
    () => fake.storage.local.has("securityFloorCheckedAt"),
    "the start's read of the feed",
  );
  return { floor, lost, published };
}

async function until(check: () => boolean | Promise<boolean>, what: string) {
  const deadline = Date.now() + 3_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const record = () =>
  fake.sendFromPage({ type: "page.record", title: "Close a deal", tabId: 7 });
const floorAnswer = () => fake.sendFromPage({ type: "page.floor" });

test("below the floor on OpenBot Cloud, Record is refused and nothing of a recording starts", async () => {
  const { floor } = await start({ connectedTo: CLOUD, held: doc("current") });
  expect(await floorAnswer()).toEqual({
    ok: true,
    floor: { release: "1.1.2" },
  });
  expect(await record()).toEqual({
    ok: false,
    error: SECURITY_FLOOR_SENTENCE,
  });
  // OpenBot's own page and the launcher start a recording the same way, through the controller.
  expect(
    await floor.recording.page(
      { type: "page.record", title: "From OpenBot", tabId: 7 },
      {},
    ),
  ).toEqual({ ok: false, error: SECURITY_FLOOR_SENTENCE });
  expect(fake.storage.local.has("activeRecording")).toBe(false);
  expect(fake.offscreen.created).toEqual([]);
  // Nor does it ask OpenBot for the person's Learning space.
  expect(await fake.sendFromPage({ type: "page.learning" })).toEqual({
    ok: false,
    error: SECURITY_FLOOR_SENTENCE,
  });
  expect(openbot).toEqual([]);
});

test("a recording under way stops, and everything in it is kept to send after the update", async () => {
  const active: DrainRecord = {
    recordingId: "r1",
    title: "Close a deal",
    openbotUrl: CLOUD,
    userId: "p1",
    userName: "Ada",
    trajectoryIds: ["t1"],
    startedAt: 1,
  };
  const recording: RecorderState = {
    ...IDLE_STATE,
    phase: "recording",
    recordingId: "r1",
    title: "Close a deal",
    tabIds: [7],
    topUrls: { 7: "https://crm.example.test/" },
    startedAt: 1,
  };
  const { floor, lost } = await start({
    connectedTo: CLOUD,
    held: doc("current"),
    local: { activeRecording: active },
    session: { recorder: recording },
  });
  expect(await floor.hold()).toEqual({ release: "1.1.2" });
  // The way a policy move stops a recording: its streams halted, nothing sent, nothing deleted.
  expect(lost).toEqual(["policy"]);
  await until(
    () =>
      (fake.storage.session.get("recorder") as RecorderState).phase === "idle",
    "the recording to stop",
  );
  expect(fake.storage.local.has("activeRecording")).toBe(false);
  const drains = fake.storage.local.get("drains") as DrainRecord[];
  expect(drains.map((drain) => drain.recordingId)).toEqual(["r1"]);
  expect(drains[0]?.kept?.waitingForReconnect).toBe(true);
  // Connected again, the kept recording still waits: recovery and a Connect send it only once the floor lets them.
  await floor.recording.connected();
  let recovered = false;
  await floor.whenAllowed(async () => {
    recovered = true;
  });
  expect(recovered).toBe(false);
  expect(fake.calls).not.toContain("offscreen.createDocument");
});

test("connected to a company's own OpenBot, the floor is ignored", async () => {
  const { floor } = await start({
    connectedTo: COMPANY,
    held: doc("current"),
    published: doc("current"),
    desktop: DESKTOP,
  });
  expect(await floorAnswer()).toEqual({ ok: true, floor: null });
  // Record reaches the recording controller, which answers for itself: here, about a tab that isn't open.
  const answer = (await record()) as { ok: boolean; error?: string };
  expect(answer.error).not.toBe(SECURITY_FLOOR_SENTENCE);
  expect(fake.calls).toContain("tabs.get");
  let recovered = false;
  await floor.whenAllowed(async () => {
    recovered = true;
  });
  expect(recovered).toBe(true);
});

test("OpenBot Desktop's own OpenBot on this computer follows the floor, a loopback address it doesn't confirm doesn't", async () => {
  await start({ connectedTo: DESKTOP, held: doc("current"), desktop: DESKTOP });
  expect(await floorAnswer()).toEqual({
    ok: true,
    floor: { release: "1.1.2" },
  });
  fake.uninstall();
  await start({
    connectedTo: "http://127.0.0.1:5173",
    held: doc("current"),
    desktop: DESKTOP,
  });
  expect(await floorAnswer()).toEqual({ ok: true, floor: null });
});

test("offline, the floor verified last still holds", async () => {
  const { floor, published } = await start({
    connectedTo: CLOUD,
    held: doc("current"),
    published: null,
  });
  published.asked.length = 0;
  await floor.refresh();
  expect(published.asked).toEqual([...SECURITY_FLOOR_ADDRESSES]);
  expect(await floorAnswer()).toEqual({
    ok: true,
    floor: { release: "1.1.2" },
  });
  expect(await record()).toEqual({ ok: false, error: SECURITY_FLOOR_SENTENCE });
});

test("an unsigned, tampered or foreign-signed floor holds nothing, and an older one can't lift a newer one", async () => {
  for (const name of ["unsigned", "zero signature", "tampered", "other key"]) {
    const { floor } = await start({ connectedTo: CLOUD, published: doc(name) });
    await floor.refresh();
    expect(await floorAnswer()).toEqual({ ok: true, floor: null });
    expect(fake.storage.local.has("securityFloor")).toBe(false);
    fake.uninstall();
  }
  // A copy kept on this computer that someone changed counts for nothing either.
  await start({ connectedTo: CLOUD, held: doc("tampered") });
  expect(await floorAnswer()).toEqual({ ok: true, floor: null });
  fake.uninstall();
  // The floor at 1.1.2 (serial 2) is kept; a replayed floor at 1.1.1 (serial 1) would let 1.1.1 run.
  const { floor } = await start({
    connectedTo: CLOUD,
    held: doc("current"),
    published: doc("older"),
  });
  await floor.refresh();
  expect(await floorAnswer()).toEqual({
    ok: true,
    floor: { release: "1.1.2" },
  });
  expect(fake.storage.local.get("securityFloor")).toBe(doc("current"));
});

test("a first launch that never reached the feed runs, and reads the feed every six hours", async () => {
  const { floor, published } = await start({
    connectedTo: CLOUD,
    published: null,
  });
  expect(await floorAnswer()).toEqual({ ok: true, floor: null });
  const answer = (await record()) as { ok: boolean; error?: string };
  expect(answer.error).not.toBe(SECURITY_FLOOR_SENTENCE);
  await until(
    () => fake.alarms.created.has(SECURITY_FLOOR_ALARM),
    "the floor's alarm",
  );
  expect(fake.alarms.created.get(SECURITY_FLOOR_ALARM)).toEqual({
    periodInMinutes: 360,
  });
  // It tried the feed as it started, and holds nothing it couldn't read.
  await floor.refresh();
  expect(published.asked.length).toBeGreaterThan(0);
  expect(await floorAnswer()).toEqual({ ok: true, floor: null });
});

test("a floor published while the Recorder runs holds it from the next check", async () => {
  const published = { text: null as string | null };
  fake = installChromeFake({ manifestVersion: BELOW });
  fake.storage.local.set("connection", connection(CLOUD));
  fake.native.reply = () => ({ ok: false, error: "not-running" });
  const floor = installSecurityFloor(installRecording(), {
    keys: [cases.publicKey],
    read: (async () => {
      if (published.text === null) throw new TypeError("fetch failed");
      return new Response(published.text);
    }) as unknown as typeof fetch,
  });
  installRouter(floor.recording);
  await until(
    () => fake.storage.local.has("securityFloorCheckedAt"),
    "the start's read of the feed",
  );
  expect(await floorAnswer()).toEqual({ ok: true, floor: null });
  published.text = doc("current");
  fake.alarms.fire(SECURITY_FLOOR_ALARM);
  await until(
    async () => (await floor.hold()) !== null,
    "the alarm to read the floor",
  );
  expect(await record()).toEqual({ ok: false, error: SECURITY_FLOOR_SENTENCE });
});

test("Update and restart asks Chrome for the update and restarts on it", async () => {
  await start({ connectedTo: CLOUD, held: doc("current") });
  fake.update.status = "no_update";
  expect(await fake.sendFromPage({ type: "page.update" })).toEqual({
    ok: true,
  });
  expect(fake.calls).toContain("runtime.requestUpdateCheck");
  expect(fake.update.reloads).toBe(1);
  // An update Chrome found restarts the Recorder once it is downloaded.
  fake.update.status = "update_available";
  fake.update.version = "1.1.2";
  await fake.sendFromPage({ type: "page.update" });
  expect(fake.update.reloads).toBe(1);
  fake.update.ready("1.1.2");
  expect(fake.update.reloads).toBe(2);
});

test("at or above the floor, nothing is held", async () => {
  await start({ version: "1.1.2", connectedTo: CLOUD, held: doc("current") });
  expect(await floorAnswer()).toEqual({ ok: true, floor: null });
});

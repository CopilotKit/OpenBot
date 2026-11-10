import { afterEach, expect, mock, test } from "bun:test";

// The native side of this, and the stall it notices, are tested in src-tauri/src/stall.rs and
// desktop_stall.rs. These cover the page's side: what it sends, when, and that it never waits.

type Handler = (event: { payload: unknown }) => void;

let calls: Array<{ command: string; args?: unknown }> = [];
let answer: () => Promise<unknown> = async () => undefined;
const listeners = new Map<string, Set<Handler>>();
let unlistened = 0;

mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => {
    calls.push({ command, args });
    return answer();
  },
}));

mock.module("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: Handler) => {
    const handlers = listeners.get(name) ?? new Set<Handler>();
    handlers.add(handler);
    listeners.set(name, handlers);
    return () => {
      unlistened += 1;
      handlers.delete(handler);
    };
  },
}));

const { startHeartbeat, SOONEST_MS } = await import("./heartbeat");

function progress(payload: unknown) {
  for (const handler of listeners.get("setup:progress") ?? [])
    handler({ payload });
}

const beats = () =>
  calls
    .filter((call) => call.command === "setup_heartbeat")
    .map((call) => call.args);

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  calls = [];
  answer = async () => undefined;
  listeners.clear();
  unlistened = 0;
});

test("says it is here every few seconds, the first time as a fresh page, and never waits for an answer", async () => {
  // The native side never answers: the heartbeat goes on regardless.
  answer = () => new Promise(() => {});
  const stop = startHeartbeat({ every: 20 });
  await pause(110);
  stop();
  const sent = beats();
  expect(sent.length).toBeGreaterThanOrEqual(4);
  expect(sent[0]).toEqual({ seen: 0, fresh: true });
  for (const later of sent.slice(1))
    expect(later).toEqual({ seen: 0, fresh: false });
  // Stopped: no more, and it no longer listens.
  const before = beats().length;
  await pause(60);
  expect(beats().length).toBe(before);
  expect(unlistened).toBe(1);
});

test("says the highest progress number it has taken as soon as it arrives, at most once a second", async () => {
  let clock = 10_000;
  const stop = startHeartbeat({ every: 60_000, now: () => clock });
  await pause(0);
  expect(beats()).toEqual([{ seen: 0, fresh: true }]);
  clock += SOONEST_MS;
  progress({ step: "start-machine", ok: true, running: true, seq: 7 });
  expect(beats().at(-1)).toEqual({ seen: 7, fresh: false });
  // Within the second: taken, said with the next heartbeat.
  clock += 200;
  progress({ step: "start-machine", ok: true, running: true, seq: 8 });
  expect(beats().length).toBe(2);
  clock += SOONEST_MS;
  progress({ step: "start-machine", ok: true, running: true, seq: 9 });
  expect(beats().at(-1)).toEqual({ seen: 9, fresh: false });
  // An older number, or none, changes nothing.
  clock += SOONEST_MS;
  progress({ step: "start-machine", ok: true, running: true, seq: 4 });
  progress({ step: "start-machine", ok: true, running: true });
  expect(beats().length).toBe(3);
  stop();
});

test("a failed heartbeat is dropped, never thrown", async () => {
  answer = async () => {
    throw new Error("not in the desktop app");
  };
  const stop = startHeartbeat({ every: 10 });
  await pause(40);
  stop();
  expect(beats().length).toBeGreaterThan(0);
});

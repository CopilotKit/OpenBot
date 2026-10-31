import { expect, test } from "bun:test";
import {
  connectScreen,
  type ScreenSocket,
} from "../src/lib/computers/screen-connection";

function rig() {
  const sockets: ScreenSocket[] = [];
  const timers: { run: () => void; delay: number; cancelled: boolean }[] = [];
  const statuses: string[] = [];
  let verified = false;
  let stopped = 0;
  const control = connectScreen({
    open: () => {
      const socket: ScreenSocket = {
        onopen: null,
        onclose: null,
        onerror: null,
        onmessage: null,
        close: () => undefined,
      };
      sockets.push(socket);
      return socket;
    },
    schedule: (run, delay) => {
      const timer = { run, delay, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    verifyOwnership: async () => verified,
    onReady: (ready) => statuses.push(ready ? "ready" : "blocked"),
    onProblem: (problem) => {
      if (problem) statuses.push(problem);
    },
    onDisconnect: () => {
      stopped++;
    },
    onMessage: () => undefined,
  });
  return {
    sockets,
    timers,
    statuses,
    control,
    verify: () => {
      verified = true;
    },
    stopped: () => stopped,
  };
}

test("connection loss disables input, retries boundedly, then asks for Retry", async () => {
  const r = rig();
  r.sockets[0]?.onopen?.();
  r.sockets[0]?.onclose?.();
  // Blocked, and nothing more: a retry in progress is not a problem (see the reconnecting test).
  expect(r.statuses.at(-1)).toBe("blocked");
  for (let i = 0; i < 5; i++) {
    r.timers[i]?.run();
    r.sockets[i + 1]?.onclose?.();
  }
  expect(r.timers.map((t) => t.delay)).toEqual([500, 1000, 2000, 4000, 8000]);
  expect(r.statuses.at(-1)).toContain("Retry");
  expect(r.stopped()).toBe(6);
  r.control.stop();
});

test("a reconnect that shows the screen again restores the whole retry budget", async () => {
  const r = rig();
  const frame = { data: JSON.stringify({ type: "frame", data: "AA==" }) };
  await r.sockets[0]?.onopen?.();
  for (let i = 0; i < 6; i++) {
    r.sockets[i]?.onmessage?.(frame);
    r.sockets[i]?.onclose?.();
    r.timers[i]?.run();
    await r.sockets[i + 1]?.onopen?.();
  }
  expect(r.timers.map((t) => t.delay)).toEqual([500, 500, 500, 500, 500, 500]);
  expect(r.statuses.some((status) => status.includes("Retry"))).toBe(false);
  // A reconnect still asks who holds the computer before input is ready.
  expect(r.statuses.at(-1)).toBe("blocked");
  r.control.stop();
});

test("reconnect reacquires ownership before input becomes ready", async () => {
  const r = rig();
  r.sockets[0]?.onclose?.();
  r.timers[0]?.run();
  await r.sockets[1]?.onopen?.();
  expect(r.statuses.at(-1)).toBe("blocked");
  r.control.stop();
});

test("a superseded viewer stays stopped until explicit Retry", () => {
  const r = rig();
  r.sockets[0]?.onmessage?.({
    data: JSON.stringify({
      type: "error",
      error:
        "This screen is now being watched somewhere else, so it stopped here.",
    }),
  });
  r.sockets[0]?.onclose?.();
  expect(r.timers).toHaveLength(0);
  expect(r.statuses.at(-1)).toContain("watched somewhere else");
  r.control.stop();
});

/*
 * A blip is a badge, not an overlay. Every brief drop used to report "Reconnecting to the live
 * screen…" as a problem, and the view drew problems as a panel over the screen with a Retry button,
 * so a routine reconnect looked exactly like a dead connection.
 */
test("a drop being retried reports reconnecting, and no problem until the retries run out", async () => {
  const sockets: ScreenSocket[] = [];
  const timers: (() => void)[] = [];
  const problems: (string | null)[] = [];
  const reconnecting: boolean[] = [];
  connectScreen({
    open: () => {
      const socket: ScreenSocket = {
        onopen: null,
        onclose: null,
        onerror: null,
        onmessage: null,
        close: () => undefined,
      };
      sockets.push(socket);
      return socket;
    },
    schedule: (run) => {
      timers.push(run);
      return () => undefined;
    },
    verifyOwnership: async () => false,
    onReady: () => undefined,
    onProblem: (problem) => problems.push(problem),
    onReconnecting: (value) => reconnecting.push(value),
    onDisconnect: () => undefined,
    onMessage: () => undefined,
  });

  await sockets[0]?.onopen?.();
  sockets[0]?.onclose?.();
  expect(reconnecting.at(-1)).toBe(true);
  expect(problems.filter(Boolean)).toEqual([]);

  // Back on the first retry: the badge goes, and nothing was ever drawn over the screen.
  timers[0]?.();
  await sockets[1]?.onopen?.();
  expect(reconnecting.at(-1)).toBe(false);
  expect(problems.filter(Boolean)).toEqual([]);

  // Gone for good: only now is it a problem, and the badge is cleared with it.
  for (let i = 1; i <= 6; i++) {
    sockets[i]?.onclose?.();
    timers[i]?.();
  }
  expect(reconnecting.at(-1)).toBe(false);
  expect(problems.at(-1)).toContain("Retry");
});

test("unmount cancels a pending reconnect and ignores old socket callbacks", () => {
  const r = rig();
  r.sockets[0]?.onclose?.();
  r.control.stop();
  r.timers[0]?.run();
  expect(r.timers[0]?.cancelled).toBe(true);
  expect(r.sockets).toHaveLength(1);
});

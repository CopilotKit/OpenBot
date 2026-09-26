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
  expect(r.statuses.at(-2)).toBe("blocked");
  for (let i = 0; i < 5; i++) {
    r.timers[i]?.run();
    r.sockets[i + 1]?.onclose?.();
  }
  expect(r.timers.map((t) => t.delay)).toEqual([500, 1000, 2000, 4000, 8000]);
  expect(r.statuses.at(-1)).toContain("Retry");
  expect(r.stopped()).toBe(6);
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

test("unmount cancels a pending reconnect and ignores old socket callbacks", () => {
  const r = rig();
  r.sockets[0]?.onclose?.();
  r.control.stop();
  r.timers[0]?.run();
  expect(r.timers[0]?.cancelled).toBe(true);
  expect(r.sockets).toHaveLength(1);
});

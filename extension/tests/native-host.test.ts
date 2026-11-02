import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import {
  askDesktopForHandoff,
  desktopAvailable,
} from "../src/background/native-host";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";

let fake: ChromeFake;

beforeEach(() => {
  fake = installChromeFake();
});
afterEach(() => {
  fake.uninstall();
});

test("a good handoff reply becomes the address and code", async () => {
  fake.native.reply = () => ({
    openbotUrl: "http://127.0.0.1:7478",
    code: "obc_abc",
  });
  expect(await askDesktopForHandoff()).toEqual({
    openbotUrl: "http://127.0.0.1:7478",
    code: "obc_abc",
  });
  expect(fake.native.sent).toEqual([{ type: "handoff" }]);
});

test("the host's own error code comes through, a reply of another shape is handoff-failed, and no host is no-answer", async () => {
  for (const [reply, answer] of [
    [{ ok: false, error: "not-signed-in" }, { error: "not-signed-in" }],
    [
      { ok: false, error: "organization-unavailable" },
      { error: "organization-unavailable" },
    ],
    [{ error: "not-installed" }, { error: "not-installed" }],
    [{ openbotUrl: "http://127.0.0.1:7478" }, { error: "handoff-failed" }],
    [
      { openbotUrl: "http://127.0.0.1:7478", code: "abc" },
      { error: "handoff-failed" },
    ],
    [{ openbotUrl: 5, code: "obc_abc" }, { error: "handoff-failed" }],
    [{ ok: false }, { error: "handoff-failed" }],
  ] as const) {
    fake.native.reply = () => reply;
    expect(await askDesktopForHandoff()).toEqual(answer);
  }
  fake.native.reply = () => ({
    ok: true,
    openbotUrl: "http://127.0.0.1:7478",
    code: "obc_abc",
  });
  expect(await askDesktopForHandoff()).toEqual({
    openbotUrl: "http://127.0.0.1:7478",
    code: "obc_abc",
  });
});

test("a host that is not installed answers no-answer and unavailable", async () => {
  fake.native.reply = null;
  expect(await askDesktopForHandoff()).toEqual({ error: "no-answer" });
  expect(await desktopAvailable()).toBe(false);
});

test("a host that never answers times out to no-answer and unavailable", async () => {
  fake.native.reply = () => new Promise(() => {});
  expect(await askDesktopForHandoff(20)).toEqual({ error: "no-answer" });
  expect(await desktopAvailable(20)).toBe(false);
});

test("desktopAvailable is true only for available: true", async () => {
  fake.native.reply = () => ({ available: true });
  expect(await desktopAvailable()).toBe(true);
  expect(fake.native.sent).toEqual([{ type: "ping" }]);
  for (const reply of [
    { available: false },
    { ok: false, available: false, error: "not-signed-in" },
    { available: "true" },
    {},
    { error: "x" },
  ]) {
    fake.native.reply = () => reply;
    expect(await desktopAvailable()).toBe(false);
  }
});

/** A host reply that lands after `ms` on the fake clock. */
function answerAfter(ms: number, reply: object) {
  return () =>
    new Promise<object>((resolve) => setTimeout(() => resolve(reply), ms));
}

test("the ping waits out the Desktop host's 2 s deadline, and gives up at 3 s", async () => {
  jest.useFakeTimers();
  try {
    fake.native.reply = answerAfter(2_000, { available: true });
    const slow = desktopAvailable();
    jest.advanceTimersByTime(2_000);
    expect(await slow).toBe(true);

    fake.native.reply = answerAfter(3_001, { available: true });
    const tooSlow = desktopAvailable();
    jest.advanceTimersByTime(3_000);
    expect(await tooSlow).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});

test("a handoff waits out the host's 7 s deadline, and gives up at 8 s", async () => {
  jest.useFakeTimers();
  try {
    const handoff = { openbotUrl: "http://127.0.0.1:7478", code: "obc_abc" };
    fake.native.reply = answerAfter(7_000, handoff);
    const slow = askDesktopForHandoff();
    jest.advanceTimersByTime(7_000);
    expect(await slow).toEqual(handoff);

    fake.native.reply = answerAfter(8_001, handoff);
    const tooSlow = askDesktopForHandoff();
    jest.advanceTimersByTime(8_000);
    expect(await tooSlow).toEqual({ error: "no-answer" });
  } finally {
    jest.useRealTimers();
  }
});

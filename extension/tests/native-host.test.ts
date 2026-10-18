import { afterEach, beforeEach, expect, test } from "bun:test";
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

test("a malformed handoff reply is null", async () => {
  for (const reply of [
    { openbotUrl: "http://127.0.0.1:7478" },
    { openbotUrl: "http://127.0.0.1:7478", code: "abc" },
    { openbotUrl: 5, code: "obc_abc" },
    { error: "not-installed" },
  ]) {
    fake.native.reply = () => reply;
    expect(await askDesktopForHandoff()).toBeNull();
  }
});

test("a host that is not installed answers null", async () => {
  fake.native.reply = null;
  expect(await askDesktopForHandoff()).toBeNull();
  expect(await desktopAvailable()).toBe(false);
});

test("a host that never answers times out to null", async () => {
  fake.native.reply = () => new Promise(() => {});
  expect(await askDesktopForHandoff(20)).toBeNull();
  expect(await desktopAvailable(20)).toBe(false);
});

test("desktopAvailable is true only for available: true", async () => {
  fake.native.reply = () => ({ available: true });
  expect(await desktopAvailable()).toBe(true);
  expect(fake.native.sent).toEqual([{ type: "ping" }]);
  for (const reply of [
    { available: false },
    { available: "true" },
    {},
    { error: "x" },
  ]) {
    fake.native.reply = () => reply;
    expect(await desktopAvailable()).toBe(false);
  }
});

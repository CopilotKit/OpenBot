import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  normalizeTags,
  readBotTags,
  rosterTagKey,
  writeBotTags,
} from "@/lib/agents/roster-tags";

beforeAll(() => GlobalRegistrator.register());
beforeEach(() => localStorage.clear());
afterAll(() => GlobalRegistrator.unregister());

test("personal tags survive reads and removing all tags deletes the saved value", () => {
  writeBotTags("alice", "bot", ["Finance", "Planning"]);
  expect(readBotTags("alice", "bot")).toEqual(["Finance", "Planning"]);
  writeBotTags("alice", "bot", []);
  expect(readBotTags("alice", "bot")).toEqual([]);
  expect(localStorage.getItem(rosterTagKey("alice", "bot"))).toBeNull();
});

test("tags normalize whitespace and duplicate casing, with bounded input", () => {
  expect(
    normalizeTags(["  Finance  ", "finance", "", "Client   work"]),
  ).toEqual(["Finance", "Client work"]);
  expect(() => normalizeTags(["x".repeat(41)])).toThrow();
  expect(() =>
    normalizeTags(Array.from({ length: 21 }, (_, i) => `tag${i}`)),
  ).toThrow();
});

test("accounts and Bots have separate storage keys, including delimiter characters", () => {
  writeBotTags("a:b", "c", ["First"]);
  writeBotTags("a", "b:c", ["Second"]);
  writeBotTags("a:b", "other", ["Third"]);
  expect(readBotTags("a:b", "c")).toEqual(["First"]);
  expect(readBotTags("a", "b:c")).toEqual(["Second"]);
  expect(readBotTags("a:b", "other")).toEqual(["Third"]);
  expect(readBotTags("another", "c")).toEqual([]);
});

test("corrupt or invalid storage is ignored rather than breaking the roster", () => {
  for (const value of [
    "{",
    "null",
    "{}",
    "[1]",
    '["x",null]',
    JSON.stringify(["x".repeat(41)]),
  ]) {
    localStorage.setItem(rosterTagKey("alice", "bot"), value);
    expect(readBotTags("alice", "bot")).toEqual([]);
  }
});

test("no account never reads or writes tags", () => {
  expect(readBotTags(undefined, "bot")).toEqual([]);
  expect(() => writeBotTags(undefined, "bot", ["Finance"])).toThrow();
  expect(localStorage.length).toBe(0);
});

test("denied reads are safe and failed writes are reported to the caller", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("Denied");
    },
  });
  try {
    expect(readBotTags("alice", "bot")).toEqual([]);
    expect(() => writeBotTags("alice", "bot", ["Finance"])).toThrow();
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

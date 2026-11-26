import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS, EVENTS } from "./registry";

const SRC = join(import.meta.dir, "..");

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path === join(SRC, "fakeNative")) continue;
      found.push(...sources(path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

function literals(call: string): string[] {
  const pattern = new RegExp(
    String.raw`\b${call}\s*(?:<[^>]*(?:<[^>]*>[^>]*)*>)?\s*\(\s*["'\`]([^"'\`]+)["'\`]`,
    "g",
  );
  const names: string[] = [];
  for (const file of sources(SRC)) {
    for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
      names.push(match[1] as string);
    }
  }
  return names;
}

test("every command the window invokes is in COMMANDS", () => {
  const found = literals("invoke");
  expect(found.length).toBeGreaterThanOrEqual(80);
  const known: readonly string[] = COMMANDS;
  for (const name of found) expect(known).toContain(name);
  // ProviderPicker.tsx passes these through a variable.
  expect(known).toContain("begin_claude_sign_in");
  expect(known).toContain("begin_chatgpt_sign_in");
});

test("every event the window listens to is in EVENTS", () => {
  const known: readonly string[] = EVENTS;
  for (const name of literals("listen")) expect(known).toContain(name);
  // StatusWindow.tsx listens through the constant STATUS_REFRESH_EVENT.
  expect(known).toContain("status:refresh");
});

test("COMMANDS has no duplicates", () => {
  expect(new Set(COMMANDS).size).toBe(COMMANDS.length);
});

test("EVENTS has no duplicates", () => {
  expect(new Set(EVENTS).size).toBe(EVENTS.length);
});

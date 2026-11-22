import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HANDBACK_COMMANDS, PAGE_COMMANDS, PAGE_PLUGIN } from "./pageRegistry";

const DESKTOP = join(import.meta.dir, "..", "..");
const APP_SRC = join(DESKTOP, "..", "app", "src");
const GENERATED = join(APP_SRC, "lib", "api", "generated");
const AI_CONNECTION = join(APP_SRC, "lib", "ai-connection", "desktop.ts");
const known: readonly string[] = PAGE_COMMANDS;

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path === GENERATED) continue;
      found.push(...sources(path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

const GENERIC = String.raw`\s*(?:<[^>]*(?:<[^>]*>[^>]*)*>)?\s*\(\s*"([a-z_]+)"`;

function appCommands(): string[] {
  const names: string[] = [];
  for (const file of sources(APP_SRC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(
      new RegExp(String.raw`\binvokeDesktop${GENERIC}`, "gs"),
    )) {
      names.push(`${PAGE_PLUGIN}|${m[1]}`);
    }
    if (file === AI_CONNECTION) {
      for (const m of text.matchAll(
        new RegExp(String.raw`\bdesktop${GENERIC}`, "gs"),
      )) {
        names.push(`${PAGE_PLUGIN}|${m[1]}`);
      }
    }
    const plugin = /const PLUGIN = "([^"]+)"/.exec(text)?.[1];
    if (plugin) {
      // `${PLUGIN}|${command}` passes the name through a variable, so it is not collected.
      for (const m of text.matchAll(/\$\{PLUGIN\}\|([a-z_]+)/gs)) {
        names.push(`${plugin}|${m[1]}`);
      }
    }
    for (const m of text.matchAll(/"(plugin:[a-z-]+\|[a-z_]+)"/gs)) {
      names.push(m[1] as string);
    }
  }
  return names;
}

test("every command desktop_page.rs registers is in PAGE_COMMANDS, and no more", () => {
  const rust = readFileSync(
    join(DESKTOP, "src-tauri", "src", "desktop_page.rs"),
    "utf8",
  );
  const start = rust.indexOf("generate_handler![");
  expect(start).toBeGreaterThanOrEqual(0);
  const body = rust.slice(
    start + "generate_handler![".length,
    rust.indexOf("]", start),
  );
  const registered = new Set(
    body
      .split(/[\s,]+/)
      .filter((name) => name.length > 0)
      .map((name) => `${PAGE_PLUGIN}|${name}`),
  );
  const listed = new Set(
    known.filter((name) => name.startsWith(`${PAGE_PLUGIN}|`)),
  );
  expect([...registered].sort()).toEqual([...listed].sort());
});

test("every page command the app calls is in PAGE_COMMANDS", () => {
  const found = appCommands();
  expect(found.length).toBeGreaterThanOrEqual(20);
  for (const name of found) expect(known).toContain(name);
});

test("no duplicates", () => {
  expect(new Set(PAGE_COMMANDS).size).toBe(PAGE_COMMANDS.length);
  expect(new Set(HANDBACK_COMMANDS).size).toBe(HANDBACK_COMMANDS.length);
});

test("HANDBACK_COMMANDS are page commands", () => {
  for (const name of HANDBACK_COMMANDS) expect(known).toContain(name);
});

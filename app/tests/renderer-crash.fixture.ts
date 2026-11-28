import { afterAll, beforeAll, expect } from "bun:test";
import type { Browser } from "playwright-core";
import { test } from "./renderer-crash";

/**
 * Tests for renderer-crash.test.ts to run in a process of their own and read the results of. Each
 * prints one line per go, so the test reading them can count how often each body ran. Chromium's
 * `chrome://crash` crashes its renderer on purpose, standing in for WebKit's crash under load.
 */
let browser: Browser;
/** How many goes each test has had. */
const goes = new Map<string, number>();

function go(name: string): number {
  const count = (goes.get(name) ?? 0) + 1;
  goes.set(name, count);
  console.log(`[go] ${name} ${count}`);
  return count;
}

/** Open a page and crash its renderer, as Chromium does on `chrome://crash`. */
async function crashRenderer() {
  const page = await browser.newPage();
  await page.goto("chrome://crash").catch(() => undefined);
  // The crash is said by now; whatever the test asks of the page next fails as the real ones did.
  await page.evaluate(() => document.title);
}

beforeAll(async () => {
  const playwright = await import("playwright-core");
  browser = await playwright.chromium.launch({ channel: "chromium" });
});

afterAll(async () => {
  await browser.close();
});

test("crashes once", async () => {
  if (go("crashes once") === 1) await crashRenderer();
  const page = await browser.newPage();
  expect(await page.evaluate(() => 1 + 1)).toBe(2);
  await page.close();
});

test("fails without a crash", async () => {
  go("fails without a crash");
  const page = await browser.newPage();
  expect(await page.evaluate(() => 1 + 1)).toBe(3);
});

test("crashes every time", async () => {
  go("crashes every time");
  await crashRenderer();
});

test.skipIf(false)("crashes once, through skipIf", async () => {
  if (go("crashes once, through skipIf") === 1) await crashRenderer();
});

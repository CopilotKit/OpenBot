import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureServer } from "./server";

/**
 * An app scene at a time looks the same each way you get there: opened at that time, seeked back
 * and forward to it, reloaded, and opened after a different app frame. The same text, the same
 * boxes and the same PNG bytes. Storage, Motion, transitions, fonts, `Math.random` and the time
 * zone must not make two frames differ.
 *
 *   OPENBOT_APP_BROWSER=1 bun test workbench/appDeterminism.browser.test.ts
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

// Playwright comes from the root install, so the module is named by a variable (see
// determinism.browser.test.ts) and only the part used here is typed.
const PLAYWRIGHT: string = "playwright-core";
type Frame = { evaluate<T>(run: () => T): Promise<T> };
type Locator = { screenshot(): Promise<Uint8Array> };
type Page = {
  goto(url: string): Promise<unknown>;
  reload(): Promise<unknown>;
  waitForFunction(run: () => unknown): Promise<unknown>;
  evaluate<T, A = undefined>(run: (arg: A) => T, arg?: A): Promise<T>;
  locator(selector: string): Locator;
  frames(): Frame[];
  mainFrame(): Frame;
  close(): Promise<void>;
};
type Browser = {
  newPage(options: {
    viewport: { width: number; height: number };
    locale: string;
    timezoneId: string;
    reducedMotion: "reduce" | "no-preference";
  }): Promise<Page>;
  close(): Promise<void>;
};
type Chromium = { launch(options: { channel: string }): Promise<Browser> };

type Shot = { text: string; boxes: string[]; png: Uint8Array };

let browser: Browser | undefined;
let server: { url: string; stop(): Promise<void> } | undefined;

beforeAll(async () => {
  if (!asked) return;
  server = await ensureServer();
  const { chromium } = (await import(PLAYWRIGHT)) as { chromium: Chromium };
  browser = await chromium.launch({ channel: "chromium" });
});

afterAll(async () => {
  await browser?.close();
  await server?.stop();
});

function appFrame(page: Page): Frame {
  const frame = page.frames().find((f) => f !== page.mainFrame());
  if (!frame) throw new Error("The workbench has no app frame.");
  return frame;
}

async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__workbenchPage?.ready === true);
}

/** The frame's text, the boxes of the elements the layout warnings know, and the window's PNG. */
async function read(page: Page): Promise<Shot> {
  const text = await appFrame(page).evaluate(() => document.body.innerText);
  const boxes = await page.evaluate(() =>
    (window.__workbenchPage?.elements() ?? []).map(
      (e) =>
        `${e.key} ${Math.round(e.box.x)},${Math.round(e.box.y)} ${Math.round(e.box.width)}x${Math.round(e.box.height)}`,
    ),
  );
  const png = await page.locator("[data-workbench-window]").screenshot();
  return { text, boxes, png };
}

function samePng(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

describe.skipIf(!asked)("the workbench clock in an app frame", () => {
  test("app-home-bots at 4 s is the same opened, seeked, reloaded and after another frame", async () => {
    if (!browser || !server) throw new Error("No browser or server.");
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
      locale: "en-US",
      timezoneId: "UTC",
      reducedMotion: "reduce",
    });
    const link = `${server.url}/workbench/?scene=app-home-bots&theme=light`;
    const seek = (ms: number) =>
      page.evaluate((to) => window.__workbenchPage?.seek(to), ms);
    try {
      await page.goto(link);
      await waitReady(page);
      await seek(4000);
      const a = await read(page);

      await seek(1000);
      await seek(4000);
      const b = await read(page);

      await page.reload();
      await waitReady(page);
      await seek(4000);
      const c = await read(page);

      // A different app frame first: storage it writes must not reach the next frame.
      await page.goto(
        `${server.url}/workbench/?scene=app-home-bots&host=browser`,
      );
      await waitReady(page);
      await seek(4000);
      await page.goto(link);
      await waitReady(page);
      await seek(4000);
      const d = await read(page);

      const shots = { a, b, c, d };
      const differ = Object.entries(shots)
        .filter(([, shot]) => !samePng(shot.png, a.png))
        .map(([name]) => name);
      if (differ.length > 0) {
        const dir = mkdtempSync(join(tmpdir(), "app-determinism-"));
        const files = Object.entries(shots).map(([name, shot]) => {
          const file = join(dir, `${name}.png`);
          writeFileSync(file, shot.png);
          return file;
        });
        throw new Error(
          `The window PNG of ${differ.join(", ")} is not the same as a. See: ${files.join(" ")}`,
        );
      }
      for (const shot of [b, c, d]) {
        expect(shot.text).toBe(a.text);
        expect(shot.boxes).toEqual(a.boxes);
      }
      expect(a.text).toContain("General Assistant");
    } finally {
      await page.close();
    }
  }, 180_000);
});

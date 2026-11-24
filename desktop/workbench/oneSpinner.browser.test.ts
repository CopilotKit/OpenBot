import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { STATE_NAMES } from "../src/fakeNative/states";
import type { Warning } from "./layoutWatch";
import { sceneEnd, sceneSteps } from "./sceneCatalog";
import { INSTALL_SCENES } from "./scenes/install";
import { STATE_SCENES } from "./scenes/states";
import type { Scene } from "./scenes/types";
import {
  ensureServer,
  HOOK_START_MS,
  HOOK_STOP_MS,
  sharedChromium,
} from "./server";
import { DEFAULT_WINDOW, encodeState } from "./urlState";

/**
 * The setup window shows at most one spinner at any moment: the step's own wait. This walks every
 * install run (the Install group's desktop scenes) to each of its run steps and to its end, and each
 * state scene that shows a setup step, and names each frame that shows two.
 *
 * At each stop it counts the spinners in the window (`visibleSpinners`), and it reads the layout
 * watch's Spinners warnings, which the watch finds at every check on the way to the stop.
 *
 *   OPENBOT_APP_BROWSER=1 bun test workbench/oneSpinner.browser.test.ts
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

/** The scene time at which a state scene is read: after the window's launch checks have settled. */
const STATE_READ_AT_MS = 5_000;

// Playwright comes from the root install. See determinism.browser.test.ts.
const PLAYWRIGHT: string = "playwright-core";
type Page = {
  goto(url: string): Promise<unknown>;
  waitForFunction(run: () => unknown): Promise<unknown>;
  evaluate<T, A = undefined>(
    run: ((arg: A) => T) | string,
    arg?: A,
  ): Promise<T>;
  close(): Promise<void>;
};
type Browser = {
  newPage(options: {
    viewport: { width: number; height: number };
    reducedMotion?: "reduce" | "no-preference";
  }): Promise<Page>;
};
type Chromium = { launch(options: { channel: string }): Promise<Browser> };

let browser: Browser | undefined;
let server: { url: string; stop(): Promise<void> } | undefined;

beforeAll(async () => {
  if (!asked) return;
  server = await ensureServer();
  const { chromium } = (await import(PLAYWRIGHT)) as { chromium: Chromium };
  browser = await sharedChromium(() =>
    chromium.launch({ channel: "chromium" }),
  );
}, HOOK_START_MS);

afterAll(async () => {
  await server?.stop();
}, HOOK_STOP_MS);

/** Where each spinner the window shows now is (`spinnerPlace`), read in the page. */
const COUNT_SPINNERS = `(async () => {
  const frame = document.querySelector("[data-workbench-window] iframe");
  const doc = frame && frame.contentDocument;
  if (!doc) return [];
  const { visibleSpinners } = await import("/workbench/layoutWatch.ts");
  return visibleSpinners(doc).map((s) => s.place);
})()`;

async function openScene(page: Page, scene: string): Promise<void> {
  if (!server) throw new Error("No server.");
  const query = encodeState({
    scene,
    at: 0,
    answers: {},
    env: {},
    window: DEFAULT_WINDOW,
  });
  await page.goto(`${server.url}/workbench/?${query}`);
  await page.waitForFunction(() => window.__workbenchPage?.ready === true);
}

/**
 * Walks a scene to each time in `times` (ms) and gives each frame that showed more than one
 * spinner: `<scene> at <s>s: <where each is>`.
 */
async function twoSpinners(
  page: Page,
  scene: Scene,
  times: readonly number[],
): Promise<string[]> {
  await openScene(page, scene.id);
  const found = new Set<string>();
  for (const ms of times) {
    await page.evaluate((at) => window.__workbenchPage?.seek(at), ms);
    const places = await page.evaluate<string[]>(COUNT_SPINNERS);
    if (places.length > 1)
      found.add(`${scene.id} at ${ms / 1000}s: ${places.join(", ")}`);
  }
  const warnings = await page.evaluate<Warning[]>(
    () => window.__workbenchPage?.warnings() ?? [],
  );
  for (const w of warnings) {
    if (w.kind !== "spinners") continue;
    found.add(`${scene.id} at ${w.at / 1000}s: ${w.label.split(": ")[1]}`);
  }
  return [...found];
}

describe.skipIf(!asked)("one spinner at a time", () => {
  test("no install run shows two spinners at a run step or at its end", async () => {
    if (!browser) throw new Error("No browser.");
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
      reducedMotion: "reduce",
    });
    const found: string[] = [];
    try {
      for (const scene of INSTALL_SCENES) {
        const times = [
          ...new Set([...sceneSteps(scene).map((s) => s.at), sceneEnd(scene)]),
        ]
          .sort((a, b) => a - b)
          .map((s) => Math.round(s * 1000));
        found.push(...(await twoSpinners(page, scene, times)));
      }
    } finally {
      await page.close();
    }
    expect(found).toEqual([]);
  }, 900_000);

  test("no state scene of a setup step shows two spinners", async () => {
    if (!browser) throw new Error("No browser.");
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
      reducedMotion: "reduce",
    });
    const found: string[] = [];
    try {
      for (const [index, entry] of STATE_NAMES.entries()) {
        if (entry.step === null) continue;
        const scene = STATE_SCENES[index];
        if (!scene) throw new Error(`No scene for ${entry.title}.`);
        found.push(...(await twoSpinners(page, scene, [STATE_READ_AT_MS])));
      }
    } finally {
      await page.close();
    }
    expect(found).toEqual([]);
  }, 600_000);
});

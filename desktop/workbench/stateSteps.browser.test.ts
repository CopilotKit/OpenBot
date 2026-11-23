import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { STATE_NAMES } from "../src/fakeNative/states";
import { STATE_SCENES } from "./scenes/states";
import {
  ensureServer,
  HOOK_START_MS,
  HOOK_STOP_MS,
  sharedChromium,
} from "./server";
import { DEFAULT_WINDOW, encodeState } from "./urlState";

/**
 * Each state scene shows the setup step that its entry in `STATE_NAMES` names. The step is the
 * window's own (`SetupStep`, which App reports with `step_viewed`), so the workbench never keeps
 * its own idea of where the setup flow is. When App's flow changes, this test names each state
 * that no longer shows its step.
 *
 *   OPENBOT_APP_BROWSER=1 bun test workbench/stateSteps.browser.test.ts
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

/** The scene time at which a state is read: after the window's launch checks have settled. */
const READ_AT_MS = 5_000;

// Playwright comes from the root install. See determinism.browser.test.ts.
const PLAYWRIGHT: string = "playwright-core";
type Frame = { evaluate<T>(run: () => T): Promise<T> };
type Page = {
  goto(url: string): Promise<unknown>;
  waitForFunction(run: () => unknown): Promise<unknown>;
  evaluate<T, A = undefined>(run: (arg: A) => T, arg?: A): Promise<T>;
  frames(): Frame[];
  mainFrame(): Frame;
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

/** The last setup step the window reported, or null when it reported none. */
async function shownStep(page: Page): Promise<string | null> {
  const frame = page.frames().find((f) => f !== page.mainFrame());
  if (!frame) throw new Error("The workbench has no window frame.");
  return frame.evaluate(() => {
    const calls =
      (
        globalThis as {
          __workbench?: {
            calls(): readonly {
              command: string;
              args?: Record<string, unknown>;
            }[];
          };
        }
      ).__workbench?.calls() ?? [];
    let step: string | null = null;
    for (const call of calls) {
      if (call.command !== "record_setup_event") continue;
      const event = call.args?.event as
        | { kind?: string; step?: string }
        | undefined;
      if (event?.kind === "step_viewed") step = event.step ?? null;
    }
    return step;
  });
}

describe.skipIf(!asked)("the state scenes", () => {
  test("each state shows the setup step it names", async () => {
    if (!browser || !server) throw new Error("No browser or server.");
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
      reducedMotion: "reduce",
    });
    const wrong: string[] = [];
    try {
      for (const [index, entry] of STATE_NAMES.entries()) {
        const scene = STATE_SCENES[index];
        if (!scene) throw new Error(`No scene for ${entry.title}.`);
        const query = encodeState({
          scene: scene.id,
          at: 0,
          answers: {},
          env: {},
          window: DEFAULT_WINDOW,
        });
        await page.goto(`${server.url}/workbench/?${query}`);
        await page.waitForFunction(
          () => window.__workbenchPage?.ready === true,
        );
        await page.evaluate(
          (ms) => window.__workbenchPage?.seek(ms),
          READ_AT_MS,
        );
        const shown = await shownStep(page);
        if (shown !== entry.step) {
          wrong.push(
            `${scene.id}: names ${JSON.stringify(entry.step)}, shows ${JSON.stringify(shown)}`,
          );
        }
      }
    } finally {
      await page.close();
    }
    expect(wrong).toEqual([]);
  }, 600_000);
});

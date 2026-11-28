import { test as bunTest } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright-core";

/*
 * A REAL-BROWSER TEST THAT THE BROWSER ITSELF CRASHED RUNS ONCE MORE. NOTHING ELSE DOES.
 *
 * Under CI's load (the WebKit job runs eight files at once, each with Chromium and WebKit), WebKit
 * on Linux kills its own web process now and then: a segmentation fault in its compositor thread
 * (`ThreadedCompositor`, inside `libWPEWebKit-2.0.so.1`), read from a core dump of it, with no error
 * in the page first. It came with the page's WebGL turned off and in a WebKit launched afresh, and
 * it hit whichever test had a page open: a home page, an organization that was out of reach. The
 * test then failed with "Target page, context or browser has been closed", for nothing it checks.
 *
 * So the real-browser test files take `test` from here instead of from bun:test. It is bun's own
 * `test`, with one difference: when a page's renderer crashed while the test ran, as Playwright
 * reports it (`page.on("crash")`), the test runs once more, and the log says so. A test that fails
 * any other way fails on its first go, as it always did, and one that crashes the renderer again
 * fails on its second.
 *
 * Every browser Playwright launches in the file's process is watched, however the file launches
 * it: the browser types are patched where Playwright keeps them, before any test runs.
 */

/** How many times a page's renderer has crashed in this process, as Playwright reported it. */
let renderersCrashed = 0;

/** Count every crash of a page made in `context`. */
function watchContext(context: BrowserContext) {
  context.on("page", (page: Page) => {
    page.on("crash", () => {
      renderersCrashed += 1;
    });
  });
  return context;
}

/** Watch every context `browser` makes, and so every page, `newPage`'s own included. */
function watchBrowser(browser: Browser) {
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args: Parameters<Browser["newContext"]>) =>
    watchContext(await newContext(...args));
  return browser;
}

/** Patch Playwright's browser types once per process, when a test file asks for a real browser. */
if (process.env.OPENBOT_APP_BROWSER === "1") {
  const playwright = await import("playwright-core");
  for (const type of [playwright.chromium, playwright.webkit]) {
    const marked = type as typeof type & { rendererCrashWatched?: true };
    if (marked.rendererCrashWatched) continue;
    marked.rendererCrashWatched = true;
    const launch = type.launch.bind(type);
    type.launch = async (...args: Parameters<typeof type.launch>) =>
      watchBrowser(await launch(...args));
  }
}

/** How many renderer crashes Playwright has reported in this process: for this module's own test. */
export function rendererCrashes(): number {
  return renderersCrashed;
}

/**
 * Run `body`, and run it once more if a page's renderer crashed while it ran. Any other failure,
 * and a second crash, is the test's.
 */
export async function survivingRendererCrash(
  body: () => unknown | Promise<unknown>,
): Promise<void> {
  const before = renderersCrashed;
  try {
    await body();
  } catch (error) {
    // Playwright says the renderer crashed as the calls waiting on its page fail: let it say so.
    await new Promise((done) => setTimeout(done, 100));
    if (renderersCrashed === before) throw error;
    console.warn(
      `The browser's renderer crashed during this test, so it runs once more. The failure it caused: ${error}`,
    );
    await body();
  }
}

type Body = Parameters<typeof bunTest>[1];

/** A test body that survives one renderer crash. One that takes bun's `done` is left as it is. */
function surviving(body: Body): Body {
  if (typeof body !== "function" || body.length > 0) return body;
  return () => survivingRendererCrash(body as () => unknown);
}

type Options = Parameters<typeof bunTest>[2];

/**
 * bun's `test`, where a test the browser's renderer crashed in runs once more: called directly, or
 * through `test.skipIf` and `test.if`. Everything else on it is bun's own.
 */
export const test: typeof bunTest = new Proxy(bunTest, {
  apply: (target, _this, [name, body, options]: [string, Body, Options]) =>
    target(name, surviving(body), options),
  get: (target, key, receiver) =>
    key === "skipIf" || key === "if"
      ? (condition: boolean) => (name: string, body: Body, options?: Options) =>
          target[key](condition)(name, surviving(body), options)
      : Reflect.get(target, key, receiver),
});

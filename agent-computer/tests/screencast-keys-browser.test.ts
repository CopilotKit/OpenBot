import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, CDPSession, Page } from "playwright";
import { type InputMessage, startScreencast } from "../src/screencast";

/**
 * A key a person presses on the live screen, against Chromium itself: it reaches the page as the key it is, and never
 * the browser's own shortcuts.
 *
 * `screencast.test.ts` pins the parameters; this is what Chromium does with them, which is where the fault was. Each
 * key used to name a native key code, the Windows one. Chrome then passes a key the page did not take on to the browser,
 * and on macOS reads the code as the Mac's own key number: in the end-to-end run a person's ArrowLeft on the Browser
 * page opened chrome://settings/help in their browser, which then spun a core until its computer was restarted. Measured
 * on Chrome for Testing 151 headless on macOS, ArrowLeft reached the page as an unnamed key 76 (the Mac's L), and with
 * Home after it (the Mac's Return) the browser stopped answering DevTools. On Linux the same native code lets a
 * forwarded Ctrl+T open a tab, or Alt+ArrowLeft go back, in the person's browser rather than in the page.
 *
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/screencast-keys-browser.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";

/** How long the browser has to answer DevTools after a key: a healthy one answers in milliseconds. */
const ANSWER_MS = 3_000;

const PAGE = `<!doctype html><title>Keys</title>
<p>Nothing to type into until Tab reaches it.</p>
<input id="field" value="hello">
<script>
  window.keys = [];
  addEventListener("keydown", (event) => keys.push(event.key));
</script>`;

let browser: Browser;

beforeAll(async () => {
  if (!asked) return;
  const { chromium } = await import("playwright");
  // The build the computer launches and CI installs, as enter-text.test.ts says; on macOS, the full browser that held
  // the person's browser in the end-to-end run, not the separate headless shell.
  browser = await chromium.launch({ channel: "chromium" });
});

afterAll(async () => {
  await browser?.close();
});

/** Within `ms`, or a sentence saying what did not answer: a wedged browser never answers at all. */
function within<T>(work: Promise<T>, what: string, ms = ANSWER_MS): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} did not answer.`)), ms),
    ),
  ]);
}

/** A keystroke exactly as the live screen sends one (app/src/components/computer/live-screen.tsx). */
function press(
  key: string,
  code: string,
  keyCode: number,
  modifiers = 0,
): InputMessage[] {
  const text = key.length === 1 ? { text: key } : {};
  return [
    {
      type: "key",
      event: "down",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      ...text,
      modifiers,
    },
    {
      type: "key",
      event: "up",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      modifiers,
    },
  ];
}

/** A tab with the page on it, cast as the live screen casts it, and the browser's own DevTools session. */
async function cast(): Promise<{
  tab: Page;
  send: (messages: InputMessage[]) => Promise<void>;
  pages: () => Promise<string[]>;
  stop: () => Promise<void>;
  session: CDPSession;
}> {
  const context = await browser.newContext();
  const tab = await context.newPage();
  await tab.setContent(PAGE);
  const screencast = await startScreencast(tab, () => {});
  const session = await browser.newBrowserCDPSession();
  return {
    tab,
    session,
    send: async (messages) => {
      for (const message of messages)
        await within(screencast.send(message), "The key");
    },
    // Every tab the browser has, whichever window it opened in: the browser's own answer, not Playwright's.
    pages: async () =>
      (
        await within(session.send("Target.getTargets"), "The browser")
      ).targetInfos
        .filter((target) => target.type === "page")
        .map((target) => target.url),
    stop: async () => {
      await screencast.stop();
      await session.detach().catch(() => undefined);
      await context.close();
    },
  };
}

const keysSeen = (tab: Page) =>
  within(
    tab.evaluate(() => (window as unknown as { keys: string[] }).keys),
    "The page",
  );

describe.skipIf(!asked)("a key from the live screen", () => {
  test("reaches the page as the key it is, with nothing focused, and the browser keeps answering", async () => {
    const { tab, send, pages, stop } = await cast();
    const before = await pages();
    for (const [key, code, keyCode] of [
      ["ArrowLeft", "ArrowLeft", 37],
      ["Home", "Home", 36],
      ["End", "End", 35],
      ["Delete", "Delete", 46],
      ["ArrowRight", "ArrowRight", 39],
    ] as const) {
      await send(press(key, code, keyCode));
      expect((await keysSeen(tab)).at(-1)).toBe(key);
      // Nothing opened in the browser: the key stayed in the page.
      expect(await pages()).toEqual(before);
    }
    await stop();
  });

  test("still edits a field: Tab reaches it, and the arrows, Home, Backspace and Delete do what they mean", async () => {
    const { tab, send, stop } = await cast();
    await send(press("Tab", "Tab", 9));
    expect(await tab.evaluate(() => document.activeElement?.id)).toBe("field");
    const caret = () =>
      within(
        tab.evaluate(() => {
          const field = document.getElementById("field") as HTMLInputElement;
          return { value: field.value, at: field.selectionStart };
        }),
        "The page",
      );
    await tab.evaluate(() =>
      (document.getElementById("field") as HTMLInputElement).setSelectionRange(
        5,
        5,
      ),
    );
    await send(press("ArrowLeft", "ArrowLeft", 37));
    expect(await caret()).toEqual({ value: "hello", at: 4 });
    await send(press("Backspace", "Backspace", 8));
    expect(await caret()).toEqual({ value: "helo", at: 3 });
    await send(press("Home", "Home", 36));
    await send(press("Delete", "Delete", 46));
    expect(await caret()).toEqual({ value: "elo", at: 0 });
    await send(press("End", "End", 35));
    await send(press("!", "Digit1", 49, 8));
    expect(await caret()).toEqual({ value: "elo!", at: 4 });
    await stop();
  });

  test("never works the browser's own shortcuts: no new tab, and no going back", async () => {
    const { tab, send, pages, stop } = await cast();
    // Two pages in the tab's history, so a Back the browser took would show.
    await tab.goto("data:text/html,<title>First</title>");
    await tab.goto(`data:text/html,${encodeURIComponent(PAGE)}`);
    const before = await pages();
    // Ctrl+T and Ctrl+N, a new tab and a new window, and Alt+ArrowLeft, Back, on Linux and Windows.
    await send(press("t", "KeyT", 84, 2));
    await send(press("n", "KeyN", 78, 2));
    await send(press("ArrowLeft", "ArrowLeft", 37, 1));
    await tab.waitForTimeout(500);
    expect(await pages()).toEqual(before);
    expect(await within(tab.title(), "The page")).toBe("Keys");
    // The page heard each of them: they went to it, not past it.
    expect(await keysSeen(tab)).toEqual(["t", "n", "ArrowLeft"]);
    await stop();
  });
});

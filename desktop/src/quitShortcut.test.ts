import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// What the desktop window injects into its pages on Windows (`desktop_page::QUIT_SHORTCUT_PAGE`).
// The tray said "Quit  Ctrl+Q" there and Ctrl+Q in the window did nothing.
const SHIM = readFileSync(
  join(import.meta.dir, "../src-tauri/src/quit-shortcut.js"),
  "utf8",
);

type Page = Window & {
  __TAURI_INTERNALS__?: { invoke: (cmd: string) => Promise<unknown> };
  __openbotQuitShortcut?: boolean;
};

let asked: string[] = [];
let composer: HTMLTextAreaElement;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" });
  load();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});
beforeEach(() => {
  asked = [];
  const page = window as Page;
  page.__TAURI_INTERNALS__ = {
    invoke: (cmd) => {
      asked.push(cmd);
      return Promise.resolve(null);
    },
  };
  document.body.innerHTML = "";
  composer = document.createElement("textarea");
  composer.setAttribute("aria-label", "Ask anything");
  document.body.append(composer);
  composer.focus();
});

function press(init: KeyboardEventInit & { key: string }): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  composer.dispatchEvent(event);
  return event;
}

// Once, as the window loads a page; the shim's listener stays on the window between tests.
function load() {
  // biome-ignore lint/security/noGlobalEval: the desktop window evaluates this shim in the page's global scope; the test must run it the same way.
  globalThis.eval(SHIM);
}

test("Ctrl+Q while typing in OpenBot asks the shell to quit, as the tray's Quit does", () => {
  const event = press({ key: "q", code: "KeyQ", ctrlKey: true });
  expect(asked).toEqual(["plugin:openbot-desktop|quit"]);
  expect(event.defaultPrevented).toBe(true);
});

test("a page handler that stops the key does not keep Ctrl+Q from quitting", () => {
  composer.addEventListener("keydown", (event) => event.stopPropagation());
  press({ key: "q", code: "KeyQ", ctrlKey: true });
  expect(asked).toEqual(["plugin:openbot-desktop|quit"]);
});

test("holding Ctrl+Q asks once, and the window injecting the shim again does not listen twice", () => {
  // Every page load event injects it; the flag keeps the first listener the only one.
  load();
  press({ key: "q", code: "KeyQ", ctrlKey: true });
  press({ key: "q", code: "KeyQ", ctrlKey: true, repeat: true });
  press({ key: "q", code: "KeyQ", ctrlKey: true, repeat: true });
  expect(asked).toEqual(["plugin:openbot-desktop|quit"]);
});

test("Ctrl and the Q key quit on a layout that writes another script there", () => {
  press({ key: "й", code: "KeyQ", ctrlKey: true });
  expect(asked).toEqual(["plugin:openbot-desktop|quit"]);
});

test("other keys, and Q with other modifiers, leave OpenBot running", () => {
  const left = [
    press({ key: "q", code: "KeyQ" }),
    press({ key: "Q", code: "KeyQ", shiftKey: true }),
    press({ key: "Q", code: "KeyQ", ctrlKey: true, shiftKey: true }),
    // AltGr arrives as Ctrl+Alt on Windows, and AltGr+Q types "@" on a German keyboard.
    press({ key: "@", code: "KeyQ", ctrlKey: true, altKey: true }),
    press({ key: "w", code: "KeyW", ctrlKey: true }),
    press({ key: "v", code: "KeyV", ctrlKey: true }),
  ];
  expect(asked).toEqual([]);
  for (const event of left) expect(event.defaultPrevented).toBe(false);
});

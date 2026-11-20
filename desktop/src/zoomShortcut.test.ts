import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// What the desktop window injects into its pages on Windows (`zoom::SHORTCUT_PAGE`). "The text is
// too small and you can't zoom in": Ctrl with +, - or 0 did nothing in the window.
const SHIM = readFileSync(
  join(import.meta.dir, "../src-tauri/src/zoom-shortcut.js"),
  "utf8",
);

type Page = Window & {
  __TAURI_INTERNALS__?: {
    invoke: (cmd: string, args?: unknown) => Promise<unknown>;
  };
  __openbotZoomShortcut?: boolean;
};

let asked: Array<{ cmd: string; args?: unknown }> = [];
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
    invoke: (cmd, args) => {
      asked.push({ cmd, args });
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

const steps = () =>
  asked.map(({ cmd, args }) => {
    expect(cmd).toBe("plugin:openbot-desktop|zoom");
    return (args as { step: string }).step;
  });

test("Ctrl with =, +, - and 0 while typing in OpenBot zoom the window in, out and back", () => {
  const events = [
    press({ key: "=", code: "Equal", ctrlKey: true }),
    // Ctrl and + is Ctrl+Shift+= on most keyboards, and the number pad's own +.
    press({ key: "+", code: "Equal", ctrlKey: true, shiftKey: true }),
    press({ key: "+", code: "NumpadAdd", ctrlKey: true }),
    press({ key: "-", code: "Minus", ctrlKey: true }),
    press({ key: "_", code: "Minus", ctrlKey: true, shiftKey: true }),
    press({ key: "-", code: "NumpadSubtract", ctrlKey: true }),
    press({ key: "0", code: "Digit0", ctrlKey: true }),
  ];
  expect(steps()).toEqual(["in", "in", "in", "out", "out", "out", "reset"]);
  for (const event of events) expect(event.defaultPrevented).toBe(true);
});

test("a page handler that stops the key does not keep Ctrl+= from zooming", () => {
  composer.addEventListener("keydown", (event) => event.stopPropagation());
  press({ key: "=", code: "Equal", ctrlKey: true });
  expect(steps()).toEqual(["in"]);
});

test("holding Ctrl+= zooms on, and the window injecting the shim again does not listen twice", () => {
  load();
  press({ key: "=", code: "Equal", ctrlKey: true });
  press({ key: "=", code: "Equal", ctrlKey: true, repeat: true });
  expect(steps()).toEqual(["in", "in"]);
});

test("Ctrl and the 0 key reset on a layout that writes another character there", () => {
  press({ key: "à", code: "Digit0", ctrlKey: true });
  expect(steps()).toEqual(["reset"]);
});

test("other keys, and these keys without Ctrl or with AltGr, are left to the page", () => {
  const left = [
    press({ key: "=", code: "Equal" }),
    press({ key: "-", code: "Minus" }),
    press({ key: "0", code: "Digit0" }),
    press({ key: "+", code: "Equal", shiftKey: true }),
    // AltGr arrives as Ctrl+Alt on Windows and writes characters.
    press({ key: "}", code: "Digit0", ctrlKey: true, altKey: true }),
    press({ key: "1", code: "Digit1", ctrlKey: true }),
    press({ key: "v", code: "KeyV", ctrlKey: true }),
    press({ key: "q", code: "KeyQ", ctrlKey: true }),
  ];
  expect(asked).toEqual([]);
  for (const event of left) expect(event.defaultPrevented).toBe(false);
});

// On macOS the window's View menu answers Command with =, - and 0 (`zoom::shortcut_page`). The page
// answers only Command and +, which never reaches the menu, so no key zooms twice. Loaded last: the
// Windows listener above stays, and it ignores Command.
test("on macOS the page answers Command and +, and leaves the menu's keys to the menu", () => {
  const page = window as Page & { __openbotZoomMenu?: boolean };
  page.__openbotZoomShortcut = false;
  page.__openbotZoomMenu = true;
  load();
  const answered = [
    press({ key: "=", code: "Equal", metaKey: true, shiftKey: true }),
    press({ key: "+", code: "Equal", metaKey: true, shiftKey: true }),
    press({ key: "+", code: "NumpadAdd", metaKey: true }),
  ];
  expect(steps()).toEqual(["in", "in", "in"]);
  for (const event of answered) expect(event.defaultPrevented).toBe(true);
  asked = [];
  const left = [
    press({ key: "=", code: "Equal", metaKey: true }),
    press({ key: "-", code: "Minus", metaKey: true }),
    press({ key: "-", code: "NumpadSubtract", metaKey: true }),
    press({ key: "0", code: "Digit0", metaKey: true }),
    press({
      key: "+",
      code: "Equal",
      ctrlKey: true,
      metaKey: true,
      shiftKey: true,
    }),
  ];
  expect(asked).toEqual([]);
  for (const event of left) expect(event.defaultPrevented).toBe(false);
});

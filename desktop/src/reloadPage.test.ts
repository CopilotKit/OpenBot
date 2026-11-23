import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// What the desktop window injects into OpenBot's pages (`desktop_reload::PAGE`), and what View →
// Reload asks of it. Found in dogfooding: the app had no reload. Reload loads the page again, but
// never while a field the person typed into still holds text, which a reload would lose.
const PAGE = readFileSync(
  join(import.meta.dir, "../src-tauri/src/reload-page.js"),
  "utf8",
);

type Page = Window & { __openbotReload?: () => boolean };

let reloads = 0;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" });
  Object.defineProperty(window.location, "reload", {
    configurable: true,
    value: () => {
      reloads += 1;
    },
  });
  load();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});
beforeEach(() => {
  reloads = 0;
  document.body.innerHTML = "";
});

// Once, as the window loads a page; the listener stays on the document between tests.
function load() {
  // biome-ignore lint/security/noGlobalEval: the desktop window evaluates this script in the page's global scope; the test must run it the same way.
  globalThis.eval(PAGE);
}

function reload(): boolean {
  const asked = (window as Page).__openbotReload;
  if (typeof asked !== "function") throw new Error("the page has no reload");
  return asked();
}

function field<T extends HTMLElement>(element: T): T {
  document.body.append(element);
  return element;
}

function type(into: HTMLInputElement | HTMLTextAreaElement, text: string) {
  into.value = text;
  into.dispatchEvent(new Event("input", { bubbles: true }));
}

test("Reload loads OpenBot's page again when nothing typed would be lost", () => {
  // A field the page filled itself, never typed into, holds nothing of the person's.
  const name = field(document.createElement("input"));
  name.value = "Research Bot";
  expect(reload()).toBe(true);
  expect(reloads).toBe(1);
});

test("Reload keeps the page while the composer holds what the person typed, and reloads once it is sent", () => {
  const composer = field(document.createElement("textarea"));
  type(composer, "Draft the weekly update for");
  expect(reload()).toBe(false);
  expect(reloads).toBe(0);

  // Sent: the composer is empty again.
  type(composer, "");
  expect(reload()).toBe(true);
  expect(reloads).toBe(1);
});

test("a typed field that has gone from the page, or only whitespace, keeps nothing", () => {
  const search = field(document.createElement("input"));
  search.type = "search";
  type(search, "gmail");
  expect(reload()).toBe(false);
  search.remove();
  const spaces = field(document.createElement("textarea"));
  type(spaces, "  \n ");
  expect(reload()).toBe(true);
  expect(reloads).toBe(1);
});

test("a ticked box is not typing", () => {
  const box = field(document.createElement("input"));
  box.type = "checkbox";
  box.checked = true;
  box.dispatchEvent(new Event("input", { bubbles: true }));
  expect(reload()).toBe(true);
});

test("the window injecting the script again on the same page keeps what it saw", () => {
  const composer = field(document.createElement("textarea"));
  type(composer, "half a sentence");
  load();
  expect(reload()).toBe(false);
  expect(reloads).toBe(0);
});

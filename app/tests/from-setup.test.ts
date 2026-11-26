import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  FROM_SETUP_FADE,
  FROM_SETUP_HASH,
  settleFromSetup,
} from "../src/lib/desktop/from-setup";
import type { ShellIpc } from "../src/lib/desktop/shell";

/*
 * OpenBot opened by OpenBot Desktop's setup: setup fades out to the window's ground and marks the
 * address once (`show_openbot`, `opened_by_setup` in desktop/src-tauri/src/main.rs), and the page
 * fades its first paint up from the same ground. Only when marked, only in the Desktop window, and
 * never with reduced motion. Setup's own side: desktop/src/handover.test.ts.
 */

const APP = join(import.meta.dir, "..");
const html = readFileSync(join(APP, "index.html"), "utf8");
/** The head's inline script, which runs before the first paint. */
const inline = html.slice(
  html.indexOf("<script>") + "<script>".length,
  html.indexOf("</script>"),
);

type Page = {
  marked: string | undefined;
  address: string;
  replaced: string[];
};

/** index.html's inline script, run at `address` with motion `reduced` or not. */
function open(address: string, reduced = false): Page {
  const url = new URL(address, "http://127.0.0.1:3010");
  const dataset: Record<string, string> = {};
  const replaced: string[] = [];
  const page: Page = {
    marked: undefined,
    address: url.pathname + url.search + url.hash,
    replaced,
  };
  const window = {
    location: {
      get hash() {
        return url.hash;
      },
      get pathname() {
        return url.pathname;
      },
      get search() {
        return url.search;
      },
    },
    history: {
      state: null,
      replaceState(_state: unknown, _title: string, to: string) {
        replaced.push(to);
        const next = new URL(to, url);
        url.hash = next.hash;
        url.pathname = next.pathname;
        url.search = next.search;
      },
    },
    localStorage: { getItem: () => null },
    matchMedia: (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" ? reduced : false,
    }),
  };
  const document = {
    documentElement: {
      classList: { toggle() {} },
      style: {},
      dataset,
    },
  };
  new Function("window", "document", inline)(window, document);
  page.marked = dataset.fromSetup;
  page.address = url.pathname + url.search + url.hash;
  return page;
}

describe("index.html, before the first paint", () => {
  test("the page setup opened is marked to fade, and the mark comes off its address", () => {
    const page = open(`/${FROM_SETUP_HASH}`);
    expect(page.marked).toBe("");
    expect(page.address).toBe("/");
    // Its path and query stay as the window was sent them.
    const deep = open(`/settings/computer?tab=1${FROM_SETUP_HASH}`);
    expect(deep.marked).toBe("");
    expect(deep.replaced).toEqual(["/settings/computer?tab=1"]);
  });

  test("an ordinary load, or another fragment, is not marked and its address is left alone", () => {
    for (const address of ["/", "/onboarding", "/channel/c-1#end", "/#from"]) {
      const page = open(address);
      expect(page.marked).toBeUndefined();
      expect(page.replaced).toEqual([]);
    }
  });

  test("with reduced motion the mark still comes off the address, and nothing fades", () => {
    const page = open(`/${FROM_SETUP_HASH}`, true);
    expect(page.marked).toBeUndefined();
    expect(page.address).toBe("/");
  });
});

describe("settleFromSetup, before the app's first render", () => {
  beforeAll(() => GlobalRegistrator.register());
  afterAll(() => GlobalRegistrator.unregister());

  const shell = { invoke: async () => null } as unknown as ShellIpc;

  function page(marked: boolean) {
    document.body.innerHTML = '<div id="root"></div>';
    if (marked) document.documentElement.dataset.fromSetup = "";
    else delete document.documentElement.dataset.fromSetup;
    return document.getElementById("root") as HTMLElement;
  }

  function ended(target: HTMLElement, animationName: string) {
    const event = new Event("animationend", { bubbles: true });
    Object.defineProperty(event, "animationName", { value: animationName });
    target.dispatchEvent(event);
  }

  test("in a plain browser a marked page does not fade", () => {
    page(true);
    settleFromSetup(document, null);
    expect(document.documentElement.dataset.fromSetup).toBeUndefined();
  });

  test("in the Desktop window the mark stays for the fade, and goes once it has played", () => {
    const root = page(true);
    settleFromSetup(document, shell);
    expect(document.documentElement.dataset.fromSetup).toBe("");
    // Another animation, inside or on the root, is not the fade.
    const child = document.createElement("div");
    root.append(child);
    ended(child, FROM_SETUP_FADE);
    ended(root, "settle");
    expect(document.documentElement.dataset.fromSetup).toBe("");
    ended(root, FROM_SETUP_FADE);
    expect(document.documentElement.dataset.fromSetup).toBeUndefined();
  });

  test("an unmarked page is left as it is", () => {
    page(false);
    settleFromSetup(document, shell);
    expect(document.documentElement.dataset.fromSetup).toBeUndefined();
  });
});

describe("one mark, one fade", () => {
  test("the shell, index.html and the styles name the same mark and fade", () => {
    const rust = readFileSync(
      join(APP, "..", "desktop", "src-tauri", "src", "main.rs"),
      "utf8",
    );
    expect(rust).toContain(
      `const FROM_SETUP: &str = "${FROM_SETUP_HASH.slice(1)}";`,
    );
    expect(inline).toContain(`window.location.hash === "${FROM_SETUP_HASH}"`);
    const css = readFileSync(join(APP, "src", "styles.css"), "utf8");
    expect(css).toContain(`@keyframes ${FROM_SETUP_FADE} {`);
    expect(css).toContain(`animation: ${FROM_SETUP_FADE} `);
  });

  test("the fade starts with the first thing drawn, from the sidebar's ground, and only without reduced motion", () => {
    const css = readFileSync(join(APP, "src", "styles.css"), "utf8");
    expect(css).toMatch(
      /html\[data-from-setup\] body \{\s*background: var\(--sidebar\);/,
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: no-preference\) \{\s*html\[data-from-setup\] #root:not\(:empty\) \{/,
    );
  });
});

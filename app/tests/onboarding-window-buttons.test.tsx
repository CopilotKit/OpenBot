import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "tailwindcss";
import { OnboardingFrame } from "../src/components/onboarding/onboarding-frame";

/**
 * Onboarding's Back stays clear of the window's buttons in OpenBot Desktop on macOS.
 *
 * The Mac window's close, minimise and zoom buttons sit over the page's top-left corner, 20pt in
 * and level with the sidebar header's first row (`TRAFFIC_LIGHTS` in the desktop's main.rs). The
 * desktop's window is 1000px wide, so onboarding draws its one column, whose round Back sits at the
 * top left, under those buttons. The desktop marks the page with `data-desktop-titlebar="overlay"`
 * on macOS only, and the header then starts below them.
 * Windows has its own title bar above the page and no such mark, so it gets no inset.
 *
 * Rendered in a real Chromium, because what matters is where Back lands once the browser has laid
 * the page out. The markup is the real frame's, and the stylesheet is Tailwind's build of exactly
 * the classes it wears, over the app's own theme.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/onboarding-window-buttons.test.tsx
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

/** Where macOS draws the window's buttons over the page, as measured in OpenBot Desktop on macOS 26. */
const WINDOW_BUTTONS = { left: 19, top: 21, right: 81, bottom: 37 };

const frame = renderToStaticMarkup(
  <OnboardingFrame
    demo={<p>The step's picture.</p>}
    index={1}
    intro={<h1>Connect your apps</h1>}
    onBack={() => {}}
    onPick={() => {}}
    primary={{ label: "Continue", onClick: () => {} }}
    reached={1}
    titles={["Welcome", "Connect your apps", "Talk to us"]}
  />,
);

/** Tailwind's build of the classes the frame wears, over the app's theme, as the app's build does. */
async function stylesheet(): Promise<string> {
  const tailwind = dirname(
    Bun.resolveSync("tailwindcss/package.json", import.meta.dir),
  );
  const theme = readFileSync(
    new URL("../src/theme.css", import.meta.url),
    "utf8",
  );
  const compiler = await compile(`@import "tailwindcss";\n${theme}`, {
    base: tailwind,
    loadStylesheet: async (id, base) => {
      const path =
        id === "tailwindcss" ? join(tailwind, "index.css") : join(base, id);
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });
  const classes = [...frame.matchAll(/class="([^"]*)"/g)].flatMap((match) =>
    (match[1] ?? "").split(/\s+/).filter(Boolean),
  );
  return compiler.build(classes);
}

let browser: Browser;
let css: string;

beforeAll(async () => {
  if (!asked) return;
  css = await stylesheet();
  const { chromium } = await import("playwright-core");
  // The CI job installs full Chromium without the headless shell.
  browser = await chromium.launch({ channel: "chromium" });
});

afterAll(async () => {
  await browser?.close();
});

/** The frame in a window of this width, marked as the macOS desktop marks it, or not. */
async function open(width: number, macDesktop: boolean): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  await page.setContent(
    `<!doctype html><html${macDesktop ? ' data-desktop-titlebar="overlay"' : ""}><head><style>${css}</style></head><body>${frame}</body></html>`,
  );
  return page;
}

async function place(page: Page) {
  const back = await page
    .locator('[data-onboarding-back="phone"]')
    .boundingBox();
  const inset = await page.$eval(
    "[data-onboarding-frame] > header",
    (header) => getComputedStyle(header).paddingTop,
  );
  return { back, inset };
}

const overlaps = (
  box: { x: number; y: number; width: number; height: number },
  area: typeof WINDOW_BUTTONS,
) =>
  box.x < area.right &&
  box.x + box.width > area.left &&
  box.y < area.bottom &&
  box.y + box.height > area.top;

describe.skipIf(!asked)("onboarding's Back and the window's buttons", () => {
  test("in the macOS desktop, the header starts below the window's buttons and Back is clear of them", async () => {
    const page = await open(1000, true);
    try {
      const { back, inset } = await place(page);
      expect(inset).toBe("48px");
      expect(back).not.toBeNull();
      expect(back?.y).toBeGreaterThanOrEqual(WINDOW_BUTTONS.bottom);
      expect(overlaps(back as NonNullable<typeof back>, WINDOW_BUTTONS)).toBe(
        false,
      );
    } finally {
      await page.close();
    }
  });

  test("without the mark, on Windows or in a browser, there is no inset", async () => {
    const page = await open(1000, false);
    try {
      const { back, inset } = await place(page);
      expect(inset).toBe("0px");
      // Centred in the 68px row at the very top, where it has always been.
      expect(back?.y).toBe(12);
    } finally {
      await page.close();
    }
  });

  test("two columns start below the window's buttons too", async () => {
    const page = await open(1280, true);
    try {
      const { inset } = await place(page);
      expect(inset).toBe("48px");
    } finally {
      await page.close();
    }
  });
});

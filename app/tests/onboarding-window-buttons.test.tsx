import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "tailwindcss";
import { ALWAYS_ASKS_SHORT } from "../src/components/approvals/ask-first-copy";
import { AskFirstSwitch } from "../src/components/onboarding/ask-first-switch";
import { IntroReel } from "../src/components/onboarding/demos/intro-reel";
import {
  OnboardingFrame,
  StepIntro,
} from "../src/components/onboarding/onboarding-frame";

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

/** The real welcome content, including its approval setting and animated demo. */
const welcome = renderToStaticMarkup(
  <QueryClientProvider client={new QueryClient()}>
    <OnboardingFrame
      demo={<IntroReel />}
      index={0}
      intro={
        <StepIntro
          title="Welcome to OpenBot"
          after={
            <section className="flex flex-col gap-3 text-left">
              <div className="flex flex-col gap-1">
                <h2 className="text-lg font-semibold text-pretty">
                  Choose when Bots ask
                </h2>
                <p className="text-pretty text-muted-foreground">
                  {ALWAYS_ASKS_SHORT}
                </p>
              </div>
              <AskFirstSwitch />
              <p className="text-sm text-pretty text-muted-foreground">
                You can change this anytime in Settings.
              </p>
            </section>
          }
        >
          <p>Give work to Bots in plain words. They tell you when it's done.</p>
        </StepIntro>
      }
      onBack={() => {}}
      onPick={() => {}}
      primary={{ label: "Continue", onClick: () => {} }}
      reached={0}
      titles={["Welcome to OpenBot", "OpenBot for Business", "Your name"]}
    />
  </QueryClientProvider>,
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
  const classes = [...(frame + welcome).matchAll(/class="([^"]*)"/g)].flatMap(
    (match) => (match[1] ?? "").split(/\s+/).filter(Boolean),
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
  for (const height of [860, 773, 649])
    for (const colorScheme of ["light", "dark"] as const)
      test(`first welcome fits the 1120×${height} app window (${colorScheme})`, async () => {
        const page = await browser.newPage({
          viewport: { width: 1120, height },
          colorScheme,
        });
        try {
          await page.setContent(
            `<!doctype html><html data-desktop-titlebar="overlay" class="${colorScheme === "dark" ? "dark" : ""}"><head><style>${css}</style></head><body>${welcome}</body></html>`,
          );
          const fit = await page.evaluate(() => {
            const demo = document.querySelector("[data-onboarding-demo]")!;
            const intro = document.querySelector("[data-onboarding-intro]")!;
            const primary = document.querySelector(
              "[data-onboarding-primary]",
            )!;
            return {
              scroll: document.documentElement.scrollHeight > innerHeight,
              sideBySide:
                intro.getBoundingClientRect().right <=
                demo.getBoundingClientRect().left,
              buttonVisible:
                primary.getBoundingClientRect().bottom <= innerHeight,
            };
          });
          expect(fit).toEqual({
            scroll: false,
            sideBySide: true,
            buttonVisible: true,
          });
          if (process.env.OPENBOT_APP_SHOTS)
            await page.screenshot({
              path: `${process.env.OPENBOT_APP_SHOTS}/welcome-1120x${height}-${colorScheme}.png`,
            });
        } finally {
          await page.close();
        }
      });
});

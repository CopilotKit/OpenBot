import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Browser, Page } from "playwright-core";
import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "tailwindcss";
import { useNameStep } from "../src/components/onboarding/name-step";
import { OnboardingWizard } from "../src/components/onboarding/onboarding-wizard";

/**
 * The name step's orb, glow and all, is drawn whole: never cut by the bar of steps above it.
 *
 * Below `lg` (and the desktop's 1000px window is below it, on Windows and on macOS) the name step
 * puts its orb first, right under the header with the back chevron and the step dashes. That header
 * is sticky and painted over the page, so anything the orb draws above its own box lands under it.
 * The orb draws well above its box: its glow reaches out past it, and listening and done scale it
 * up. On a fresh Windows install the top of the orb was cut flat under the dashes.
 *
 * Rendered in a real Chromium, because what is cut is decided by the browser's layout. The markup is
 * the real wizard with the real name step, and the stylesheet is Tailwind's build of exactly the
 * classes it wears, over the app's own theme.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/onboarding-orb-room.test.tsx
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

function NameStepOnScreen({ finished }: { finished: boolean }) {
  const name = useNameStep({ finish: async () => {}, finished });
  return (
    <OnboardingWizard
      initialStepId="name"
      steps={[
        { id: "welcome", title: "Welcome to OpenBot", intro: () => null },
        { id: "selfhost", title: "Talk to us", intro: () => null },
        name,
      ]}
    />
  );
}

/** The name step while somebody types (the orb listening), and as it ends (the orb done). */
const markup = (finished: boolean) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NameStepOnScreen finished={finished} />
    </QueryClientProvider>,
  );
const pages = { listening: markup(false), done: markup(true) };

/** Tailwind's build of the classes the step wears, over the app's theme, as the app's build does. */
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
  const classes = Object.values(pages).flatMap((page) =>
    [...page.matchAll(/class="([^"]*)"/g)].flatMap((match) =>
      (match[1] ?? "").split(/\s+/).filter(Boolean),
    ),
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

type Box = { top: number; right: number; bottom: number; left: number };

/**
 * Where the orb paints and where it may: the disc with its scale, and the glow, whose box is blurred
 * outward by the blur's radius. And the area it can be seen in: the window, below the header when
 * the header sits over the page, and inside every ancestor that clips what overflows it.
 */
async function measure(page: Page) {
  return page.evaluate(() => {
    const box = (element: Element) => {
      const { top, right, bottom, left } = element.getBoundingClientRect();
      return { top, right, bottom, left };
    };
    const orb = document.querySelector("[data-onboarding-demo] [data-orb]");
    const disc = orb?.querySelector(".agent-orb");
    const glow = disc?.previousElementSibling;
    if (!orb || !disc || !glow) throw new Error("No orb on the name step");
    const blur = Number.parseFloat(
      /blur\(([\d.]+)px\)/.exec(getComputedStyle(glow).filter)?.[1] ?? "0",
    );
    const halo = box(glow);
    const painted = [
      box(disc),
      {
        top: halo.top - blur,
        right: halo.right + blur,
        bottom: halo.bottom + blur,
        left: halo.left - blur,
      },
    ].reduce((all, one) => ({
      top: Math.min(all.top, one.top),
      right: Math.max(all.right, one.right),
      bottom: Math.max(all.bottom, one.bottom),
      left: Math.min(all.left, one.left),
    }));

    const visible = {
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
      left: 0,
    };
    const header = document.querySelector("[data-onboarding-frame] > header");
    if (header && getComputedStyle(header).position === "sticky") {
      visible.top = Math.max(visible.top, box(header).bottom);
    }
    for (let at = orb.parentElement; at; at = at.parentElement) {
      if (at === document.body) break;
      const { overflowX, overflowY } = getComputedStyle(at);
      const clips = (overflow: string) => overflow !== "visible";
      const edge = box(at);
      if (clips(overflowY)) {
        visible.top = Math.max(visible.top, edge.top);
        visible.bottom = Math.min(visible.bottom, edge.bottom);
      }
      if (clips(overflowX)) {
        visible.left = Math.max(visible.left, edge.left);
        visible.right = Math.min(visible.right, edge.right);
      }
    }
    return { painted, visible, scale: getComputedStyle(disc).transform };
  });
}

/** The name step in a window this size, marked as the macOS desktop marks it, or not. */
async function open(
  state: keyof typeof pages,
  width: number,
  height: number,
  macDesktop: boolean,
): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(
    `<!doctype html><html${macDesktop ? ' data-desktop-titlebar="overlay"' : ""}><head><style>${css}</style></head><body>${pages[state]}</body></html>`,
  );
  return page;
}

const inside = (painted: Box, visible: Box) => ({
  top: painted.top >= visible.top,
  right: painted.right <= visible.right,
  bottom: painted.bottom <= visible.bottom,
  left: painted.left >= visible.left,
});
const whole = { top: true, right: true, bottom: true, left: true };

const windows = [
  { name: "the Windows desktop", width: 1000, height: 800, mac: false },
  { name: "the macOS desktop", width: 1000, height: 800, mac: true },
  { name: "a phone", width: 360, height: 740, mac: false },
  { name: "two columns", width: 1280, height: 800, mac: false },
];

describe.skipIf(!asked)("the name step's orb is never cut", () => {
  for (const state of ["listening", "done"] as const) {
    for (const window of windows) {
      test(`${state}, in ${window.name} (${window.width}px), below the bar of steps`, async () => {
        const page = await open(state, window.width, window.height, window.mac);
        try {
          const { painted, visible } = await measure(page);
          expect(inside(painted, visible)).toEqual(whole);
        } finally {
          await page.close();
        }
      });
    }
  }

  // What is measured is the orb as it plays, so the cases above cover its largest draw.
  test("the orb is drawn as it plays: scaled up while listening, more when done", async () => {
    for (const [state, scale] of [
      ["listening", "matrix(1.06, 0, 0, 1.06, 0, 0)"],
      ["done", "matrix(1.1, 0, 0, 1.1, 0, 0)"],
    ] as const) {
      const page = await open(state, 1000, 800, false);
      try {
        expect((await measure(page)).scale).toBe(scale);
      } finally {
        await page.close();
      }
    }
  });
});

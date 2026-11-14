import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * OpenDots' Bots badge sits on the icon's top-right corner, as an icon's badge does, inside the
 * rail and clear of its border, whether it is a dot or a count, at desktop width on the rail and at
 * phone width on the menu button.
 *
 * It once hung 4px outside the 36px button's corner, past the 18px icon and almost on the rail's
 * right border, because the badge was placed against the button, not the icon.
 *
 * Rendered in a real Chromium, because what matters is where the badge lands once the browser has
 * laid the frame out. The frame is OpenDots' own, with the app's stylesheet; only OpenBot's API is a
 * fake (skins-window-buttons.fixture.tsx), answering with a Bot that has an unread message or
 * things waiting on the person.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/opendots-rail-badge.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> it also saves the rail and the menu button with each badge, light
 * and dark, as opendots-rail-badge-<place>-<badge>-<theme>.png.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";

type Place = {
  name: string;
  width: number;
  /** The button that carries the badge. */
  button: string;
  /** What the badge must stay inside: the rail, or at phone width the window. */
  within: string;
};

const PLACES: Place[] = [
  {
    name: "rail",
    width: 1000,
    button: 'nav[aria-label="Workspace navigation"] a[aria-label="Bots"]',
    within: 'nav[aria-label="Workspace navigation"]',
  },
  {
    name: "menu",
    width: 720,
    button: 'button[aria-label="Open navigation"]',
    within: "body",
  },
];

/** The badge as BotsNavBadge draws it: a dot for something unread, a count for what waits on you. */
const BADGES = [
  { name: "dot", attention: "dot", label: "Unread messages" },
  { name: "count", attention: "3", label: "3 things need you" },
  { name: "count-two-digits", attention: "12", label: "12 things need you" },
];

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "skins-window-buttons.fixture.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
  const script = built.outputs.find((output) => output.kind === "entry-point");
  if (!script) throw new Error("bundle has no entry point");
  return script.text();
}

/** The directory of an installed package, from the app or the repository root. */
function packageDir(name: string): string {
  const dir = [
    join(APP, "node_modules", name),
    join(APP, "..", "node_modules", name),
  ].find(existsSync);
  if (!dir) throw new Error(`no package ${name}`);
  return dir;
}

/** Where `@import "<package>[/<file>]"` lands, by the package's `style` export as Vite reads it. */
function packageStylesheet(id: string): string {
  const parts = id.split("/");
  const name = id.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const dir = packageDir(name);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const subpath = `.${id.slice(name.length)}`;
  const entry = pkg.exports?.[subpath];
  const file =
    typeof entry === "string"
      ? entry
      : (entry?.style ?? entry?.default ?? pkg.main ?? "index.css");
  return join(dir, file);
}

type Compiler = Awaited<ReturnType<typeof compile>>;
let compiler: Compiler;

/** The app's stylesheet, built by Tailwind for these classes, as the app's build does. */
async function stylesheet(classes: string[]): Promise<string> {
  if (!compiler) {
    const tailwind = dirname(Bun.resolveSync("tailwindcss/package.json", APP));
    const entry = join(APP, "src", "styles.css");
    compiler = await compile(readFileSync(entry, "utf8"), {
      base: dirname(entry),
      loadStylesheet: async (id, base) => {
        const path =
          id === "tailwindcss"
            ? join(tailwind, "index.css")
            : id.startsWith(".")
              ? join(base, id)
              : packageStylesheet(id);
        return {
          path,
          base: dirname(path),
          content: readFileSync(path, "utf8"),
        };
      },
    });
  }
  return compiler.build(classes);
}

let browser: Browser;
let script: string;

beforeAll(async () => {
  if (!asked) return;
  script = await bundle();
  const { chromium } = await import("playwright-core");
  // The CI job installs full Chromium without the headless shell.
  browser = await chromium.launch({ channel: "chromium" });
});

afterAll(async () => {
  await browser?.close();
});

/** OpenDots' frame with the badge the attention asks for, styled, at the place's width. */
async function open(
  place: Place,
  attention: string,
  theme: "light" | "dark" = "light",
): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: place.width, height: 600 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en" class="${theme}" data-skin="opendots"><head><meta charset="utf-8"><script>localStorage.setItem("openbot-skin", "opendots")</script></head><body><div id="root"></div><script type="module" src="/frame.js"></script></body></html>`,
      });
    if (path === "/frame.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    return route.fulfill({ status: 404 });
  });
  const query = new URLSearchParams({ skin: "opendots", path: "/", attention });
  await page.goto(`${ORIGIN}/?${query}`);
  await page.locator("[data-page]").waitFor();
  // Unstyled, the dot has no size yet, so this waits for it to be drawn, not to be seen.
  await page
    .locator(`${place.button} [role="img"]`)
    .waitFor({ state: "attached" });
  const classes = await page.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll("[class]")].flatMap((element) => [
        ...element.classList,
      ]),
    ),
  ]);
  await page.addStyleTag({ content: await stylesheet(classes) });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

type Box = { left: number; top: number; right: number; bottom: number };

/** Where the badge, the button's icon, the button and what holds them land, in CSS pixels. */
async function measure(page: Page, place: Place) {
  return page.evaluate(
    ({ button, within }) => {
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        };
      };
      const target = document.querySelector(button);
      const icon = target?.querySelector("svg");
      const badge = target?.querySelector('[role="img"]');
      const holder = document.querySelector(within);
      if (!target || !icon || !badge || !holder)
        throw new Error("the badge, its button or its icon is missing");
      const style = getComputedStyle(holder);
      const inner = box(holder);
      // Inside the holder's border, so the badge never sits on the rail's right edge.
      inner.left += Number.parseFloat(style.borderLeftWidth);
      inner.right -= Number.parseFloat(style.borderRightWidth);
      // The ring OpenDots draws around the badge, as wide as its widest box-shadow spread.
      const ring = Math.max(
        0,
        ...[...getComputedStyle(badge).boxShadow.matchAll(/(-?[\d.]+)px/g)].map(
          (match) => Number(match[1]),
        ),
      );
      const drawn = box(badge);
      return {
        badge: drawn,
        ringed: {
          left: drawn.left - ring,
          top: drawn.top - ring,
          right: drawn.right + ring,
          bottom: drawn.bottom + ring,
        },
        icon: box(icon),
        button: box(target),
        holder: inner,
        label: badge.getAttribute("aria-label"),
      };
    },
    { button: place.button, within: place.within },
  );
}

const centre = (box: Box) => ({
  x: (box.left + box.right) / 2,
  y: (box.top + box.bottom) / 2,
});

describe.skipIf(!asked)("OpenDots' Bots badge", () => {
  for (const place of PLACES) {
    for (const badge of BADGES) {
      test(`the ${badge.name} on the ${place.name} at ${place.width}px sits on the icon's top-right corner, inside the ${place.name === "rail" ? "rail" : "window"}`, async () => {
        const page = await open(place, badge.attention);
        try {
          const seen = await measure(page, place);
          expect(seen.label).toBe(badge.label);
          // Centred on the icon's top-right corner, as an icon's badge is, to the pixel.
          const middle = centre(seen.badge);
          expect(Math.abs(middle.x - seen.icon.right)).toBeLessThanOrEqual(1);
          expect(Math.abs(middle.y - seen.icon.top)).toBeLessThanOrEqual(1);
          // On the rail, never above its button, into the one before it; and never out of the
          // rail or past its border. The menu button sits 14px down the window, so a count
          // reaching a pixel above it is still well inside.
          if (place.name === "rail")
            expect(seen.badge.top).toBeGreaterThanOrEqual(seen.button.top);
          // Ring included, so the ring never paints over the rail's border.
          expect(seen.ringed.left).toBeGreaterThanOrEqual(seen.holder.left);
          expect(seen.ringed.right).toBeLessThanOrEqual(seen.holder.right);
          expect(seen.ringed.top).toBeGreaterThanOrEqual(seen.holder.top);
          // Small enough to leave most of the 18px icon showing.
          expect(seen.badge.bottom - seen.badge.top).toBeLessThanOrEqual(16);
        } finally {
          await page.close();
        }
      }, 30_000);
    }
  }

  test("the badge stands out from the rail in light and dark", async () => {
    const place = PLACES[0] as Place;
    for (const theme of ["light", "dark"] as const) {
      const page = await open(place, "dot", theme);
      try {
        const colours = await page.evaluate((button) => {
          const badge = document.querySelector(`${button} [role="img"]`);
          const rail = document.querySelector(
            'nav[aria-label="Workspace navigation"]',
          );
          if (!badge || !rail) throw new Error("no badge or rail");
          return {
            badge: getComputedStyle(badge).backgroundColor,
            rail: getComputedStyle(rail).backgroundColor,
          };
        }, place.button);
        expect(colours.badge).not.toBe(colours.rail);
      } finally {
        await page.close();
      }
    }
  }, 30_000);

  test.skipIf(!shots)(
    "screenshots of the badge",
    async () => {
      if (!shots) return;
      mkdirSync(shots, { recursive: true });
      for (const place of PLACES)
        for (const badge of BADGES)
          for (const theme of ["light", "dark"] as const) {
            const page = await open(place, badge.attention, theme);
            try {
              const seen = await measure(page, place);
              await page.screenshot({
                path: join(
                  shots,
                  `opendots-rail-badge-${place.name}-${badge.name}-${theme}.png`,
                ),
                clip: {
                  x: 0,
                  y: Math.max(0, seen.button.top - 70),
                  width: place.name === "rail" ? 160 : 120,
                  height: 140,
                },
              });
            } finally {
              await page.close();
            }
          }
    },
    120_000,
  );
});

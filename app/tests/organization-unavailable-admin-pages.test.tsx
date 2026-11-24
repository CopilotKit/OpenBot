import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import {
  asked,
  engines,
  FakeServer,
  go,
  LOOKS,
  open,
  shoot,
  start,
  stop,
  style,
  UNAVAILABLE,
} from "./organization-notices-browser";

/**
 * While an organization's database can't be reached, the pages the end-to-end test of database
 * sharding found mishandling it say the server's sentence calmly, never in red and never in a red
 * box, once a page, at the size of the text around it, and with no empty state in place of what they
 * couldn't load:
 *
 * - Admin, Computers: the sentence sat in a red box under "Folders on this computer", above "No
 *   Bots yet" (three Bots existed) and "The desktop app is offline".
 * - Settings, Setup: said "Couldn't check your setup. Check again." in red instead.
 * - Admin, Playground: said nothing, and "Saved here" said "Nothing saved yet".
 * - Skills: said it three times.
 * - Admin, Automatic learning: said it in a larger font than every other page.
 * - Admin, Approvals: said "No organization rules" beside it.
 *
 * In a real browser, Chromium and WebKit, at 1440 and 390 wide, light and dark: the person is on home
 * in Northwind when its database goes out of reach, and opens each page.
 *
 *   OPENBOT_APP_BROWSER=1 OPENBOT_APP_ENGINES=chromium,webkit bun test app/tests/organization-unavailable-admin-pages.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> each page is saved as organization-unavailable-admin-<page>-<engine>-<width>-<theme>.png.
 */
beforeAll(async () => {
  if (asked) await start("organization-unavailable-admin.fixture.tsx");
}, 120_000);

afterAll(async () => {
  await stop();
});

/** What a page must not say while it couldn't load: each claims something the page doesn't know. */
const MISLEADING = [
  "No Bots yet",
  "The desktop app is offline",
  "Nothing saved yet",
  "No organization rules",
  "Couldn't check your setup",
];

const PAGES = [
  { path: "/admin/computers", name: "computers", once: false },
  { path: "/settings/setup", name: "setup", once: true },
  { path: "/admin/playground", name: "playground", once: true },
  { path: "/skills", name: "skills", once: true },
  { path: "/admin/learning", name: "learning", once: false },
  { path: "/admin/approvals", name: "approvals", once: true },
  // Found by the sweep after it: an empty state on a failed read, or the sentence said twice.
  { path: "/admin/proactive", name: "routines", once: false },
  { path: "/settings/approvals", name: "settings-approvals", once: false },
  { path: "/settings/notifications", name: "notifications", once: true },
] as const;

/**
 * How the page draws the server's sentence: each place that says it, with whether its words or any
 * box around them is in the destructive red, and whether its words are the size of the page's text
 * (`text-sm`). Beside that, every empty state on the page, and every misleading line it shows.
 */
async function drawn(page: Page) {
  return page.evaluate(
    ({ words, misleading }) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      /** A CSS colour as rgb, and how opaque it is, as the browser paints it. */
      const rgba = (color: string): [number, number, number, number] => {
        if (!context) return [0, 0, 0, 0];
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = "#000";
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(
          0,
          0,
          1,
          1,
        ).data;
        return [r, g, b, a];
      };
      const probe = document.createElement("span");
      probe.className = "text-destructive text-sm";
      probe.textContent = "probe";
      document.body.append(probe);
      const destructive = rgba(getComputedStyle(probe).color);
      const small = getComputedStyle(probe).fontSize;
      probe.remove();
      /** Drawn in the destructive hue, at any opacity: its red, a red fill or a red border. */
      const red = (color: string) => {
        const [r, g, b, a] = rgba(color);
        return (
          a > 0 &&
          Math.abs(r - destructive[0]) < 30 &&
          Math.abs(g - destructive[1]) < 30 &&
          Math.abs(b - destructive[2]) < 30
        );
      };
      // The page, beside the app's own panels: those were read before the database went away.
      const scope =
        document.querySelector("[data-slot=sidebar-inset]") ?? document.body;
      const holders = [...scope.querySelectorAll("*")].filter(
        (element) =>
          element.checkVisibility() && element.textContent?.trim() === words,
      );
      const innermost = holders.filter(
        (element) =>
          !holders.some(
            (other) => other !== element && element.contains(other),
          ),
      );
      const says = innermost.map((holder) => {
        const style = getComputedStyle(holder);
        let boxedInRed = false;
        // The box a line is drawn in is the line itself or one of the few elements around it.
        for (
          let at: Element | null = holder, depth = 0;
          at && depth < 4;
          at = at.parentElement, depth++
        ) {
          const around = getComputedStyle(at);
          if (
            red(around.backgroundColor) ||
            (around.borderTopStyle !== "none" &&
              Number.parseFloat(around.borderTopWidth) > 0 &&
              red(around.borderTopColor))
          )
            boxedInRed = true;
        }
        return {
          red: red(style.color),
          boxedInRed,
          small: style.fontSize === small,
        };
      });
      const text = (scope as HTMLElement).innerText;
      return {
        says,
        empty: [...scope.querySelectorAll("[data-slot=empty]")]
          .filter((element) => element.checkVisibility())
          .map((element) => element.textContent?.trim() ?? ""),
        misleading: misleading.filter((line) => text.includes(line)),
      };
    },
    { words: UNAVAILABLE, misleading: MISLEADING },
  );
}

describe.skipIf(!asked)(
  "Admin, Settings and Skills pages while the organization's database is out of reach",
  () => {
    for (const engine of engines)
      for (const look of LOOKS)
        test(`each says the server's sentence calmly, once, with no empty state, in ${engine}, ${look.width}, ${look.theme}`, async () => {
          const server = new FakeServer();
          const page = await open(engine, look, server, "/");
          try {
            await page.getByRole("heading", { name: "Home" }).waitFor();
            // Out of reach for the whole test: nothing is asked again before it ends.
            server.holdSaid = UNAVAILABLE;
            server.retryAfterSeconds = 60;
            server.movingUntil = Number.POSITIVE_INFINITY;

            // Every page is looked at before anything is judged, so one run says all that is wrong.
            const seen: Record<string, unknown> = {};
            const wanted: Record<string, unknown> = {};
            for (const { path, name, once } of PAGES) {
              await go(page, path);
              await page
                .getByText(UNAVAILABLE, { exact: true })
                .first()
                .waitFor({ timeout: 8_000 })
                .catch(() => undefined);
              // Whatever else the page reads has been answered too, and drawn.
              await page.waitForTimeout(500);
              await shoot(
                page,
                "organization-unavailable-admin",
                name,
                engine,
                look,
              );
              const { says, empty, misleading } = await drawn(page);
              seen[path] = {
                said: says.length > 0,
                times: once ? says.length : "any",
                says,
                empty,
                misleading,
              };
              wanted[path] = {
                said: true,
                times: once ? 1 : "any",
                says: says.map(() => ({
                  red: false,
                  boxedInRed: false,
                  small: true,
                })),
                empty: [],
                misleading: [],
              };
            }
            expect(seen).toEqual(wanted);
          } finally {
            await page.close();
          }
        }, 120_000);

    // Northwind is reachable; the test's server has no setup or computers to give, and says so with 404.
    for (const engine of engines)
      test(`a real failure is still said in red, in ${engine}`, async () => {
        const server = new FakeServer();
        const look = LOOKS[0];
        const page = await open(engine, look, server, "/settings/setup");
        try {
          for (const [path, words] of [
            ["/settings/setup", "Couldn't check your setup. Check again."],
            [
              "/admin/computers",
              "Couldn't load the computers. Try again in a moment.",
            ],
          ] as const) {
            await go(page, path);
            await page
              .getByText(words, { exact: true })
              .waitFor({ timeout: 8_000 });
            await style(page);
            const color = await page.evaluate((said) => {
              const holder = [...document.querySelectorAll("body *")].find(
                (element) => element.textContent?.trim() === said,
              );
              const probe = document.createElement("span");
              probe.className = "text-destructive";
              document.body.append(probe);
              const destructive = getComputedStyle(probe).color;
              probe.remove();
              const box = holder?.closest("[role=alert]");
              return {
                drawn: holder ? getComputedStyle(holder).color : null,
                destructive,
                held: box?.hasAttribute("data-held") ?? false,
              };
            }, words);
            expect({ path, held: color.held }).toEqual({ path, held: false });
            if (path === "/settings/setup")
              expect(color.drawn).toBe(color.destructive);
          }
        } finally {
          await page.close();
        }
      }, 60_000);
  },
);

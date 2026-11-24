import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  alerts,
  asked,
  drawnColor,
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
 * While an organization's database can't be reached, every page that draws a failed read in the
 * error's own words says the server's sentence calmly, never in the destructive red.
 *
 * Found by the end-to-end test of database sharding, with one of two shards down: Routines said
 * "This organization is unavailable right now. Try again in a moment." muted, but Memory said it in
 * red, because Memory draws `error.message` itself rather than through the shared rule
 * (lib/load-failure.tsx). So did about two hundred other places. They all draw a failure through
 * `failureSaid` now, which keeps the error's own words for a real failure.
 *
 * In a real browser, Chromium and WebKit, at 1440 and 390 wide, light and dark: the person is on home
 * in Northwind when its database goes out of reach, and opens Memory, then Teams. Each says the
 * server's sentence once, not drawn in the destructive red. With Northwind reachable and Memory's
 * read failing for a real reason, Memory still says that failure in red.
 *
 *   OPENBOT_APP_BROWSER=1 OPENBOT_APP_ENGINES=chromium,webkit bun test app/tests/organization-unavailable-pages.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> each page is saved as organization-unavailable-<page>-<engine>-<width>-<theme>.png.
 */
beforeAll(async () => {
  if (asked) await start();
}, 120_000);

afterAll(async () => {
  await stop();
});

/** The words a page draws when its read is refused for a reason that isn't a hold. */
const NOT_FOUND = "Not found.";

describe.skipIf(!asked)(
  "Pages while the organization's database is out of reach",
  () => {
    for (const engine of engines)
      for (const look of LOOKS) {
        test(`Memory and Teams say the server's sentence calmly, in ${engine}, ${look.width}, ${look.theme}`, async () => {
          const server = new FakeServer();
          const page = await open(engine, look, server, "/");
          try {
            await page.getByRole("heading", { name: "Home" }).waitFor();
            // Out of reach for the whole test: nothing is asked again before it ends.
            server.holdSaid = UNAVAILABLE;
            server.retryAfterSeconds = 60;
            server.movingUntil = Number.POSITIVE_INFINITY;

            for (const [path, name] of [
              ["/memory", "memory"],
              ["/teams", "teams"],
            ] as const) {
              await go(page, path);
              await page
                .getByRole("alert")
                .filter({ hasText: UNAVAILABLE })
                .first()
                .waitFor({ timeout: 8_000 });
              await shoot(page, "organization-unavailable", name, engine, look);
              await style(page);
              expect({ path, alerts: await alerts(page) }).toEqual({
                path,
                alerts: [UNAVAILABLE],
              });
              const color = await drawnColor(page, UNAVAILABLE);
              expect({ path, drawn: color.drawn === null }).toEqual({
                path,
                drawn: false,
              });
              expect({ path, red: color.drawn === color.destructive }).toEqual({
                path,
                red: false,
              });
            }
          } finally {
            await page.close();
          }
        }, 60_000);

        test(`Memory still says a real failure in red, in ${engine}, ${look.width}, ${look.theme}`, async () => {
          // Northwind is reachable; the test's server has no memories to give, and says so with 404.
          const server = new FakeServer();
          const page = await open(engine, look, server, "/memory");
          try {
            await page
              .getByRole("alert")
              .filter({ hasText: NOT_FOUND })
              .first()
              .waitFor({ timeout: 8_000 });
            await style(page);
            const color = await drawnColor(page, NOT_FOUND);
            expect(color.drawn).not.toBeNull();
            expect(color.drawn).toBe(color.destructive);
          } finally {
            await page.close();
          }
        }, 60_000);
      }
  },
);

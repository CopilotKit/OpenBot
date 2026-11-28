import { afterAll, beforeAll, describe, expect } from "bun:test";
import type { Page } from "playwright-core";
import {
  alerts,
  asked,
  cutOff,
  engines,
  FakeServer,
  go,
  LOOKS,
  MOVING,
  open,
  shoot,
  start,
  stop,
  UNAVAILABLE,
} from "./organization-notices-browser";
import { test } from "./renderer-crash";

/**
 * A hold that lasts longer than one Retry-After: the page that was open fills in by itself once
 * OpenBot answers again, and the signed-in gate never reads the hold as terms to agree to.
 *
 * Found by the end-to-end test of database sharding, with one of two shards down for a few minutes:
 *
 * - Memory, open when the shard went down, still said "This organization is unavailable right now.
 *   Try again in a moment." two minutes after the shard came back. A read refused with Retry-After
 *   was asked again once, after the wait, and never again when that one was refused too
 *   (query-client.ts). It is asked again after each Retry-After now, for as long as the hold lasts.
 * - Back to app, or opening Teams a second time, sometimes landed on "Agree to the terms". The gate
 *   had to read the terms again (the app drops an answer nothing has shown for five minutes) and read
 *   the refused read as terms not agreed to (lib/service-terms/queries.ts). A hold is said now as
 *   every other page says it, on the calm "Back in a moment" page, which goes on by itself.
 *
 * In a real browser, Chromium and WebKit, at 1440 and 390 wide, light and dark, for both sentences.
 *
 *   OPENBOT_APP_BROWSER=1 OPENBOT_APP_ENGINES=chromium,webkit bun test app/tests/organization-held-recovery.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> each step is saved as organization-held-<step>-<engine>-<width>-<theme>.png.
 */
const HOLDS = [
  { name: "moving", said: MOVING },
  { name: "unavailable", said: UNAVAILABLE },
] as const;

/** How long each hold lasts from the first request it refuses: several of its one-second Retry-Afters. */
const HOLD_MS = 3_500;

beforeAll(async () => {
  if (asked) await start();
}, 120_000);

afterAll(async () => {
  await stop();
});

function pathOf(page: Page): string {
  return new URL(page.url()).pathname;
}

describe.skipIf(!asked)("a hold longer than one Retry-After", () => {
  for (const engine of engines)
    for (const hold of HOLDS)
      for (const look of LOOKS) {
        test(`${hold.name}: the open page fills in by itself once OpenBot answers, in ${engine}, ${look.width}, ${look.theme}`, async () => {
          const server = new FakeServer();
          const page = await open(engine, look, server, "/");
          try {
            await page.getByRole("heading", { name: "Home" }).waitFor();
            server.holdSaid = hold.said;
            server.retryAfterSeconds = 1;
            server.holdFromFirstRefusal(HOLD_MS);
            await go(page, "/routines");

            await page
              .getByRole("alert")
              .filter({ hasText: hold.said })
              .first()
              .waitFor({ timeout: 5_000 });
            await shoot(
              page,
              "organization-held",
              `${hold.name}-open-during`,
              engine,
              look,
            );

            // Nothing pressed: refused again and again while the hold lasts, then the page is back.
            await page
              .getByText("Northwind check", { exact: true })
              .waitFor({ timeout: 10_000 });
            // Every read on the page goes on by itself, each after its own Retry-After: the list can
            // be back while another read is still waiting out its second. On a loaded machine that
            // second ran past the list, and a one-shot look caught the sentence just before it went.
            await page
              .getByRole("alert")
              .filter({ hasText: hold.said })
              .first()
              .waitFor({ state: "detached", timeout: 5_000 })
              .catch(() => undefined);
            expect(await alerts(page)).toEqual([]);
            // Asked again once per Retry-After, one read at a time: never a storm.
            const refused = server.refusedForMove.get("/routines") ?? 0;
            expect(refused).toBeGreaterThanOrEqual(3);
            expect(refused).toBeLessThanOrEqual(6);
            expect(await cutOff(page)).toEqual({ sideways: false, cut: [] });
            await shoot(
              page,
              "organization-held",
              `${hold.name}-open-after`,
              engine,
              look,
            );
          } finally {
            await page.close();
          }
        }, 60_000);

        test(`${hold.name}: the terms gate says the hold, never terms to agree to, in ${engine}, ${look.width}, ${look.theme}`, async () => {
          const server = new FakeServer();
          // OpenBot Cloud, and Dana agreed to its terms long ago.
          server.cloudTerms = true;
          const page = await open(engine, look, server, "/");
          try {
            await page.getByRole("heading", { name: "Home" }).waitFor();
            server.holdSaid = hold.said;
            server.retryAfterSeconds = 1;
            server.holdFromFirstRefusal(HOLD_MS);
            // Nothing has shown the terms for five minutes, so the app no longer keeps them.
            await page.evaluate(() =>
              (
                window as unknown as {
                  openbotQueryClient: {
                    removeQueries: (filters: { queryKey: string[] }) => void;
                  };
                }
              ).openbotQueryClient.removeQueries({
                queryKey: ["service-terms"],
              }),
            );
            await go(page, "/teams");

            // Whichever the gate shows: the hold, or (as it did) the terms.
            await page
              .getByText(/^(Back in a moment|Agree to the terms)$/)
              .first()
              .waitFor({ timeout: 5_000 });
            await shoot(
              page,
              "organization-held",
              `${hold.name}-gate-during`,
              engine,
              look,
            );
            expect(pathOf(page)).not.toBe("/terms");
            expect(await page.getByText("Agree to the terms").count()).toBe(0);
            await page
              .getByRole("heading", { name: "Back in a moment" })
              .waitFor();
            await page
              .getByRole("status")
              .filter({ hasText: hold.said })
              .waitFor();
            expect(await page.getByText("Something went wrong").count()).toBe(
              0,
            );
            expect(await cutOff(page)).toEqual({ sideways: false, cut: [] });

            // Nothing pressed: once OpenBot answers again, Teams opens, never the terms.
            await page
              .getByText("Operations", { exact: true })
              .first()
              .waitFor({ timeout: 10_000 });
            expect(pathOf(page)).toBe("/teams");
            expect(
              await page
                .getByRole("heading", { name: "Back in a moment" })
                .count(),
            ).toBe(0);
            expect(await page.getByText("Agree to the terms").count()).toBe(0);
            await shoot(
              page,
              "organization-held",
              `${hold.name}-gate-after`,
              engine,
              look,
            );
          } finally {
            await page.close();
          }
        }, 60_000);
      }
});

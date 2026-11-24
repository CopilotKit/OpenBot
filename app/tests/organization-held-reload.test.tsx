import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  asked,
  cutOff,
  engines,
  FakeServer,
  LOOKS,
  MOVING,
  open,
  shoot,
  start,
  stop,
  UNAVAILABLE,
} from "./organization-notices-browser";

/**
 * Loading the page while OpenBot holds an organization off says OpenBot's own sentence on a calm
 * page and loads again by itself, never the error screen.
 *
 * Found by the end-to-end test of database sharding: reloading organization settings while the
 * organization was being moved showed "Something went wrong" with "ClientError: OpenBot is moving
 * this organization." and a stack trace to copy. The same happens while an organization's database
 * can't be reached. Both are the server answering as it should: 503, a sentence for people, and
 * Retry-After.
 *
 * In a real browser, Chromium and WebKit, at 1440 and 390 wide, light and dark, for both sentences:
 * the person is on Routines in Northwind and reloads while it is held. The page says the server's
 * sentence under "Back in a moment", with nothing about an error, and once the hold is over it shows
 * Northwind's routine again without anything being pressed.
 *
 *   OPENBOT_APP_BROWSER=1 OPENBOT_APP_ENGINES=chromium,webkit bun test app/tests/organization-held-reload.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> each step is saved as organization-held-<step>-<engine>-<width>-<theme>.png.
 */
const HOLDS = [
  { name: "moving", said: MOVING },
  { name: "unavailable", said: UNAVAILABLE },
] as const;

beforeAll(async () => {
  if (asked) await start();
}, 120_000);

afterAll(async () => {
  await stop();
});

describe.skipIf(!asked)("reloading while the organization is held", () => {
  for (const engine of engines)
    for (const hold of HOLDS)
      for (const look of LOOKS)
        test(`${hold.name}: says OpenBot's sentence calmly and loads again by itself, in ${engine}, ${look.width}, ${look.theme}`, async () => {
          const server = new FakeServer();
          const page = await open(engine, look, server, "/routines");
          try {
            await page.getByText("Northwind check", { exact: true }).waitFor();
            // The hold begins, and lasts less than the Retry-After it answers with.
            server.holdSaid = hold.said;
            server.retryAfterSeconds = 2;
            server.holdFromFirstRefusal(1_200);
            await page.reload();

            await page
              .getByRole("status")
              .filter({ hasText: hold.said })
              .waitFor({ timeout: 5_000 });
            // Shot while it holds, before anything else is asserted.
            await shoot(
              page,
              "organization-held",
              `${hold.name}-during`,
              engine,
              look,
            );
            await page
              .getByRole("heading", { name: "Back in a moment" })
              .waitFor();
            expect(await page.getByText("Something went wrong").count()).toBe(
              0,
            );
            expect(
              await page.getByRole("button", { name: "Copy details" }).count(),
            ).toBe(0);
            expect(await cutOff(page)).toEqual({ sideways: false, cut: [] });

            // Nothing pressed: once OpenBot answers again, the page is back.
            await page
              .getByText("Northwind check", { exact: true })
              .waitFor({ timeout: 8_000 });
            expect(
              await page
                .getByRole("heading", { name: "Back in a moment" })
                .count(),
            ).toBe(0);
            await shoot(
              page,
              "organization-held",
              `${hold.name}-after`,
              engine,
              look,
            );
          } finally {
            await page.close();
          }
        }, 60_000);
});

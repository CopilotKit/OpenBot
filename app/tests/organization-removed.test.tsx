import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  alerts,
  asked,
  cutOff,
  engines,
  FakeServer,
  go,
  LOOKS,
  OWN,
  open,
  shoot,
  start,
  stop,
} from "./organization-notices-browser";

/**
 * Somebody removed from the organization they are working in is told so, plainly, and is taken to
 * one they are still in.
 *
 * Found by the end-to-end test of database sharding: an admin removed a person while they had
 * OpenBot open. Their next page, Routines, said "Couldn't load your routines and goals and
 * check-ins. Try again in a moment." and stayed in the organization they were no longer in, which
 * reads like a glitch. The server had already answered: an address that names the organization
 * answers as one that doesn't exist (404 `ORGANIZATION_NOT_FOUND`), one the session decides 403 in
 * its sentence, and their organizations no longer list it.
 *
 * In a real browser, Chromium and WebKit, at 1440 and 390 wide, light and dark, for each of those
 * two refusals: the person is on home in Northwind when they are removed, and opens Routines. The
 * app reads their organizations again, moves the session to their own, takes them home there with a
 * bar saying "You're no longer a member of Northwind Freight. You're now working in Dana's
 * organization.", and Routines then shows their own organization's routine. Dismiss closes the bar.
 *
 *   OPENBOT_APP_BROWSER=1 OPENBOT_APP_ENGINES=chromium,webkit bun test app/tests/organization-removed.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> each step is saved as organization-removed-<step>-<engine>-<width>-<theme>.png.
 */
const NOTICE =
  "You're no longer a member of Northwind Freight. You're now working in Dana's organization.";

beforeAll(async () => {
  if (asked) await start();
}, 120_000);

afterAll(async () => {
  await stop();
});

describe.skipIf(!asked)("removed from the organization while in it", () => {
  for (const engine of engines)
    for (const refusal of ["404", "403"] as const)
      for (const look of LOOKS) {
        // Every look for the API's own refusal; the session's 403 at the desktop width alone.
        if (refusal === "403" && look.width !== 1440) continue;
        test(`refused ${refusal}, says so and lands in their own organization, in ${engine}, ${look.width}, ${look.theme}`, async () => {
          const server = new FakeServer();
          const page = await open(engine, look, server, "/");
          try {
            await page.getByRole("heading", { name: "Home" }).waitFor();
            // An admin removes them.
            server.removed = refusal;
            await go(page, "/routines");

            const bar = page.getByRole("complementary", {
              name: "Organization",
            });
            await bar
              .getByText(NOTICE, { exact: true })
              .waitFor({ timeout: 8_000 });
            await page.getByRole("heading", { name: "Home" }).waitFor();
            // Shot before anything else is asserted.
            await shoot(
              page,
              "organization-removed",
              `home-${refusal}`,
              engine,
              look,
            );
            expect(server.switched).toEqual([OWN.id]);
            expect(new URL(page.url()).pathname).toBe("/");
            expect(await alerts(page)).toEqual([]);
            expect(await cutOff(page)).toEqual({ sideways: false, cut: [] });

            // Routines is their own organization's now.
            await go(page, "/routines");
            await page
              .getByText("Morning briefing", { exact: true })
              .waitFor({ timeout: 5_000 });
            expect(await page.getByText("Northwind check").count()).toBe(0);
            expect(await alerts(page)).toEqual([]);
            await shoot(
              page,
              "organization-removed",
              `routines-${refusal}`,
              engine,
              look,
            );

            await bar.getByRole("button", { name: "Dismiss" }).click();
            await bar.waitFor({ state: "detached" });
          } finally {
            await page.close();
          }
        }, 60_000);
      }
});

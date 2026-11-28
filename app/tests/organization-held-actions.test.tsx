import { afterAll, beforeAll, describe, expect } from "bun:test";
import type { Page } from "playwright-core";
import {
  asked,
  drawnColor,
  engines,
  FakeServer,
  go,
  LOOKS,
  type Look,
  open,
  shoot,
  start,
  stop,
  TEAM,
  UNAVAILABLE,
} from "./organization-notices-browser";
import { test } from "./renderer-crash";

/**
 * A press refused because the organization's database is out of reach says the server's sentence
 * calmly, never in the destructive red.
 *
 * Pages that draw a failed read went through the shared rule (lib/load-failure.tsx) already
 * (organization-unavailable-pages.test.tsx), but a press kept only the error's words in its state
 * and drew them red later, so the hold was lost before anything was drawn: adding somebody to a team
 * said "This organization is unavailable right now. Try again in a moment." in red, and so did
 * creating a Bot from the card a Bot puts in a conversation. Each keeps the error itself now.
 *
 * In a real browser, Chromium and WebKit, at 1440 and 390 wide, light and dark: Northwind's reads are
 * answered and its writes refused with the hold. The person adds Priya to Operations, then presses
 * Create it on a proposed Bot. Each says the server's sentence once, not drawn in the destructive red.
 * With Northwind reachable and the create refused for a real reason, the card still says it in red.
 *
 *   OPENBOT_APP_BROWSER=1 OPENBOT_APP_ENGINES=chromium,webkit bun test app/tests/organization-held-actions.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> each step is saved as organization-held-<step>-<engine>-<width>-<theme>.png.
 */
beforeAll(async () => {
  if (asked) await start();
}, 120_000);

afterAll(async () => {
  await stop();
});

/** The words a press draws when it is refused for a reason that isn't a hold. */
const NOT_FOUND = "Not found.";

/** The server's sentence is said in an alert, once, and not in the destructive red. */
async function saidCalmly(
  page: Page,
  where: string,
  engine: string,
  look: Look,
): Promise<void> {
  const alert = page.getByRole("alert").filter({ hasText: UNAVAILABLE });
  await alert.first().waitFor({ timeout: 8_000 });
  await shoot(page, "organization-held", where, engine, look);
  expect({ where, said: await alert.count() }).toEqual({ where, said: 1 });
  const color = await drawnColor(page, UNAVAILABLE);
  expect({ where, drawn: color.drawn === null }).toEqual({
    where,
    drawn: false,
  });
  expect({ where, red: color.drawn === color.destructive }).toEqual({
    where,
    red: false,
  });
}

describe.skipIf(!asked)(
  "A press while the organization's database is out of reach",
  () => {
    for (const engine of engines)
      for (const look of LOOKS) {
        test(`adding somebody to a team says the server's sentence calmly, in ${engine}, ${look.width}, ${look.theme}`, async () => {
          const server = new FakeServer();
          const page = await open(engine, look, server, `/teams/${TEAM.id}`);
          try {
            await page
              .getByRole("heading", { name: TEAM.name })
              .first()
              .waitFor();
            server.holdWrites = true;
            server.holdSaid = UNAVAILABLE;
            server.retryAfterSeconds = 60;
            await page
              .getByRole("button", { name: "Add person" })
              .first()
              .click();
            await page.getByRole("dialog").getByRole("combobox").fill("Priya");
            // Chosen as a person does from the box: the best match is highlighted, and Enter adds them.
            await page.getByRole("option", { name: /Priya Shah/ }).waitFor();
            await page.getByRole("dialog").getByRole("combobox").press("Enter");
            await saidCalmly(page, "add-to-team", engine, look);
            expect(server.wrote).toContain(
              `PUT /teams/${TEAM.id}/members/priya`,
            );
          } finally {
            await page.close();
          }
        }, 60_000);

        test(`creating a Bot says the server's sentence calmly, in ${engine}, ${look.width}, ${look.theme}`, async () => {
          const server = new FakeServer();
          const page = await open(engine, look, server, "/");
          try {
            await page.getByRole("heading", { name: "Home" }).waitFor();
            await go(page, "/propose-bot");
            const create = page.getByRole("button", { name: "Create it" });
            await create.waitFor();
            server.holdWrites = true;
            server.holdSaid = UNAVAILABLE;
            server.retryAfterSeconds = 60;
            await create.click();
            await saidCalmly(page, "create-bot", engine, look);
            expect(server.wrote).toContain("POST /bots");
          } finally {
            await page.close();
          }
        }, 60_000);

        test(`a press refused for a real reason still says it in red, in ${engine}, ${look.width}, ${look.theme}`, async () => {
          // Northwind is reachable; the test's server takes no writes, and says so with 404.
          const server = new FakeServer();
          const page = await open(engine, look, server, "/");
          try {
            await page.getByRole("heading", { name: "Home" }).waitFor();
            await go(page, "/propose-bot");
            await page.getByRole("button", { name: "Create it" }).click();
            await page
              .getByRole("alert")
              .filter({ hasText: NOT_FOUND })
              .first()
              .waitFor({ timeout: 8_000 });
            await shoot(
              page,
              "organization-held",
              "real-failure",
              engine,
              look,
            );
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

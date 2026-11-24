import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
} from "./organization-notices-browser";

/**
 * While OpenBot moves an organization between databases, its screens say so in OpenBot's own
 * sentence, and fill in by themselves once the move is over.
 *
 * Found by the end-to-end test of database sharding: during a move the server answers the
 * organization's requests 503 with "OpenBot is moving this organization. Try again in a moment." and
 * Retry-After. Memory showed that sentence. Routines showed its own "Couldn't load your routines and
 * goals and check-ins. Try again in a moment.", which reads like a fault, and stayed that way after
 * the move ended until the person left the page and came back.
 *
 * In a real browser, Chromium and WebKit, at 1440 and 390 wide, light and dark: the person is on
 * home in Northwind when its move begins, and opens Routines. Each of the page's reads is refused
 * once, the page says the server's sentence and nothing of its own, and after the Retry-After the
 * page fills in with Northwind's routine without anything being pressed.
 *
 *   OPENBOT_APP_BROWSER=1 OPENBOT_APP_ENGINES=chromium,webkit bun test app/tests/organization-moving.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> each step is saved as organization-moving-<step>-<engine>-<width>-<theme>.png.
 */
beforeAll(async () => {
  if (asked) await start();
}, 120_000);

afterAll(async () => {
  await stop();
});

describe.skipIf(!asked)("Routines while the organization is moved", () => {
  for (const engine of engines)
    for (const look of LOOKS)
      test(`says OpenBot's sentence and fills in after Retry-After, in ${engine}, ${look.width}, ${look.theme}`, async () => {
        const server = new FakeServer();
        const page = await open(engine, look, server, "/");
        try {
          await page.getByRole("heading", { name: "Home" }).waitFor();
          // The move begins, and lasts less than the Retry-After it answers with.
          server.retryAfterSeconds = 2;
          server.movingUntil = Date.now() + 1_200;
          await go(page, "/routines");
          await page
            .getByRole("alert")
            .filter({ hasText: MOVING })
            .first()
            .waitFor({ timeout: 5_000 });
          // Shot while the move holds, before anything else is asserted.
          await shoot(page, "organization-moving", "during", engine, look);
          // Said once for the page, never twice, and nothing in the page's own words.
          expect(await alerts(page)).toEqual([MOVING]);
          expect(await cutOff(page)).toEqual({ sideways: false, cut: [] });

          // Nothing pressed: the page fills in once OpenBot answers again.
          await page
            .getByText("Northwind check", { exact: true })
            .waitFor({ timeout: 6_000 });
          await page
            .getByRole("switch", { name: "Check-ins for all your Bots" })
            .waitFor({ timeout: 3_000 });
          expect(await alerts(page)).toEqual([]);
          await shoot(page, "organization-moving", "after", engine, look);
          expect(await cutOff(page)).toEqual({ sideways: false, cut: [] });

          // Each read was refused once: not retried at once, asked again once after Retry-After.
          for (const read of ["/routines", "/goals", "/check-ins"])
            expect({ read, refused: server.refusedForMove.get(read) }).toEqual({
              read,
              refused: 1,
            });
        } finally {
          await page.close();
        }
      }, 60_000);
});

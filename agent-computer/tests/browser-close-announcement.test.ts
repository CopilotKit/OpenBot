import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every way a Bot's browser closes tells whoever was watching it.
 *
 * `live-screen.test.ts` covers the two closes a request makes, and it cannot cover the other two: the
 * cap closes a browser after somebody else's launch, and the idle sweep closes one on a timer, and
 * neither is reachable by asking this process for anything. There is deliberately no endpoint that
 * triggers them, so this drives `createProfiles` itself.
 *
 * They matter because a viewer that outlives a close keeps a loop asking for a page every second,
 * and asking for a page starts a browser. A Bot with somebody watching was therefore immune to the
 * idle timeout and came straight back after a cap eviction, which is the same failure the stop
 * handler had, arriving by a route no handler is on. Hanging the announcement off the close itself
 * is what covers these without anybody having to remember them.
 *
 * ASKED FOR BY NAME for the same reason as `live-screen.test.ts`: `profiles.ts` imports Playwright at
 * module scope and CI does not install this directory's dependencies.
 *
 *   bun run test:live-screen
 */

const asked = process.env.OPENBOT_LIVE_SCREEN === "1";

let root = "";

beforeAll(async () => {
  if (!asked) return;
  root = await mkdtemp(join(tmpdir(), "agent-computer-closes-"));
});

afterAll(async () => {
  if (!asked) return;
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(!asked)(
  "a browser closed by something nobody asked for",
  () => {
    test("the idle sweep tells whoever was watching", async () => {
      // The shortest timeout the sweep will act on. Zero disables it, because a timeout of nothing
      // means the feature is off rather than that everything is idle.
      process.env.COMPUTER_BROWSER_IDLE_MS = "1";
      const { createProfiles } = await import("../src/profiles");
      const told: string[] = [];
      const profiles = createProfiles(join(root, "idle"), (botId) => {
        told.push(botId);
      });

      await profiles.page("swept");
      expect(profiles.liveCount()).toBe(1);

      // Past the timeout, so the browser counts as idle rather than as just-used.
      await new Promise((resolve) => setTimeout(resolve, 25));
      await profiles.sweepIdleNow();

      expect(told).toEqual(["swept"]);
      expect(profiles.liveCount()).toBe(0);
      await profiles.closeAll();
    }, 60_000);

    test("the cap tells the Bot whose browser it closed", async () => {
      // One browser allowed, so the second Bot's launch is what closes the first Bot's browser. The
      // person watching the first one never asked for anything and is owed the message just the same.
      process.env.COMPUTER_BROWSER_IDLE_MS = String(30 * 60_000);
      process.env.COMPUTER_MAX_BROWSERS = "1";
      // A fresh module registry, because the cap and the timeout are read when the module loads.
      const { createProfiles } = (await import(
        `../src/profiles?cap=${Date.now()}`
      )) as typeof import("../src/profiles");
      const told: string[] = [];
      const profiles = createProfiles(join(root, "cap"), (botId) => {
        told.push(botId);
      });

      await profiles.page("first");
      await profiles.page("second");

      expect(told).toEqual(["first"]);
      await profiles.closeAll();
    }, 60_000);
  },
);

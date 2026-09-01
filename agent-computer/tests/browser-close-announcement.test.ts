import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
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
/*
 * Both knobs are read when `profiles.ts` loads, so each case imports its own copy of the module and
 * puts the environment back afterwards. Bun shares one module registry across every test file in a
 * run and does not honour the order they are named on the command line, so a module imported without
 * a fresh specifier is whatever an earlier file already loaded, and a knob left set leaks into
 * whatever loads next.
 */
const IDLE = "COMPUTER_BROWSER_IDLE_MS";
const CAP = "COMPUTER_MAX_BROWSERS";
const before: Record<string, string | undefined> = {};

beforeAll(async () => {
  if (!asked) return;
  before[IDLE] = process.env[IDLE];
  before[CAP] = process.env[CAP];
  root = await mkdtemp(join(tmpdir(), "agent-computer-closes-"));
});

afterAll(async () => {
  if (!asked) return;
  for (const name of [IDLE, CAP]) {
    const original = before[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(!asked)(
  "a browser closed by something nobody asked for",
  () => {
    test("a native browser close is forgotten immediately and tells whoever was watching", async () => {
      process.env.COMPUTER_BROWSER_IDLE_MS = String(30 * 60_000);
      const { createProfiles } = (await import(
        `../src/profiles?native-close=${Date.now()}`
      )) as typeof import("../src/profiles");
      const told: string[] = [];
      const profiles = createProfiles(join(root, "native-close"), (botId) => {
        told.push(botId);
      });

      const page = await profiles.page("closer");
      expect(profiles.liveCount()).toBe(1);

      // Chromium's X button closes the persistent context without passing through `profiles.stop`.
      await page.context().close();
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(profiles.liveCount()).toBe(0);
      expect(told).toEqual(["closer"]);
      await profiles.closeAll();
    }, 60_000);

    test("the idle sweep tells whoever was watching", async () => {
      // The shortest timeout the sweep will act on. Zero disables it, because a timeout of nothing
      // means the feature is off rather than that everything is idle.
      process.env.COMPUTER_BROWSER_IDLE_MS = "1";
      // Its own copy, for the reason given above the hooks.
      const { createProfiles } = (await import(
        `../src/profiles?idle=${Date.now()}`
      )) as typeof import("../src/profiles");
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

    test("a stop that lands while the browser is still starting still closes it", async () => {
      // The window the request path fell through. `evict` only knows about browsers already running,
      // and a launch does not land there until it finishes, so a stop arriving first answered
      // "nothing was running" and left the browser up a moment later with the live screen still on
      // it. Reset was worse, deleting the profile directory the finishing launch recreated.
      process.env.COMPUTER_BROWSER_IDLE_MS = String(30 * 60_000);
      const { createProfiles } = (await import(
        `../src/profiles?racing=${Date.now()}`
      )) as typeof import("../src/profiles");
      const told: string[] = [];
      const profiles = createProfiles(join(root, "racing"), (botId) => {
        told.push(botId);
      });

      // Deliberately not awaited: the stop is issued while the launch is still in flight.
      const launching = profiles.page("racer");
      const stopped = await profiles.stop("racer");
      await launching.catch(() => undefined);

      expect(stopped).toBe(true);
      expect(told).toEqual(["racer"]);
      expect(profiles.liveCount()).toBe(0);
      await profiles.closeAll();
    }, 60_000);

    test("a reset that lands while the browser is still starting wipes it for good", async () => {
      // Reset had the same hole as stop and a worse consequence: it closed nothing, deleted the
      // profile directory, and then the launch it never waited for finished and recreated the
      // directory it had just wiped, leaving the Bot signed into everything it was meant to forget.
      process.env.COMPUTER_BROWSER_IDLE_MS = String(30 * 60_000);
      const { createProfiles } = (await import(
        `../src/profiles?resetting=${Date.now()}`
      )) as typeof import("../src/profiles");
      const told: string[] = [];
      const root2 = join(root, "resetting");
      const profiles = createProfiles(root2, (botId) => {
        told.push(botId);
      });

      // Not awaited: the reset is issued into the middle of the launch.
      const launching = profiles.page("wiper");
      await profiles.reset("wiper");
      await launching.catch(() => undefined);

      expect(told).toEqual(["wiper"]);
      expect(profiles.liveCount()).toBe(0);
      // The directory stays gone rather than being recreated by the launch that finished after it.
      await expect(stat(join(root2, "wiper"))).rejects.toThrow();
      await profiles.closeAll();
    }, 60_000);

    test("the cap tells the Bot whose browser it closed", async () => {
      // One browser allowed, so the second Bot's launch is what closes the first Bot's browser. The
      // person watching the first one never asked for anything and is owed the message just the same.
      process.env.COMPUTER_BROWSER_IDLE_MS = String(30 * 60_000);
      process.env.COMPUTER_MAX_BROWSERS = "1";
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

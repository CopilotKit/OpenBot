import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryReading } from "../src/container-memory";

/**
 * A computer that closes browsers before its memory runs out, and a Bot's tabs it left behind.
 *
 * The cap counted browsers and the idle sweep counted minutes, and neither looked at memory, so a few
 * heavy pages could take a container past its limit, where the OOM killer takes every browser on it
 * at once rather than one. These drive `createProfiles` with real Chromium, handing it the memory
 * reading a container would give, because the closes they cover are made from inside another Bot's
 * launch and from the idle sweep, and no request reaches either.
 *
 * Asked for by name, like the other tests that launch a real Chromium:
 *
 *   cd agent-computer && bunx playwright install chromium
 *   OPENBOT_COMPUTER_BROWSER=1 COMPUTER_BROWSER_MODE=headless bun test tests/browser-memory.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";
const LAUNCH_TIMEOUT_MS = 120_000;

const html = (title: string) =>
  new Response(`<!doctype html><title>${title}</title><body>${title}</body>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
const site = Bun.serve({
  port: 0,
  fetch(request) {
    return html(new URL(request.url).pathname.slice(1) || "home");
  },
});
const origin = `http://127.0.0.1:${site.port}`;

const roots: string[] = [];
const said = spyOn(console, "info");

afterEach(() => {
  said.mockClear();
});

afterAll(async () => {
  site.stop(true);
  said.mockRestore();
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** The structured lines the computer logged of one type. */
function logged(type: string): Record<string, unknown>[] {
  return said.mock.calls
    .map(([line]) => {
      try {
        return JSON.parse(String(line)) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .filter((line): line is Record<string, unknown> => line?.type === type);
}

async function profilesFor(
  name: string,
  options: Parameters<typeof import("../src/profiles").createProfiles>[2],
) {
  const { createProfiles } = await import("../src/profiles");
  const root = await mkdtemp(join(tmpdir(), `openbot-${name}-`));
  roots.push(root);
  const told: string[] = [];
  const profiles = createProfiles(
    root,
    (botId) => {
      told.push(botId);
    },
    options,
  );
  return { profiles, told };
}

/**
 * A container where each running browser holds the same 450 MiB of a 1000 MiB limit, read from how
 * many are running now, as the cgroup would read it. Two browsers are 90% (high at 85), one is 45%.
 */
const MIB = 1024 ** 2;
const LIMIT = 1000 * MIB;
const PER_BROWSER = 450 * MIB;
const perBrowser =
  (running: () => number) => async (): Promise<MemoryReading> => ({
    workingSet: running() * PER_BROWSER,
    limit: LIMIT,
  });

describe.skipIf(!asked)("closing browsers when memory runs high", () => {
  test(
    "a launch on a computer whose memory runs high closes the least recently used first, never the one launching",
    async () => {
      let profiles: Awaited<ReturnType<typeof profilesFor>>["profiles"];
      const made = await profilesFor("memory", {
        memory: perBrowser(() => profiles.liveCount()),
        memoryHighPercent: 85,
      });
      profiles = made.profiles;
      try {
        // One browser is 45%: the second launches without anything being closed.
        await profiles.page("first");
        await profiles.page("second");
        expect(made.told).toEqual([]);
        // The first is used again, so the second is now the least recently used: by use, not by
        // which started first. A moment later, because use is kept to the millisecond and the
        // second's launch can finish inside the same one.
        await new Promise((resolve) => setTimeout(resolve, 5));
        await profiles.page("first");

        // Two browsers are 90%. The third Bot's launch closes the second, reads 45%, and launches.
        const third = await profiles.page("third");

        expect(made.told).toEqual(["second"]);
        expect(profiles.isLive("first")).toBe(true);
        expect(profiles.isLive("second")).toBe(false);
        expect(profiles.isLive("third")).toBe(true);
        expect(third.isClosed()).toBe(false);
        expect(logged("computer-browser-closed-for-memory")).toEqual([
          {
            type: "computer-browser-closed-for-memory",
            botId: "second",
            workingSetBytes: 2 * PER_BROWSER,
            limitBytes: LIMIT,
          },
        ]);
      } finally {
        await made.profiles.closeAll();
      }
    },
    LAUNCH_TIMEOUT_MS,
  );

  test(
    "a browser a person is working in stays, and memory that will not come down never closes the last browser",
    async () => {
      // Memory that reads high whatever is closed: one browser too big on its own. The loop has to
      // stop at the newest, not close its way to nothing.
      const made = await profilesFor("memory-held", {
        memory: async () => ({ workingSet: LIMIT, limit: LIMIT }),
        memoryHighPercent: 85,
        heldByPerson: (botId) => botId === "held",
      });
      const { profiles } = made;
      try {
        await profiles.page("held");
        await profiles.page("other");
        // Both are live before the third arrives: launching "other" closed nothing it could, because
        // the only other browser was the one a person holds.
        expect(made.told).toEqual([]);

        await profiles.page("asking");
        // "other" goes; "held" is a person's, and "asking" is the launch itself.
        expect(made.told).toEqual(["other"]);
        expect(profiles.isLive("held")).toBe(true);
        expect(profiles.isLive("asking")).toBe(true);

        // The idle sweep's tick reads the same and closes nothing more: what is left is held, or the
        // newest.
        await profiles.sweepIdleNow();
        expect(made.told).toEqual(["other"]);
        expect(profiles.liveCount()).toBe(2);
      } finally {
        await profiles.closeAll();
      }
    },
    LAUNCH_TIMEOUT_MS,
  );
});

describe.skipIf(!asked)("closing a Bot's idle background tabs", () => {
  test(
    "the sweep closes a background tab left past the timeout, and the Bot stays on its page",
    async () => {
      let held = true;
      const made = await profilesFor("tabs", {
        memory: async () => undefined,
        // The shortest timeout the sweep acts on, so the test waits milliseconds rather than ten minutes.
        tabIdleMs: 1,
        heldByPerson: () => held,
      });
      const { profiles } = made;
      try {
        const behind = await profiles.page("tabs");
        await behind.goto(`${origin}/left-behind`, {
          waitUntil: "domcontentloaded",
        });
        const front = await behind.context().newPage();
        await front.goto(`${origin}/in-front`, {
          waitUntil: "domcontentloaded",
        });
        // The new tab is the Bot's page now, as a window a site opens would be.
        expect(await profiles.page("tabs")).toBe(front);
        await new Promise((resolve) => setTimeout(resolve, 25));

        // A person holds the wheel: they may be working across these tabs, so nothing is closed.
        await profiles.sweepIdleNow();
        expect(behind.isClosed()).toBe(false);

        held = false;
        await new Promise((resolve) => setTimeout(resolve, 25));
        said.mockClear();
        await profiles.sweepIdleNow();

        expect(behind.isClosed()).toBe(true);
        expect(front.isClosed()).toBe(false);
        expect(front.context().pages()).toEqual([front]);
        expect(logged("computer-tab-closed")).toEqual([
          {
            type: "computer-tab-closed",
            botId: "tabs",
            reason: "it had been idle",
          },
        ]);
        // Still the Bot's page: the record never moved, and the browser was not closed.
        expect(logged("computer-page-changed")).toEqual([]);
        const after = await profiles.page("tabs");
        expect(after).toBe(front);
        expect(after.url()).toBe(`${origin}/in-front`);
        expect(made.told).toEqual([]);
      } finally {
        await profiles.closeAll();
      }
    },
    LAUNCH_TIMEOUT_MS,
  );
});

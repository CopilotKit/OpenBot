import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
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

const MIB = 1024 ** 2;
const LIMIT = 1000 * MIB;
const MINUTE = 60_000;
const PERSON = "person-0123456789abcdef0123456789abcdef";

/**
 * A container whose memory is its browsers, read the way the cgroup reads it.
 *
 * Each browser holds the same share, counted while its Chromium is still connected, because that is
 * when the kernel gives its memory back: when the process exits, seconds after the computer took it
 * out of its map, not at the moment it decided to close it. The browsers are real; only their size
 * is set, so a test can say how many fit.
 */
function containerOf(percentEach: number) {
  const contexts = new Set<BrowserContext>();
  return {
    /** Count this page's browser from now on. */
    holds(page: Page): Page {
      contexts.add(page.context());
      return page;
    },
    memory: async (): Promise<MemoryReading> => ({
      workingSet:
        [...contexts].filter((context) => context.browser()?.isConnected())
          .length *
        percentEach *
        10 *
        MIB,
      limit: LIMIT,
    }),
  };
}

/**
 * A clock that can be moved on, so every browser used so far reads as quiet for as long as a test
 * says, without the test waiting a minute for the window in which a browser counts as in use.
 */
function clock() {
  let ahead = 0;
  return {
    now: () => Date.now() + ahead,
    passes(ms: number) {
      ahead += ms;
    },
  };
}

const closedForMemory = () =>
  logged("computer-browser-closed-for-memory").map((line) => line.botId);

describe.skipIf(!asked)("closing browsers when memory runs high", () => {
  test(
    "a Bot used seconds ago is not closed when another launches; the quiet ones are",
    async () => {
      // Two browsers are 90%, over the line at 85.
      const container = containerOf(45);
      const time = clock();
      const { profiles, told } = await profilesFor("memory-recent", {
        memory: container.memory,
        now: time.now,
      });
      const open = async (botId: string) =>
        container.holds(await profiles.page(botId));
      try {
        await open("first");
        await open("second");
        // Memory is high, and both Bots asked for their pages seconds ago: either could be waiting on
        // its model between two steps. Neither is closed, and the third launches anyway.
        await open("third");
        expect(told).toEqual([]);
        expect(profiles.liveCount()).toBe(3);

        // Ten minutes on, the first Bot takes a step. The other two have been quiet all that time.
        time.passes(10 * MINUTE);
        await open("first");
        await open("fourth");

        // Both quiet ones close, down to under 75: three browsers were 135%, one is 45%.
        expect(told).toEqual(["second", "third"]);
        expect(profiles.isLive("first")).toBe(true);
        expect(profiles.isLive("fourth")).toBe(true);
        expect(logged("computer-browser-closed-for-memory")[0]).toEqual({
          type: "computer-browser-closed-for-memory",
          botId: "second",
          workingSetBytes: 3 * 450 * MIB,
          limitBytes: LIMIT,
        });
      } finally {
        await profiles.closeAll();
      }
    },
    LAUNCH_TIMEOUT_MS,
  );

  test(
    "a burst of launches closes only what memory needs, not one browser per launch",
    async () => {
      // Three browsers are 90%; one closed is 60%, under 75.
      const container = containerOf(30);
      const time = clock();
      const { profiles, told } = await profilesFor("memory-burst", {
        memory: container.memory,
        now: time.now,
      });
      const open = async (botId: string) =>
        container.holds(await profiles.page(botId));
      try {
        await open("a");
        await open("b");
        await open("c");
        time.passes(10 * MINUTE);

        // Three Bots at once. Each launch used to read memory itself, before the first close had
        // given anything back, and each closed a browser of its own.
        await Promise.all([open("d"), open("e"), open("f")]);

        expect(told).toEqual(["a"]);
        expect(closedForMemory()).toEqual(["a"]);
        expect(profiles.liveCount()).toBe(5);
      } finally {
        await profiles.closeAll();
      }
    },
    LAUNCH_TIMEOUT_MS,
  );

  test(
    "a Bot that comes back after its browser was closed does not start a cycle of closes",
    async () => {
      // Four browsers are 100%. One closed is 75%, which is under where closing starts (85) and not
      // under where it stops (75), so the pass goes on to 50%.
      const container = containerOf(25);
      const time = clock();
      const { profiles, told } = await profilesFor("memory-cycle", {
        memory: container.memory,
        now: time.now,
      });
      const open = async (botId: string) =>
        container.holds(await profiles.page(botId));
      try {
        for (const botId of ["a", "b", "c", "d"]) await open(botId);
        time.passes(10 * MINUTE);

        await open("e");
        // Two, not one: a pass that stopped at 75% left the next launch at 100% again.
        expect(told).toEqual(["a", "b"]);

        // Each Bot whose browser was closed comes straight back, as a Bot in the middle of its work
        // would. Each comeback used to close the least recently used browser, which by then was the
        // one the last comeback had just launched, and so on round the ring for ever.
        for (let round = 0; round < 8; round += 1) {
          const closed = told.find((botId) => !profiles.isLive(botId));
          if (!closed) break;
          await open(closed);
        }

        // Every quiet browser was closed once, and none that was in use: the Bots are all back.
        expect(told).toEqual(["a", "b", "c", "d"]);
        expect(new Set(told).size).toBe(told.length);
        for (const botId of ["a", "b", "c", "d", "e"])
          expect(profiles.isLive(botId)).toBe(true);
      } finally {
        await profiles.closeAll();
      }
    },
    LAUNCH_TIMEOUT_MS,
  );

  test(
    "a Bot a person is working in stays, and memory that will not come down leaves the newest",
    async () => {
      // Memory that reads full whatever is closed: one browser too big on its own. The pass has to
      // stop, not close its way to nothing.
      const time = clock();
      const { profiles, told } = await profilesFor("memory-held", {
        memory: async () => ({ workingSet: LIMIT, limit: LIMIT }),
        now: time.now,
        heldByPerson: (botId) => botId === "held",
      });
      try {
        await profiles.page("held");
        await profiles.page("other");
        await profiles.page("third");
        time.passes(10 * MINUTE);

        await profiles.page("asking");
        // "held" is a person's to work in and "third" was the most recently used: "other" goes.
        expect(told).toEqual(["other"]);

        // The sweep's tick reads full again. "third" is quiet and goes; "held" and the newest stay.
        await profiles.sweepIdleNow();
        expect(told).toEqual(["other", "third"]);
        expect(profiles.isLive("held")).toBe(true);
        expect(profiles.isLive("asking")).toBe(true);
        expect(profiles.liveCount()).toBe(2);
      } finally {
        await profiles.closeAll();
      }
    },
    LAUNCH_TIMEOUT_MS,
  );

  test(
    "a person's own browser is never closed for memory, even the one used longest ago",
    async () => {
      // Their Recorder runs in it, so closing it would end what they were recording without a word.
      const { findRecorder } = await import("../src/recorder");
      const found = await findRecorder(
        join(import.meta.dir, "fixtures", "recorder"),
      );
      if (!found.ok) throw new Error(found.error);
      const container = containerOf(30);
      const time = clock();
      const { profiles, told } = await profilesFor("memory-person", {
        memory: container.memory,
        now: time.now,
      });
      try {
        container.holds(
          await profiles.page(PERSON, { open: { recorder: found.recorder } }),
        );
        container.holds(await profiles.page("bot-a"));
        container.holds(await profiles.page("bot-b"));
        time.passes(10 * MINUTE);

        container.holds(await profiles.page("bot-c"));

        // The person's browser is the least recently used by ten minutes and stays; the quieter of
        // the two Bots goes in its place.
        expect(told).toEqual(["bot-a"]);
        expect(profiles.isLive(PERSON)).toBe(true);
        expect(profiles.person(PERSON)).toBeDefined();
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

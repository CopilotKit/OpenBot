import { describe, expect, test } from "bun:test";
import {
  chooseEvictions,
  chooseForMemory,
  chooseIdle,
  chooseIdleTabs,
  keptOpen,
  RECENTLY_USED_MS,
} from "../src/browser-eviction";
import { numberFromEnv } from "../src/env";

/**
 * How many browsers one computer holds, and for how long.
 *
 * There was no answer to either. A context was started the first time each Bot was used and kept,
 * and the only things that dropped one were an explicit stop, a browser that had already died, and
 * shutdown. A deployment where every employee has a Bot trends toward one resident Chromium per
 * employee in a single container, at a few hundred MB each, until it is killed for memory and
 * relaunches its way back to the same state.
 *
 * Closing one loses nothing: the profile is on disk, so the Bot's logins survive and its next
 * request starts where it left off. That is already what `stop` means here.
 *
 * These test the decision rather than the closing. `createProfiles` launches a real Chromium, so a
 * test that went through it would be testing Playwright; the part with a wrong answer available is
 * which browser gets picked.
 */

/** Bots, oldest use first, as a map the way the module holds them. */
function running(...usedAt: number[]): Map<string, { usedAt: number }> {
  return new Map(usedAt.map((at, index) => [`bot-${index}`, { usedAt: at }]));
}

describe("keeping the number of running browsers under a cap", () => {
  test("closes nothing while there is room", () => {
    expect(chooseEvictions(running(1, 2, 3), 8)).toEqual([]);
  });

  test("closes nothing at exactly the cap", () => {
    // The boundary. Off by one here closes a browser somebody is using every time the last slot
    // fills, which reads as a computer that keeps restarting itself.
    expect(chooseEvictions(running(1, 2, 3), 3)).toEqual([]);
  });

  test("closes the least recently used", () => {
    // Not the oldest browser: the one whose Bot has been quiet longest. A Bot started this morning
    // and used a second ago is the wrong one to close.
    expect(chooseEvictions(running(500, 100, 300), 2)).toEqual(["bot-1"]);
  });

  test("closes as many as it takes to get under the cap", () => {
    expect(chooseEvictions(running(500, 100, 300, 200), 2).sort()).toEqual([
      "bot-1",
      "bot-3",
    ]);
  });

  test("the one that just asked is never the one closed", () => {
    /*
     * The property that makes this safe. The cap is applied after a launch, so the newest entry is
     * the most recently used; if it could be chosen, a deployment at the cap would close the browser
     * it had just started and the Bot would never get one.
     */
    const now = Date.now();
    const withNewest = running(now - 10_000, now - 5_000, now);

    expect(chooseEvictions(withNewest, 2)).not.toContain("bot-2");
  });

  test("a cap of one still leaves the newest running", () => {
    const now = Date.now();
    const chosen = chooseEvictions(running(now - 1000, now), 1);

    expect(chosen).toEqual(["bot-0"]);
  });
});

describe("closing browsers nothing has touched", () => {
  const NOW = 1_000_000;

  test("closes what is past the timeout", () => {
    const stale = NOW - 60_000;
    const fresh = NOW - 1_000;

    expect(chooseIdle(running(stale, fresh), 30_000, NOW)).toEqual(["bot-0"]);
  });

  test("keeps one used exactly at the boundary out of it", () => {
    // Exactly at the cutoff counts as idle, and a moment inside it does not. Stated so the boundary
    // is a decision rather than whatever the comparison happened to be.
    expect(chooseIdle(running(NOW - 30_000), 30_000, NOW)).toEqual(["bot-0"]);
    expect(chooseIdle(running(NOW - 29_999), 30_000, NOW)).toEqual([]);
  });

  test("a timeout of zero switches it off", () => {
    // A deployment that would rather keep browsers resident says so this way, and gets the cap and
    // nothing else.
    expect(chooseIdle(running(0), 0, NOW)).toEqual([]);
    expect(chooseIdle(running(0), -1, NOW)).toEqual([]);
  });

  test("closes several at once", () => {
    const stale = NOW - 60_000;

    expect(chooseIdle(running(stale, stale, NOW), 30_000, NOW).sort()).toEqual([
      "bot-0",
      "bot-1",
    ]);
  });

  test("nothing running closes nothing", () => {
    expect(chooseIdle(running(), 30_000, NOW)).toEqual([]);
    expect(chooseEvictions(running(), 8)).toEqual([]);
  });
});

/**
 * An unset variable in a compose file arrives as an empty string, not as absent.
 *
 * `Number("")` is zero, so read with `??` alone the cap became zero for any operator who had not
 * set it, and every browser would be closed the moment it opened. Found by declaring the setting in
 * `docker-compose.yml` and watching the container come up with `COMPUTER_MAX_BROWSERS=`.
 */
describe("reading the limits an operator set", () => {
  test("a cap of zero closes everything, which is why empty must not read as zero", () => {
    // The failure being guarded against, stated as the behaviour it would cause.
    const now = Date.now();
    expect(chooseEvictions(running(now, now - 1000), 0)).toHaveLength(2);
  });

  test("the default keeps several browsers, which is what an unset variable must produce", () => {
    const now = Date.now();
    expect(chooseEvictions(running(now, now - 1000, now - 2000), 8)).toEqual(
      [],
    );
  });

  test("a deployment that switched the sweep off keeps the browser it asked to keep", () => {
    /*
     * The two halves, read together, because separately both were right and the pair was not.
     * `COMPUTER_BROWSER_IDLE_MS=0` is the documented way to keep browsers resident and the timeout
     * of zero above switches this off — but the value never arrived as zero. It was read the way the
     * cap is, where zero is a mistake, so it took the thirty-minute default and this Bot's browser
     * was closed under an operator who had said not to.
     */
    const previous = process.env.COMPUTER_BROWSER_IDLE_MS;
    process.env.COMPUTER_BROWSER_IDLE_MS = "0";
    try {
      const idleTimeoutMs = numberFromEnv(
        "COMPUTER_BROWSER_IDLE_MS",
        30 * 60_000,
        { zeroSwitchesItOff: true },
      );
      const now = Date.now();
      expect(
        chooseIdle(running(now - 45 * 60_000), idleTimeoutMs, now),
      ).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.COMPUTER_BROWSER_IDLE_MS;
      else process.env.COMPUTER_BROWSER_IDLE_MS = previous;
    }
  });
});

/**
 * A person's browser in a native window, which counts toward the cap and is closed last.
 *
 * Browsing in a native window sends the computer nothing, so a person's browser always looks like
 * the one used longest ago. Ordered by use alone it was the first the cap closed, out from under
 * the person, whenever a Bot started, and the idle sweep closed it half an hour into their reading.
 */
describe("a person's browser among Bots' browsers", () => {
  const PERSON = "person-0123456789abcdef0123456789abcdef";
  const isPerson = (botId: string) => botId.startsWith("person-");
  const withPerson = (personUsedAt: number, ...botsUsedAt: number[]) =>
    new Map([[PERSON, { usedAt: personUsedAt }], ...running(...botsUsedAt)]);

  test("the cap closes every Bot's browser before the person's", () => {
    // The person's is the least recently used by a long way, and still not the one closed.
    expect(chooseEvictions(withPerson(1, 500, 300, 900), 3, isPerson)).toEqual([
      "bot-1",
    ]);
    expect(
      chooseEvictions(withPerson(1, 500, 300, 900), 2, isPerson).sort(),
    ).toEqual(["bot-0", "bot-1"]);
  });

  test("it still counts, so it goes when nothing else is left to close", () => {
    // A cap of one with the person's browser open and a Bot just started: the Bot that just asked
    // stays, as it always has, and the person's browser is what the cap takes.
    expect(chooseEvictions(withPerson(1, 900), 1, isPerson)).toEqual([PERSON]);
  });

  test("a person's browser that just opened is never the one closed", () => {
    const opened = new Map([
      ["bot-0", { usedAt: 100 }],
      ["bot-1", { usedAt: 200 }],
      [PERSON, { usedAt: 300 }],
    ]);
    expect(chooseEvictions(opened, 1, isPerson).sort()).toEqual([
      "bot-0",
      "bot-1",
    ]);
  });

  test("the idle sweep never closes it", () => {
    const NOW = 1_000_000;
    expect(
      chooseIdle(withPerson(NOW - 60_000, NOW - 60_000), 30_000, NOW, isPerson),
    ).toEqual(["bot-0"]);
  });
});

/**
 * Which person's browser that is: a native window on the person's own desktop, never a cloud one.
 *
 * Every person's browser used to be exempt, the cloud one included: an abandoned Browser tab kept a
 * root, sandbox-less Chromium running for ever, and when the cap was reached it closed the Bots'
 * browsers first. A cloud browser is touched every second while anybody is on its
 * page, so it takes the Bots' own rule.
 */
describe("a person's cloud browser among Bots' browsers", () => {
  const PERSON = "person-0123456789abcdef0123456789abcdef";
  const NOW = 1_000_000;

  test("closes when nobody has touched it, as a Bot's does", () => {
    const idle = new Map([
      [PERSON, { usedAt: NOW - 60_000 }],
      ["bot-0", { usedAt: NOW - 60_000 }],
      ["bot-1", { usedAt: NOW - 1_000 }],
    ]);
    expect(chooseIdle(idle, 30_000, NOW, keptOpen("screen")).sort()).toEqual([
      "bot-0",
      PERSON,
    ]);
    // A native window on the person's desktop stays: browsing in it touches nothing here.
    expect(chooseIdle(idle, 30_000, NOW, keptOpen("native"))).toEqual([
      "bot-0",
    ]);
  });

  test("is ranked by use at the cap, not ahead of the Bots", () => {
    const full = new Map([
      [PERSON, { usedAt: 100 }],
      ["bot-0", { usedAt: 200 }],
      ["bot-1", { usedAt: 300 }],
    ]);
    expect(chooseEvictions(full, 2, keptOpen("screen"))).toEqual([PERSON]);
    expect(chooseEvictions(full, 2, keptOpen("native"))).toEqual(["bot-0"]);
  });

  test("a person's cloud browser in use is the Bots' equal, and stays", () => {
    const used = new Map([
      [PERSON, { usedAt: NOW - 1_000 }],
      ["bot-0", { usedAt: NOW - 60_000 }],
    ]);
    expect(chooseIdle(used, 30_000, NOW, keptOpen("screen"))).toEqual([
      "bot-0",
    ]);
  });
});

/**
 * Which browser to close next when the computer's memory runs high.
 *
 * The cap counts browsers and the idle sweep counts minutes, and neither looks at memory, so a few
 * heavy pages took a container past its limit and the OOM killer took every browser on it at once.
 * The computer now closes browsers one at a time while memory runs high, reading it again after each,
 * and never one that is in use: a Bot between two steps asks for nothing while its model thinks, and
 * closing its browser then closes it in the middle of a run.
 */
describe("closing a browser because memory runs high", () => {
  const NOW = 10_000_000;
  const MINUTE = 60_000;
  const PERSON = "person-0123456789abcdef0123456789abcdef";
  /** Bots used this long before NOW, in order. */
  const usedAgo = (...ago: number[]) => running(...ago.map((ms) => NOW - ms));

  test("closes the least recently used of the browsers nobody has used for a minute", () => {
    expect(
      chooseForMemory(usedAgo(5 * MINUTE, 9 * MINUTE, 2 * MINUTE, 1_000), NOW),
    ).toBe("bot-1");
  });

  test("never a Bot used seconds ago, which is a Bot whose model is working out its next step", () => {
    // bot-0 asked for its page ten seconds ago and has asked for nothing since. It is the least
    // recently used here and it is still in the middle of its run.
    expect(chooseForMemory(usedAgo(10_000, 5_000), NOW)).toBeUndefined();
    expect(chooseForMemory(usedAgo(10_000, 3 * MINUTE, 5_000), NOW)).toBe(
      "bot-1",
    );
  });

  test("a minute is the line: used exactly a minute ago may close, a moment inside it may not", () => {
    expect(chooseForMemory(usedAgo(MINUTE, 0), NOW)).toBe("bot-0");
    expect(chooseForMemory(usedAgo(MINUTE - 1, 0), NOW)).toBeUndefined();
    expect(RECENTLY_USED_MS).toBe(MINUTE);
  });

  test("never the most recently used browser running, however long ago that was", () => {
    // Before a launch the caller passes the browsers already running, and the one launching is not
    // among them. Of those, the newest stays even when every one is an hour quiet, so one is left.
    expect(chooseForMemory(usedAgo(60 * MINUTE), NOW)).toBeUndefined();
    expect(chooseForMemory(usedAgo(90 * MINUTE, 60 * MINUTE), NOW)).toBe(
      "bot-0",
    );
    expect(chooseForMemory(running(), NOW)).toBeUndefined();
  });

  test("a browser that has just launched is never what the next launch closes", () => {
    // The loop this rules out: each Bot's launch closing the browser the Bot before it just started.
    // Here the one just launched is not the newest (another Bot asked a second ago), so only the
    // minute keeps it.
    const justLaunched = new Map([
      ["just-launched", { usedAt: NOW - 2_000 }],
      ["asked-a-second-ago", { usedAt: NOW - 1_000 }],
      ["quiet", { usedAt: NOW - 20 * MINUTE }],
    ]);
    expect(chooseForMemory(justLaunched, NOW)).toBe("quiet");
    justLaunched.delete("quiet");
    expect(chooseForMemory(justLaunched, NOW)).toBeUndefined();
  });

  test("never a person's own browser, cloud or native, even the one used longest ago", () => {
    // Their Recorder runs in it, and closing it ends what they were recording without a word.
    const withPerson = new Map([
      [PERSON, { usedAt: NOW - 120 * MINUTE }],
      ...usedAgo(30 * MINUTE, 10 * MINUTE),
    ]);
    expect(chooseForMemory(withPerson, NOW)).toBe("bot-0");
    withPerson.delete("bot-0");
    expect(chooseForMemory(withPerson, NOW)).toBeUndefined();
  });

  test("never a browser whose wheel a person holds", () => {
    const held = (botId: string) => botId === "bot-0";
    expect(
      chooseForMemory(usedAgo(30 * MINUTE, 20 * MINUTE, 10 * MINUTE), NOW, {
        spared: held,
      }),
    ).toBe("bot-1");
    expect(
      chooseForMemory(usedAgo(30 * MINUTE, 10 * MINUTE), NOW, { spared: held }),
    ).toBeUndefined();
  });

  test("the window can be narrowed, which is how the browser tests run without waiting a minute", () => {
    expect(chooseForMemory(usedAgo(500, 0), NOW, { recentlyUsedMs: 100 })).toBe(
      "bot-0",
    );
  });
});

/**
 * Which of a Bot's background tabs to close because nobody has touched them.
 *
 * A Bot is always on its newest page, so a tab it left behind, the page a sign-in popup opened from
 * or a link a site opened in a new tab, is one it cannot go back to, and it held a renderer for as
 * long as the browser stayed up.
 */
describe("closing a Bot's idle background tabs", () => {
  const NOW = 1_000_000;
  const IDLE = 10 * 60_000;
  const tab = (name: string, usedAt: number, front = false, kept = false) => ({
    name,
    usedAt,
    front,
    kept,
  });
  const names = (tabs: { name: string }[]) => tabs.map((t) => t.name);

  test("closes a background tab past the timeout, and keeps the page in front", () => {
    const tabs = [
      tab("left behind", NOW - IDLE - 1),
      tab("in front", NOW - IDLE - 1, true),
    ];
    // The page in front is as old as the other and is still never closed: it is the one the Bot is on.
    expect(names(chooseIdleTabs(tabs, IDLE, NOW))).toEqual(["left behind"]);
  });

  test("keeps a background tab used inside the timeout, and closes one at it", () => {
    expect(
      names(
        chooseIdleTabs(
          [
            tab("recent", NOW - IDLE + 1),
            tab("at the line", NOW - IDLE),
            tab("in front", NOW, true),
          ],
          IDLE,
          NOW,
        ),
      ),
    ).toEqual(["at the line"]);
  });

  test("never the last tab", () => {
    expect(chooseIdleTabs([tab("only", 0, true)], IDLE, NOW)).toEqual([]);
  });

  test("closes nothing when which page is in front is not known", () => {
    // Any tab could then be the one the Bot is on, and closing it would move the Bot.
    expect(chooseIdleTabs([tab("a", 0), tab("b", 0)], IDLE, NOW)).toEqual([]);
    expect(
      chooseIdleTabs([tab("a", 0, true), tab("b", 0, true)], IDLE, NOW),
    ).toEqual([]);
  });

  test("never an extension's own page or DevTools", () => {
    expect(
      names(
        chooseIdleTabs(
          [
            tab("recorder", 0, false, true),
            tab("old", 0),
            tab("front", NOW, true),
          ],
          IDLE,
          NOW,
        ),
      ),
    ).toEqual(["old"]);
  });

  test("a timeout of zero switches it off", () => {
    expect(
      chooseIdleTabs([tab("old", 0), tab("front", NOW, true)], 0, NOW),
    ).toEqual([]);
  });
});

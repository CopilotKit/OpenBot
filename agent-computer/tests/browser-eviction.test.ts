import { describe, expect, test } from "bun:test";
import { chooseEvictions, chooseIdle } from "../src/browser-eviction";

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
});

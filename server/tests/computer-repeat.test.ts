import { describe, expect, test } from "bun:test";
import {
  createRepeatDetector,
  DEFAULT_REPEAT_WINDOW_MS,
  fingerprintOf,
} from "../src/computer/repeat";

/**
 * What the detector must get right, and every one of them is a way of being wrong that looks fine.
 *
 * A detector that overcounts is worse than none: the first person to see a boundary refuse a Bot
 * working steadily down a form turns the boundary off, and takes the real refusals with it. A
 * detector that fires its thresholds again on every call past them buries the actions a Bot took
 * under the observation that it kept taking them. And a detector two Bots share reports one Bot's
 * loop against another Bot's name, which is the one thing an audit trail may never do.
 *
 * Time is injected. A test that waits three minutes to prove a window expires is a test somebody
 * eventually deletes.
 */

/** A clock a test drives by hand, so a window can expire in a microsecond. */
function clock(start = 1_000_000) {
  let time = start;
  return {
    now: () => time,
    advance(ms: number) {
      time += ms;
    },
  };
}

describe("counting a Bot repeating itself", () => {
  test("identical calls count up", () => {
    const detector = createRepeatDetector({ now: clock().now });
    const call = { tool: "computer_click", ref: "e9" };

    expect(detector.observe("sales-bot", call).count).toBe(1);
    expect(detector.observe("sales-bot", call).count).toBe(2);
    expect(detector.observe("sales-bot", call).count).toBe(3);
  });

  test("the count includes the call being observed", () => {
    // The gateway counts before it asks the policy, so a rule saying `repeat.count >= 10` has to
    // refuse the tenth attempt. Starting at zero would make it refuse the eleventh, and nobody would
    // notice until they were counting rows in an incident.
    const detector = createRepeatDetector({ now: clock().now });
    expect(
      detector.observe("sales-bot", { tool: "computer_click", ref: "e1" }),
    ).toMatchObject({ count: 1 });
  });

  test("a different argument is a different call", () => {
    const detector = createRepeatDetector({ now: clock().now });

    detector.observe("sales-bot", { tool: "computer_click", ref: "e1" });
    detector.observe("sales-bot", { tool: "computer_click", ref: "e2" });
    const third = detector.observe("sales-bot", {
      tool: "computer_click",
      ref: "e3",
    });

    // Three clicks, three buttons. A Bot working down a form must not look like one stuck on its
    // first field, or the feature gets switched off the first day somebody uses it.
    expect(third.count).toBe(1);
  });

  test("a different tool on the same argument is a different call", () => {
    const detector = createRepeatDetector({ now: clock().now });

    detector.observe("sales-bot", {
      tool: "computer_read_file",
      filePath: "a",
    });
    const written = detector.observe("sales-bot", {
      tool: "computer_write_file",
      filePath: "a",
    });

    expect(written.count).toBe(1);
  });

  test("whitespace around an argument does not buy a Bot a fresh count", () => {
    // A model reproducing a path from its own earlier output does not always reproduce the spacing,
    // and it is doing the same thing either way.
    const detector = createRepeatDetector({ now: clock().now });

    detector.observe("bot", { tool: "computer_write_file", filePath: "q3.md" });
    const spaced = detector.observe("bot", {
      tool: "computer_write_file",
      filePath: "  q3.md ",
    });

    expect(spaced.count).toBe(2);
  });

  test("a call with nothing to distinguish it is not counted", () => {
    // Scrolling is the only governed call that names nothing. Counting it by tool name alone would
    // mean a Bot reading a long page trips a rule about repetition just by reaching the bottom.
    const detector = createRepeatDetector({ now: clock().now });

    for (let attempt = 0; attempt < 30; attempt++) {
      const seen = detector.observe("bot", { tool: "computer_scroll" });
      expect(seen.count).toBe(1);
      expect(seen.fingerprint).toBeNull();
      expect(seen.threshold).toBeNull();
    }
  });

  test("the window expires, and the count starts again", () => {
    const time = clock();
    const detector = createRepeatDetector({
      now: time.now,
      windowMs: 60_000,
    });
    const call = {
      tool: "computer_navigate",
      targetUrl: "https://example.com",
    };

    detector.observe("bot", call);
    time.advance(30_000);
    expect(detector.observe("bot", call).count).toBe(2);

    // Far enough that the first two fall out of the window entirely.
    time.advance(61_000);
    expect(detector.observe("bot", call).count).toBe(1);
  });

  test("the window slides rather than resetting on a fixed tick", () => {
    // A Bot pacing itself just inside the window still accumulates, which is the point: the window
    // is about how close together attempts are, not about which minute they landed in.
    const time = clock();
    const detector = createRepeatDetector({ now: time.now, windowMs: 60_000 });
    const call = { tool: "computer_click", ref: "e9" };

    detector.observe("bot", call);
    time.advance(50_000);
    detector.observe("bot", call);
    time.advance(50_000);

    // The first has aged out, the second has not.
    expect(detector.observe("bot", call).count).toBe(2);
  });

  test("each threshold fires exactly once", () => {
    const detector = createRepeatDetector({
      now: clock().now,
      thresholds: [3, 10],
    });
    const call = { tool: "computer_click", ref: "e9" };

    const fired: number[] = [];
    for (let attempt = 0; attempt < 15; attempt++) {
      const seen = detector.observe("bot", call);
      if (seen.threshold !== null) fired.push(seen.threshold);
    }

    // A row per attempt past the line would bury the attempts themselves under the observation that
    // they kept happening.
    expect(fired).toEqual([3, 10]);
  });

  test("a threshold fires on the attempt that reaches it", () => {
    const detector = createRepeatDetector({
      now: clock().now,
      thresholds: [3],
    });
    const call = { tool: "computer_click", ref: "e9" };

    expect(detector.observe("bot", call).threshold).toBeNull();
    expect(detector.observe("bot", call).threshold).toBeNull();
    expect(detector.observe("bot", call)).toMatchObject({
      count: 3,
      threshold: 3,
    });
  });

  test("a Bot that gets stuck twice is reported twice", () => {
    // Once the window has emptied the run of repetition is over, so the next one is a new incident
    // and deserves its own row. Holding the thresholds for the life of the process would leave one
    // row for an afternoon of separate failures.
    const time = clock();
    const detector = createRepeatDetector({
      now: time.now,
      windowMs: 60_000,
      thresholds: [3],
    });
    const call = { tool: "computer_click", ref: "e9" };

    detector.observe("bot", call);
    detector.observe("bot", call);
    expect(detector.observe("bot", call).threshold).toBe(3);

    time.advance(120_000);
    detector.observe("bot", call);
    detector.observe("bot", call);
    expect(detector.observe("bot", call).threshold).toBe(3);
  });

  test("a run that dips without emptying is still the same run", () => {
    // The run ends when the window is empty, not when the count falls back under a threshold. A row
    // every time a stuck Bot's count wobbles past the line would be a row per attempt under another
    // name, which is the thing the thresholds exist to avoid.
    const time = clock();
    const detector = createRepeatDetector({
      now: time.now,
      windowMs: 60_000,
      thresholds: [2],
    });
    const call = { tool: "computer_click", ref: "e9" };

    detector.observe("bot", call);
    time.advance(10_000);
    expect(detector.observe("bot", call).threshold).toBe(2);

    // The first attempt ages out and the second does not, so the count falls to one and climbs
    // straight back. The key never went quiet, so this is the same incident, already reported.
    time.advance(55_000);
    expect(detector.observe("bot", call)).toMatchObject({
      count: 2,
      threshold: null,
    });
  });

  test("two Bots do not share a count", () => {
    // The audit row names a Bot. A count pooled across Bots would report one Bot's loop against
    // another Bot's name, which is the one thing a trail may never do.
    const detector = createRepeatDetector({ now: clock().now });
    const call = { tool: "computer_click", ref: "e9" };

    detector.observe("sales-bot", call);
    detector.observe("sales-bot", call);
    detector.observe("sales-bot", call);

    expect(detector.observe("research-bot", call).count).toBe(1);
    expect(detector.observe("sales-bot", call).count).toBe(4);
  });

  test("the number of calls held per Bot is capped", () => {
    // A Bot doing genuinely varied work never repeats anything, so every call it makes is a new key.
    // Without a cap the map grows for exactly the Bots this has nothing to say about.
    const detector = createRepeatDetector({
      now: clock().now,
      maxKeysPerBot: 3,
    });

    detector.observe("bot", { tool: "computer_click", ref: "e1" });
    detector.observe("bot", { tool: "computer_click", ref: "e2" });
    detector.observe("bot", { tool: "computer_click", ref: "e3" });

    // Full, so the fourth call is not counted. Nothing still inside the window is thrown out to make
    // room for it, and a call nobody could count reports one, which no rule acts on.
    expect(
      detector.observe("bot", { tool: "computer_click", ref: "e4" }).count,
    ).toBe(1);
    expect(
      detector.observe("bot", { tool: "computer_click", ref: "e4" }).count,
    ).toBe(1);
    // The half of the cap that matters: a live loop survives a Bot doing other things in between,
    // however much of it there is.
    expect(
      detector.observe("bot", { tool: "computer_click", ref: "e1" }).count,
    ).toBe(2);
  });

  test("a Bot going round a loop wider than the cap is still counted", () => {
    // The failure that would make the whole feature ornamental. Dropping the least recently seen key
    // to make room drops each key exactly one step before it comes round again, so a Bot circling
    // all afternoon would report every call as its first and no rule about repetition would ever
    // fire on the one thing this exists to catch.
    const detector = createRepeatDetector({
      now: clock().now,
      maxKeysPerBot: 3,
      thresholds: [3],
    });

    const counts: number[] = [];
    const fired: number[] = [];
    for (let round = 0; round < 3; round++) {
      for (const ref of ["e1", "e2", "e3", "e4"]) {
        const seen = detector.observe("bot", { tool: "computer_click", ref });
        counts.push(seen.count);
        if (seen.threshold !== null) fired.push(seen.threshold);
      }
    }

    // Three of the four keys fitted, and three times round is what the trail is told about.
    expect(Math.max(...counts)).toBe(3);
    expect(fired).toEqual([3, 3, 3]);
  });

  test("a call the cap turned away is counted once the window drains", () => {
    // The cost of not evicting is a blind spot, and this is the thing that makes it bearable: it
    // ends by itself within a window rather than lasting as long as the Bot does.
    const time = clock();
    const detector = createRepeatDetector({
      now: time.now,
      windowMs: 60_000,
      maxKeysPerBot: 2,
    });

    detector.observe("bot", { tool: "computer_click", ref: "e1" });
    detector.observe("bot", { tool: "computer_click", ref: "e2" });
    expect(
      detector.observe("bot", { tool: "computer_click", ref: "e3" }).count,
    ).toBe(1);

    time.advance(61_000);
    detector.observe("bot", { tool: "computer_click", ref: "e3" });
    expect(
      detector.observe("bot", { tool: "computer_click", ref: "e3" }).count,
    ).toBe(2);
  });

  test("the number of Bots held is capped", () => {
    // The id counted against is the one in the request path, checked against a session and against
    // nothing else. A caller naming a fresh Bot on every request would otherwise buy a map of its
    // own each time, for the life of the process.
    const detector = createRepeatDetector({ now: clock().now, maxBots: 2 });
    const call = { tool: "computer_click", ref: "e9" };

    detector.observe("sales-bot", call);
    detector.observe("research-bot", call);
    for (let invented = 0; invented < 100; invented++) {
      detector.observe(`bot-${invented}`, call);
    }

    // The two that were really working keep their counts, and the hundred invented ones bought
    // nothing at all.
    expect(detector.observe("sales-bot", call).count).toBe(2);
    expect(detector.observe("research-bot", call).count).toBe(2);
  });

  test("a Bot that has gone quiet gives its place up", () => {
    const time = clock();
    const detector = createRepeatDetector({
      now: time.now,
      windowMs: 60_000,
      maxBots: 1,
    });
    const call = { tool: "computer_click", ref: "e9" };

    detector.observe("morning-bot", call);
    // Still working, so it keeps its place and the second Bot is not counted.
    expect(detector.observe("afternoon-bot", call).count).toBe(1);

    time.advance(61_000);
    detector.observe("afternoon-bot", call);
    expect(detector.observe("afternoon-bot", call).count).toBe(2);
  });

  test("one Bot's varied work does not evict another Bot's loop", () => {
    const detector = createRepeatDetector({
      now: clock().now,
      maxKeysPerBot: 2,
    });
    const call = { tool: "computer_click", ref: "e9" };

    detector.observe("stuck-bot", call);
    for (let ref = 0; ref < 20; ref++) {
      detector.observe("busy-bot", { tool: "computer_click", ref: `e${ref}` });
    }

    expect(detector.observe("stuck-bot", call).count).toBe(2);
  });

  test("the default window is a few minutes, not a few seconds", () => {
    // A retry loop is a model round trip each time round. A window of seconds would count nothing at
    // all, and the feature would look like it worked because it never fired.
    expect(DEFAULT_REPEAT_WINDOW_MS).toBeGreaterThanOrEqual(60_000);
    expect(DEFAULT_REPEAT_WINDOW_MS).toBeLessThanOrEqual(10 * 60_000);
  });
});

describe("the fingerprint an audit row carries", () => {
  test("names the tool and the argument, in words", () => {
    // It goes onto the row as written. An investigator reading "the same call, 25 times" has to be
    // told which call without going and decoding anything.
    expect(fingerprintOf({ tool: "computer_click", ref: "e9" })).toBe(
      "computer_click ref=e9",
    );
    expect(
      fingerprintOf({ tool: "computer_write_file", filePath: "notes.md" }),
    ).toBe("computer_write_file file=notes.md");
    expect(
      fingerprintOf({ tool: "computer_key", ref: "e1", key: "Enter" }),
    ).toBe("computer_key ref=e1 key=Enter");
  });

  test("is null when the call named nothing", () => {
    expect(fingerprintOf({ tool: "computer_scroll" })).toBeNull();
  });
});

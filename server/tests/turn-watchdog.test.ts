import { describe, expect, test } from "bun:test";
import {
  type StalledStream,
  TurnWatchdog,
} from "../src/channels/turn-watchdog";

/**
 * These test the distinction the watchdog exists to draw, not the plumbing around it.
 *
 * Every case is one a deployment can actually be in: a Bot that answers slowly and is fine, a Bot
 * that answered once and then stopped, a Bot that accepted the connection and never wrote a byte.
 * Time is injected rather than waited for, so a two-minute timeout is tested in no time at all and
 * the assertions are about the rule rather than about how fast the machine running them is.
 *
 * There is no exemption for a frontend tool call and therefore no test of one. The run ends before
 * the browser executes a tool and a second run carries the result back, so no stream is ever held
 * open across one; see the module comment on turn-watchdog.ts for what was measured.
 */

/** A clock a test moves by hand. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let current = 0;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function watching(stallMs: number) {
  const time = clock();
  const stalled: StalledStream[] = [];
  const watchdog = new TurnWatchdog({
    stallMs,
    now: time.now,
    onStall: (stream) => stalled.push(stream),
  });
  return { time, stalled, watchdog };
}

describe("a turn is judged on activity, not on how long it has run", () => {
  test("a stream that has said nothing for the timeout is given up on", () => {
    const { time, stalled, watchdog } = watching(60_000);
    watchdog.open({ id: "stream-1", botId: "risk-analyst" });

    time.advance(59_999);
    expect(watchdog.sweep()).toBe(0);

    time.advance(1);
    expect(watchdog.sweep()).toBe(1);
    expect(stalled).toHaveLength(1);
    expect(stalled[0]?.botId).toBe("risk-analyst");
    expect(stalled[0]?.silentForMs).toBe(60_000);
    // Zero chunks is the fact worth reading: the Bot answered the request and then said nothing.
    expect(stalled[0]?.chunks).toBe(0);
  });

  test("a stream that keeps talking is never given up on, however long it runs", () => {
    const { time, stalled, watchdog } = watching(60_000);
    watchdog.open({ id: "stream-1", botId: "risk-analyst" });

    // An hour of work, a chunk every half minute. A duration limit would have ended this repeatedly.
    for (let minute = 0; minute < 120; minute++) {
      time.advance(30_000);
      watchdog.record("stream-1");
      expect(watchdog.sweep()).toBe(0);
    }

    expect(stalled).toHaveLength(0);
    expect(watchdog.watching).toBe(1);
  });

  test("a stream that spoke and then stopped is given up on from its last chunk", () => {
    const { time, stalled, watchdog } = watching(60_000);
    watchdog.open({ id: "stream-1", botId: "risk-analyst" });

    time.advance(50_000);
    watchdog.record("stream-1");
    watchdog.record("stream-1");
    time.advance(50_000);
    // A hundred seconds since it opened, fifty since it last said anything. Silence is what counts.
    expect(watchdog.sweep()).toBe(0);

    time.advance(10_000);
    expect(watchdog.sweep()).toBe(1);
    expect(stalled[0]?.silentForMs).toBe(60_000);
    expect(stalled[0]?.chunks).toBe(2);
  });

  test("a stream that ends is forgotten and is never reported", () => {
    const { time, stalled, watchdog } = watching(60_000);
    watchdog.open({ id: "stream-1", botId: "risk-analyst" });
    watchdog.close("stream-1");

    time.advance(600_000);
    expect(watchdog.sweep()).toBe(0);
    expect(stalled).toHaveLength(0);
    expect(watchdog.watching).toBe(0);
  });

  test("closing a stream that was never watched is harmless", () => {
    const { watchdog } = watching(60_000);
    expect(() => watchdog.close("never-opened")).not.toThrow();
    expect(watchdog.watching).toBe(0);
  });
});

describe("a stalled stream is reported exactly once", () => {
  test("sweeping again finds nothing, because the entry went with the callback", () => {
    const { time, stalled, watchdog } = watching(1_000);
    watchdog.open({ id: "stream-1", botId: "risk-analyst" });

    time.advance(5_000);
    expect(watchdog.sweep()).toBe(1);
    expect(watchdog.sweep()).toBe(0);
    expect(watchdog.sweep()).toBe(0);
    expect(stalled).toHaveLength(1);
  });

  test("a late chunk from a Bot already given up on does not start a second watch", () => {
    const { time, stalled, watchdog } = watching(1_000);
    watchdog.open({ id: "stream-1", botId: "risk-analyst" });

    time.advance(2_000);
    expect(watchdog.sweep()).toBe(1);

    // The endpoint wakes up and writes. There is no turn left to end, and reviving it here would
    // stall again and report the same wedged turn twice.
    watchdog.record("stream-1");
    time.advance(60_000);
    expect(watchdog.sweep()).toBe(0);
    expect(stalled).toHaveLength(1);
  });

  test("one wedged Bot's callback throwing does not spare the others", () => {
    const time = clock();
    const reported: string[] = [];
    const watchdog = new TurnWatchdog({
      stallMs: 1_000,
      now: time.now,
      onStall: (stream) => {
        reported.push(stream.id);
        if (stream.id === "stream-1") throw new Error("the surface blew up");
      },
    });

    watchdog.open({ id: "stream-1", botId: "risk-analyst" });
    watchdog.open({ id: "stream-2", botId: "general-assistant" });
    time.advance(2_000);

    expect(watchdog.sweep()).toBe(2);
    expect(reported).toEqual(["stream-1", "stream-2"]);
    expect(watchdog.watching).toBe(0);
  });
});

describe("a deployment that has not asked for a watchdog does not get one", () => {
  test("zero watches nothing, whatever is opened", () => {
    const { time, stalled, watchdog } = watching(0);
    watchdog.open({ id: "stream-1", botId: "risk-analyst" });

    expect(watchdog.enabled).toBe(false);
    expect(watchdog.watching).toBe(0);

    time.advance(3_600_000);
    expect(watchdog.sweep()).toBe(0);
    expect(stalled).toHaveLength(0);
  });

  test("a positive timeout is what switches it on", () => {
    const { watchdog } = watching(1);
    expect(watchdog.enabled).toBe(true);
  });
});

describe("opening a stream twice", () => {
  test("restarts its clock rather than raising", () => {
    const { time, stalled, watchdog } = watching(1_000);
    watchdog.open({ id: "stream-1", botId: "risk-analyst" });

    time.advance(900);
    watchdog.open({ id: "stream-1", botId: "risk-analyst" });
    time.advance(900);

    expect(watchdog.sweep()).toBe(0);
    expect(watchdog.watching).toBe(1);
    expect(stalled).toHaveLength(0);
  });
});

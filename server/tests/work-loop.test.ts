import { describe, expect, test } from "bun:test";
import { repeatAfterEach } from "../src/work/loop";

/**
 * Running something over and over without ever running two at once.
 *
 * The sweep this exists for claims work with `for update skip locked`, so two overlapping runs do
 * not contend over one row — they take different rows, and each starts its own agent deliveries. An
 * interval firing on the clock during a five-minute delivery starts a hundred and fifty more of
 * them. The bound is the backlog, not the limit anybody configured.
 */

/** A timer a test can advance by hand, so this is about ordering rather than about waiting. */
function fakeClock() {
  const pending: Array<{ at: number; run: () => void }> = [];
  let now = 0;
  return {
    schedule: (run: () => void, ms: number) => {
      pending.push({ at: now + ms, run });
      return {};
    },
    /** Fire everything due at or before `to`, in order, one at a time. */
    async advance(to: number) {
      now = to;
      for (;;) {
        const index = pending.findIndex((entry) => entry.at <= now);
        if (index === -1) return;
        const [entry] = pending.splice(index, 1);
        entry?.run();
        // Let whatever the callback started make progress before the next timer fires.
        await Promise.resolve();
        await Promise.resolve();
      }
    },
    get waiting() {
      return pending.length;
    },
  };
}

describe("repeating something one at a time", () => {
  test("never starts a run while the last one is still going", async () => {
    const clock = fakeClock();
    let inFlight = 0;
    let most = 0;
    let started = 0;
    const release: Array<() => void> = [];

    repeatAfterEach(
      () => {
        started += 1;
        inFlight += 1;
        most = Math.max(most, inFlight);
        return new Promise<void>((resolve) => {
          release.push(() => {
            inFlight -= 1;
            resolve();
          });
        });
      },
      100,
      clock.schedule,
    );

    // A run starts, and then a great deal of time passes while it is still going.
    await clock.advance(100);
    expect(started).toBe(1);
    await clock.advance(10_000);
    expect(started).toBe(1);
    expect(most).toBe(1);
    // Nothing is even scheduled while one is in flight, so nothing can pile up.
    expect(clock.waiting).toBe(0);

    // It finishes; the next one is scheduled from there.
    release[0]?.();
    await Promise.resolve();
    await clock.advance(10_100);
    expect(started).toBe(2);
    expect(most).toBe(1);
  });

  /*
   * Otherwise the loop stops the first time the database blinks, silently, and stays stopped until
   * somebody restarts the pod.
   */
  test("a run that threw does not end the loop", async () => {
    const clock = fakeClock();
    let started = 0;

    repeatAfterEach(
      async () => {
        started += 1;
        throw new Error("the database blinked");
      },
      100,
      clock.schedule,
    );

    await clock.advance(100);
    expect(started).toBe(1);
    await clock.advance(200);
    expect(started).toBe(2);
  });

  test("stopping means no further runs", async () => {
    const clock = fakeClock();
    let started = 0;
    const loop = repeatAfterEach(
      async () => {
        started += 1;
      },
      100,
      clock.schedule,
    );

    await clock.advance(100);
    expect(started).toBe(1);
    loop.stop();
    await clock.advance(1_000);
    expect(started).toBe(1);
  });
});

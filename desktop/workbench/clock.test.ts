import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  type ClockTarget,
  installClock,
  type PageClock,
  SCENE_EPOCH,
} from "./clock";

// Always a plain target: bun runs all test files in one process, so the real
// globals must never be replaced here.
function makeTarget(): ClockTarget {
  return {
    Date,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    performance: { now: () => 0 },
  };
}

const realSleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

let clock: PageClock | null = null;
let target: ClockTarget;

function setup(start = SCENE_EPOCH): PageClock {
  target = makeTarget();
  clock = installClock(start, target);
  return clock;
}

afterEach(() => {
  clock?.uninstall();
  clock = null;
});

describe("installClock", () => {
  test("starts paused at 0", () => {
    const c = setup();
    expect(c.now()).toBe(0);
    expect(c.playing()).toBe(false);
  });

  test("setTimeout runs at its due time, not before", () => {
    const c = setup();
    const f = mock(() => {});
    target.setTimeout(f, 1000);
    c.advanceTo(999);
    expect(f).toHaveBeenCalledTimes(0);
    c.advanceTo(1000);
    expect(f).toHaveBeenCalledTimes(1);
  });

  test("setTimeout passes extra args to the callback", () => {
    const c = setup();
    const f = mock((_a: number, _b: string) => {});
    target.setTimeout(f, 10, 1, "x");
    c.advanceTo(10);
    expect(f).toHaveBeenCalledWith(1, "x");
  });

  test("setInterval of 1000 runs 3 times by 3000", () => {
    const c = setup();
    const f = mock(() => {});
    target.setInterval(f, 1000);
    c.advanceTo(3000);
    expect(f).toHaveBeenCalledTimes(3);
  });

  test("Date.now and new Date() follow the clock; Date with args is real", () => {
    const c = setup();
    c.advanceTo(1234);
    expect(target.Date.now()).toBe(SCENE_EPOCH + c.now());
    expect(new target.Date().getTime()).toBe(SCENE_EPOCH + c.now());
    expect(new target.Date(0).getTime()).toBe(0);
    expect(new target.Date() instanceof Date).toBe(true);
    expect(target.performance.now()).toBe(1234);
  });

  test("stepToNext returns the next timer time, null when none", () => {
    const c = setup();
    const f = mock(() => {});
    target.setTimeout(f, 700);
    target.setTimeout(f, 300);
    expect(c.stepToNext()).toBe(300);
    expect(c.now()).toBe(300);
    expect(c.stepToNext()).toBe(700);
    expect(c.stepToNext()).toBeNull();
    expect(f).toHaveBeenCalledTimes(2);
  });

  test("clearTimeout cancels; unknown handles are a no-op", () => {
    const c = setup();
    const f = mock(() => {});
    const id = target.setTimeout(f, 100);
    target.clearTimeout(id);
    target.clearTimeout(99999 as unknown as ReturnType<typeof setTimeout>);
    c.advanceTo(200);
    expect(f).toHaveBeenCalledTimes(0);
  });

  test("schedule runs at its absolute time", () => {
    const c = setup();
    const f = mock(() => {});
    c.schedule(500, f);
    c.advanceTo(499);
    expect(f).toHaveBeenCalledTimes(0);
    c.advanceTo(500);
    expect(f).toHaveBeenCalledTimes(1);
  });

  test("onTick gets the new time", () => {
    const c = setup();
    const seen: number[] = [];
    const off = c.onTick((ms) => seen.push(ms));
    c.advanceTo(250);
    expect(seen).toEqual([250]);
    off();
    c.advanceTo(300);
    expect(seen).toEqual([250]);
  });

  test("a timer set inside a callback and due before ms runs in the same advance", () => {
    const c = setup();
    const order: string[] = [];
    target.setTimeout(() => {
      order.push(`outer@${c.now()}`);
      target.setTimeout(() => order.push(`inner@${c.now()}`), 200);
    }, 100);
    c.advanceTo(500);
    expect(order).toEqual(["outer@100", "inner@300"]);
    expect(c.now()).toBe(500);
  });

  test("ties run in scheduling order; advanceTo backwards is a no-op", () => {
    const c = setup();
    const order: number[] = [];
    target.setTimeout(() => order.push(1), 100);
    c.schedule(100, () => order.push(2));
    target.setTimeout(() => order.push(3), 100);
    c.advanceTo(100);
    expect(order).toEqual([1, 2, 3]);
    c.advanceTo(50);
    expect(c.now()).toBe(100);
  });

  test("play(Infinity) reaches a 5000 ms timer quickly, pause stops it", async () => {
    const c = setup();
    const f = mock(() => {});
    const later = mock(() => {});
    target.setTimeout(f, 5000);
    c.play(Number.POSITIVE_INFINITY);
    expect(c.playing()).toBe(true);
    for (let i = 0; i < 50 && f.mock.calls.length === 0; i++)
      await realSleep(2);
    expect(f).toHaveBeenCalledTimes(1);
    c.pause();
    expect(c.playing()).toBe(false);
    target.setTimeout(later, 1000);
    await realSleep(20);
    expect(later).toHaveBeenCalledTimes(0);
    expect(c.now()).toBe(5000);
  });

  test("uninstall restores the target's functions", () => {
    const t = makeTarget();
    const perfNow = t.performance.now;
    const c = installClock(SCENE_EPOCH, t);
    expect(t.Date).not.toBe(Date);
    c.uninstall();
    expect(t.Date).toBe(Date);
    expect(t.setTimeout).toBe(setTimeout);
    expect(t.clearTimeout).toBe(clearTimeout);
    expect(t.setInterval).toBe(setInterval);
    expect(t.clearInterval).toBe(clearInterval);
    expect(t.performance.now).toBe(perfNow);
  });
});

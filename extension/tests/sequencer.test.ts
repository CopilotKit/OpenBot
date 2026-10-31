import { describe, expect, test } from "bun:test";
import { createSequencer, SEQ_RESTART_GAP } from "../src/offscreen/sequencer";

function fakeTimers() {
  let nextId = 1;
  const pending = new Map<number, { fn: () => void; at: number }>();
  let clock = 0;
  return {
    set(fn: () => void, ms: number) {
      const id = nextId++;
      pending.set(id, { fn, at: clock + ms });
      return id;
    },
    clear(handle: unknown) {
      pending.delete(handle as number);
    },
    advance(ms: number) {
      clock += ms;
      for (const [id, t] of [...pending]) {
        if (t.at <= clock) {
          pending.delete(id);
          t.fn();
        }
      }
    },
    get size() {
      return pending.size;
    },
  };
}

function makeDeps(now: () => number, initial: number | null = null) {
  const store: { value: number | null; saves: number[] } = {
    value: initial,
    saves: [],
  };
  const timers = fakeTimers();
  return {
    store,
    timers,
    deps: {
      now,
      load: async () => store.value,
      save: async (v: number) => {
        store.value = v;
        store.saves.push(v);
      },
      timers,
    },
  };
}

describe("sequencer", () => {
  test("events from three frames and a restarted offscreen document never share a seq", async () => {
    let now = 1_000_000;
    const store: { value: number | null } = { value: null };
    const timers = fakeTimers();
    const deps = {
      now: () => now,
      load: async () => store.value,
      save: async (v: number) => {
        store.value = v;
      },
      timers,
    };
    const first = await createSequencer(deps);
    const seen = new Set<number>();
    for (let i = 0; i < 3000; i++) seen.add(first.next());
    timers.advance(250);
    await Promise.resolve();
    for (let i = 0; i < 500; i++) seen.add(first.next());
    now -= 5;
    const second = await createSequencer(deps);
    for (let i = 0; i < 1000; i++) {
      const s = second.next();
      expect(seen.has(s)).toBe(false);
      seen.add(s);
    }
    expect(seen.size).toBe(4500);
  });

  test("a first start begins at now times 1000 and counts up by one", async () => {
    const { deps } = makeDeps(() => 1234);
    const sequencer = await createSequencer(deps);
    expect(sequencer.next()).toBe(1_234_000);
    expect(sequencer.next()).toBe(1_234_001);
  });

  test("a restart starts a full gap above the saved seq when the clock is behind it", async () => {
    const { deps } = makeDeps(() => 1, 9_000_000_000);
    const sequencer = await createSequencer(deps);
    expect(sequencer.next()).toBe(9_000_000_000 + SEQ_RESTART_GAP);
  });

  test("a restart starts at the clock when the clock is far ahead of the saved seq", async () => {
    const { deps } = makeDeps(() => 5_000_000, 10);
    const sequencer = await createSequencer(deps);
    expect(sequencer.next()).toBe(5_000_000_000);
  });

  test("saves the last issued seq once per 250 ms, however many were issued", async () => {
    const { deps, store, timers } = makeDeps(() => 5000);
    const sequencer = await createSequencer(deps);
    for (let i = 0; i < 10; i++) sequencer.next();
    expect(store.saves).toEqual([]);
    timers.advance(249);
    expect(store.saves).toEqual([]);
    timers.advance(1);
    expect(store.saves).toEqual([5_000_009]);
    timers.advance(1000);
    expect(store.saves).toEqual([5_000_009]);
    sequencer.next();
    timers.advance(250);
    expect(store.saves).toEqual([5_000_009, 5_000_010]);
  });

  test("flush saves the last issued seq now and cancels the pending save", async () => {
    const { deps, store, timers } = makeDeps(() => 5000);
    const sequencer = await createSequencer(deps);
    sequencer.next();
    sequencer.next();
    await sequencer.flush();
    expect(store.saves).toEqual([5_000_001]);
    expect(timers.size).toBe(0);
  });

  test("flush with nothing issued saves nothing", async () => {
    const { deps, store } = makeDeps(() => 5000);
    const sequencer = await createSequencer(deps);
    await sequencer.flush();
    expect(store.saves).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from "fake-indexeddb";
import {
  type OutboxEvent,
  openOutbox,
  type TrajectoryMeta,
  trajectoryMetaKey,
} from "../src/offscreen/outbox";

type IndexedDbGlobals = {
  indexedDB?: IDBFactory;
  IDBKeyRange?: typeof FakeIDBKeyRange;
};
const globals = globalThis as unknown as IndexedDbGlobals;
let saved: IndexedDbGlobals = {};

beforeEach(() => {
  saved = { indexedDB: globals.indexedDB, IDBKeyRange: globals.IDBKeyRange };
  globals.indexedDB = new IDBFactory();
  globals.IDBKeyRange = FakeIDBKeyRange;
});

afterEach(() => {
  for (const key of ["indexedDB", "IDBKeyRange"] as const) {
    if (saved[key] === undefined) Reflect.deleteProperty(globals, key);
    else Object.assign(globals, { [key]: saved[key] });
  }
});

let counter = 0;
const freshName = () => `outbox-test-${Date.now()}-${counter++}`;

const item = (trajectoryId: string, seq: number, bytes = 10): OutboxEvent => ({
  trajectoryId,
  seq,
  bytes,
  event: {
    type: "CUSTOM",
    name: "click",
    timestamp: seq,
    value: { seq },
  },
});

describe("outbox", () => {
  test("a held step's key is noted with its event and goes with its trajectory's records, never another's", async () => {
    const outbox = await openOutbox(freshName());
    await outbox.put(item("t1", 1), "step-a");
    await outbox.put(item("t2", 2), "step-b");
    // Taken, sent and removed from the outbox: the trajectory still remembers it took the step.
    await outbox.remove("t1", [1]);
    expect(await outbox.hasStep(["t1"], "step-a")).toBe(true);
    expect(await outbox.hasStep(["t0", "t1"], "step-a")).toBe(true);
    expect(await outbox.hasStep(["t2"], "step-a")).toBe(false);
    expect(await outbox.trajectories()).toEqual(["t2"]);
    await outbox.clear("t1");
    expect(await outbox.hasStep(["t1"], "step-a")).toBe(false);
    expect(await outbox.hasStep(["t2"], "step-b")).toBe(true);
  });

  test("oldest returns events in seq order and respects the event limit", async () => {
    const outbox = await openOutbox(freshName());
    for (const seq of [3, 1, 2, 4]) await outbox.put(item("t1", seq));
    await outbox.put(item("t2", 0));
    const got = await outbox.oldest("t1", 3, 1000);
    expect(got.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  test("oldest respects the byte limit but always returns the first event", async () => {
    const outbox = await openOutbox(freshName());
    await outbox.put(item("t1", 1, 40));
    await outbox.put(item("t1", 2, 40));
    await outbox.put(item("t1", 3, 40));
    expect((await outbox.oldest("t1", 10, 100)).map((e) => e.seq)).toEqual([
      1, 2,
    ]);
    expect((await outbox.oldest("t1", 10, 10)).map((e) => e.seq)).toEqual([1]);
  });

  test("remove deletes only the named seqs", async () => {
    const outbox = await openOutbox(freshName());
    for (const seq of [1, 2, 3]) await outbox.put(item("t1", seq));
    await outbox.remove("t1", [1, 3]);
    expect((await outbox.oldest("t1", 10, 1000)).map((e) => e.seq)).toEqual([
      2,
    ]);
  });

  test("count and clear are per trajectory", async () => {
    const outbox = await openOutbox(freshName());
    for (const seq of [1, 2]) await outbox.put(item("t1", seq));
    await outbox.put(item("t2", 1));
    expect(await outbox.count("t1")).toBe(2);
    await outbox.clear("t1");
    expect(await outbox.count("t1")).toBe(0);
    expect(await outbox.count("t2")).toBe(1);
  });

  test("clear forgets the trajectory's events and meta and leaves the others", async () => {
    const outbox = await openOutbox(freshName());
    const meta = (recordingId: string): TrajectoryMeta => ({
      recordingId,
      title: "t",
      pushed: 0,
      outcomeQueued: false,
      droppedPending: 0,
      stopped: false,
    });
    expect(trajectoryMetaKey("a")).toBe("trajectory:a");
    await outbox.put(item("a", 1));
    await outbox.put(item("b", 1));
    await outbox.setMeta(trajectoryMetaKey("a"), meta("a"));
    await outbox.setMeta(trajectoryMetaKey("b"), meta("b"));
    await outbox.setMeta("seq", 5);
    await outbox.clear("a");
    expect((await outbox.trajectories()).sort()).toEqual(["b"]);
    expect(await outbox.count("a")).toBe(0);
    expect(
      await outbox.getMeta<TrajectoryMeta>(trajectoryMetaKey("a")),
    ).toBeUndefined();
    expect(await outbox.count("b")).toBe(1);
    expect(
      await outbox.getMeta<TrajectoryMeta>(trajectoryMetaKey("b")),
    ).toEqual(meta("b"));
    expect(await outbox.getMeta<number>("seq")).toBe(5);
  });

  test("trajectories lists every trajectory with events or meta, once", async () => {
    const outbox = await openOutbox(freshName());
    await outbox.put(item("a", 1));
    await outbox.put(item("a", 2));
    await outbox.put(item("b", 1));
    await outbox.setMeta("trajectory:c", { stopped: true });
    await outbox.setMeta("seq", 5);
    expect((await outbox.trajectories()).sort()).toEqual(["a", "b", "c"]);
  });

  test("meta round-trips and is absent until set", async () => {
    const outbox = await openOutbox(freshName());
    expect(
      await outbox.getMeta<{ pushed: number }>("trajectory:x"),
    ).toBeUndefined();
    await outbox.setMeta("trajectory:x", { pushed: 3 });
    expect(await outbox.getMeta<{ pushed: number }>("trajectory:x")).toEqual({
      pushed: 3,
    });
  });

  test("a second put of the same [trajectoryId, seq] rejects and keeps the first", async () => {
    const outbox = await openOutbox(freshName());
    await outbox.put(item("t1", 7));
    const clash = { ...item("t1", 7), bytes: 99 };
    await expect(outbox.put(clash)).rejects.toBeDefined();
    const [stored] = await outbox.oldest("t1", 10, 1000);
    expect(stored?.bytes).toBe(10);
  });

  test("events survive reopening the database", async () => {
    const name = freshName();
    const first = await openOutbox(name);
    await first.put(item("t1", 1));
    const second = await openOutbox(name);
    expect(await second.count("t1")).toBe(1);
  });
});

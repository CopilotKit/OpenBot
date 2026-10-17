import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DemonstrationAction } from "@openbot/shared/demonstration-schema";
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from "fake-indexeddb";
import { createStepUploader, type StepTarget } from "../src/background/steps";
import { openRecorderDatabase, requestToPromise } from "../src/shared/database";

type IndexedDbGlobals = {
  indexedDB?: IDBFactory;
  IDBKeyRange?: typeof FakeIDBKeyRange;
};
const globals = globalThis as unknown as IndexedDbGlobals;
let saved: IndexedDbGlobals = {};
let counter = 0;
let db: IDBDatabase;
let dbName = "";
let server: ReturnType<typeof Bun.serve>;
let target: StepTarget;
let answers: Array<(body: Batch) => Response | Promise<Response>> = [];
let received: Batch[] = [];
let storedAtRequest: number[] = [];

type Batch = { fromIndex: number; actions: DemonstrationAction[] };
type Timer = { fn: () => void; ms: number; id: number };

let timers: Timer[] = [];
let timerId = 0;
const fakeTimers = {
  set(fn: () => void, ms: number) {
    const timer = { fn, ms, id: timerId++ };
    timers.push(timer);
    return timer.id;
  },
  clear(handle: unknown) {
    timers = timers.filter((timer) => timer.id !== handle);
  },
};
const fire = (ms?: number) => {
  const timer = timers.find((t) => ms === undefined || t.ms === ms);
  if (!timer) throw new Error(`no timer of ${ms}`);
  timers = timers.filter((t) => t !== timer);
  timer.fn();
};

const click = (n: number): DemonstrationAction => ({
  kind: "click",
  url: "https://example.com/a",
  target: { role: "button", name: `Button ${n}`, sensitive: false },
});

const storedIndexes = async (id = target.demonstrationId) => {
  const rows = await requestToPromise<{ index: number }[]>(
    db
      .transaction("steps", "readonly")
      .objectStore("steps")
      .getAll(IDBKeyRange.bound([id, -Infinity], [id, Infinity])),
  );
  return rows.map((row) => row.index);
};

const uploader = (
  over: Partial<Parameters<typeof createStepUploader>[0]> = {},
  calls: { signedOut: string[]; refused: string[] } = {
    signedOut: [],
    refused: [],
  },
) => ({
  calls,
  steps: createStepUploader({
    target: () => target,
    db: async () => db,
    onSignedOut: async (reason) => {
      calls.signedOut.push(reason);
    },
    onRefused: async (message) => {
      calls.refused.push(message);
    },
    timers: fakeTimers,
    ...over,
  }),
});

const ok = () => Response.json({ count: 0 });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(async () => {
  saved = { indexedDB: globals.indexedDB, IDBKeyRange: globals.IDBKeyRange };
  globals.indexedDB = new IDBFactory();
  globals.IDBKeyRange = FakeIDBKeyRange;
  dbName = `steps-test-${Date.now()}-${counter++}`;
  db = await openRecorderDatabase(dbName);
  timers = [];
  answers = [];
  received = [];
  storedAtRequest = [];
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Batch;
      received.push(body);
      storedAtRequest = await storedIndexes();
      const answer = answers.shift();
      return answer ? answer(body) : ok();
    },
  });
  target = {
    openbotUrl: `http://127.0.0.1:${server.port}`,
    token: "tok",
    demonstrationId: crypto.randomUUID(),
  };
});

afterEach(async () => {
  await server.stop(true);
  db.close();
  for (const key of ["indexedDB", "IDBKeyRange"] as const) {
    if (saved[key] === undefined) Reflect.deleteProperty(globals, key);
    else Object.assign(globals, { [key]: saved[key] });
  }
});

describe("step uploader", () => {
  test("a step is written with its index before anything is uploaded, and deleted once acknowledged", async () => {
    const { steps } = uploader();
    steps.add(click(0));
    steps.add(click(1));
    expect(steps.count()).toBe(2);
    await steps.flush();
    expect(received).toHaveLength(1);
    expect(received[0]?.fromIndex).toBe(0);
    expect(received[0]?.actions).toHaveLength(2);
    expect(storedAtRequest).toEqual([0, 1]);
    expect(await storedIndexes()).toEqual([]);
  });

  test("flushes when 20 steps are waiting, and after 3 s for fewer", async () => {
    const { steps } = uploader();
    for (let i = 0; i < 19; i++) steps.add(click(i));
    await settle();
    expect(received).toHaveLength(0);
    expect(timers.map((t) => t.ms)).toEqual([3000]);
    steps.add(click(19));
    await settle();
    expect(received).toHaveLength(1);
    expect(received[0]?.actions).toHaveLength(20);
    expect(timers).toEqual([]);

    steps.add(click(20));
    await settle();
    expect(received).toHaveLength(1);
    fire(3000);
    await settle();
    expect(received).toHaveLength(2);
    expect(received[1]?.fromIndex).toBe(20);
  });

  test("a batch holds at most 50 actions", async () => {
    const { steps } = uploader();
    for (let i = 0; i < 120; i++) steps.add(click(i));
    await steps.flush();
    expect(received.map((b) => [b.fromIndex, b.actions.length])).toEqual([
      [0, 50],
      [50, 50],
      [100, 20],
    ]);
  });

  test("a batch holds at most 200 KB", async () => {
    const { steps } = uploader();
    const big = (n: number) =>
      ({
        ...click(n),
        target: { role: "button", name: "x".repeat(10_000), sensitive: false },
      }) as DemonstrationAction;
    for (let i = 0; i < 30; i++) steps.add(big(i));
    await steps.flush();
    expect(received.length).toBeGreaterThan(1);
    let total = 0;
    for (const batch of received) {
      expect(JSON.stringify(batch.actions).length).toBeLessThanOrEqual(
        200 * 1024 + 100,
      );
      total += batch.actions.length;
    }
    expect(total).toBe(30);
    expect(received.map((b) => b.fromIndex)).toEqual(
      received.map((_, i) =>
        received.slice(0, i).reduce((n, b) => n + b.actions.length, 0),
      ),
    );
  });

  test("a 409 drops the steps OpenBot already has and resends from its count", async () => {
    const { steps } = uploader();
    for (let i = 0; i < 5; i++) steps.add(click(i));
    answers.push(() =>
      Response.json({ error: "Out of order.", count: 3 }, { status: 409 }),
    );
    await steps.flush();
    expect(received).toHaveLength(2);
    expect(received[1]?.fromIndex).toBe(3);
    expect(received[1]?.actions).toHaveLength(2);
    expect(await storedIndexes()).toEqual([]);
  });

  test("a 409 that names no usable count is a refusal, not a loop", async () => {
    const { steps, calls } = uploader();
    steps.add(click(0));
    answers.push(() =>
      Response.json({ error: "Out of order." }, { status: 409 }),
    );
    await expect(steps.flush()).rejects.toThrow("Out of order.");
    expect(received).toHaveLength(1);
    expect(calls.refused).toEqual(["Out of order."]);
    expect(await storedIndexes()).toEqual([0]);
  });

  test("a 5xx retries at 1, 2, 4, 8, 16, then every 30 seconds, keeping the steps", async () => {
    const { steps } = uploader();
    steps.add(click(0));
    for (let i = 0; i < 7; i++)
      answers.push(() => Response.json({ error: "down" }, { status: 503 }));
    await expect(steps.flush()).rejects.toThrow("down");
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      const retry = timers.find((t) => t.ms !== 3000);
      if (!retry) throw new Error("no retry timer");
      delays.push(retry.ms);
      fire(retry.ms);
      await settle();
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    expect(await storedIndexes()).toEqual([0]);
    expect(timers.map((t) => t.ms)).toEqual([30000]);
    fire(30000);
    await settle();
    expect(received).toHaveLength(8);
    expect(await storedIndexes()).toEqual([]);
    expect(timers).toEqual([]);
  });

  test("a network failure is retried too", async () => {
    const { steps } = uploader();
    steps.add(click(0));
    await server.stop(true);
    await expect(steps.flush()).rejects.toBeDefined();
    expect(timers.map((t) => t.ms)).toEqual([1000]);
    expect(await storedIndexes()).toEqual([0]);
  });

  test("a signedOut 401 calls onSignedOut once with its reason and keeps every step", async () => {
    const { steps, calls } = uploader();
    for (let i = 0; i < 3; i++) steps.add(click(i));
    answers.push(() =>
      Response.json(
        { error: "Gone.", code: "RECORDER_SIGNED_OUT", reason: "revoked" },
        { status: 401 },
      ),
    );
    await expect(steps.flush()).rejects.toThrow("Gone.");
    await steps.flush();
    steps.add(click(3));
    await steps.flush();
    expect(calls.signedOut).toEqual(["revoked"]);
    expect(received).toHaveLength(1);
    expect(timers).toEqual([]);
    expect(await storedIndexes()).toEqual([0, 1, 2, 3]);
  });

  test("a 401 without the signed-out code is retried as a failure", async () => {
    const { steps, calls } = uploader();
    steps.add(click(0));
    answers.push(() => new Response("nope", { status: 401 }));
    await expect(steps.flush()).rejects.toBeDefined();
    expect(calls.signedOut).toEqual([]);
    expect(timers.map((t) => t.ms)).toEqual([1000]);
    expect(await storedIndexes()).toEqual([0]);
  });

  test("a 400 calls onRefused once and uploads nothing more", async () => {
    const { steps, calls } = uploader();
    steps.add(click(0));
    answers.push(() =>
      Response.json({ error: "Not accepted." }, { status: 400 }),
    );
    await expect(steps.flush()).rejects.toThrow("Not accepted.");
    steps.add(click(1));
    await steps.flush();
    expect(calls.refused).toEqual(["Not accepted."]);
    expect(received).toHaveLength(1);
    expect(await storedIndexes()).toEqual([0, 1]);
  });

  test("a refusal stops live upload for that recording only, not the next one with the same token", async () => {
    const { steps, calls } = uploader();
    steps.add(click(0));
    answers.push(() =>
      Response.json({ error: "Not accepted." }, { status: 400 }),
    );
    await expect(steps.flush()).rejects.toThrow("Not accepted.");
    const refusedId = target.demonstrationId;
    target = { ...target, demonstrationId: crypto.randomUUID() };
    steps.add(click(1));
    await steps.flush();
    expect(calls.refused).toEqual(["Not accepted."]);
    expect(received).toHaveLength(2);
    expect(await storedIndexes()).toEqual([]);
    expect(await storedIndexes(refusedId)).toEqual([0]);
  });

  test("a sign-out stops live upload with that token for every recording", async () => {
    const { steps } = uploader();
    steps.add(click(0));
    answers.push(() =>
      Response.json(
        { error: "Gone.", code: "RECORDER_SIGNED_OUT", reason: "revoked" },
        { status: 401 },
      ),
    );
    await expect(steps.flush()).rejects.toThrow("Gone.");
    target = { ...target, demonstrationId: crypto.randomUUID() };
    steps.add(click(1));
    await steps.flush();
    expect(received).toHaveLength(1);
    expect(await storedIndexes()).toEqual([0]);
  });

  test("a sign-out with no reason is reported as revoked", async () => {
    const { steps, calls } = uploader();
    steps.add(click(0));
    answers.push(() =>
      Response.json(
        { error: "Gone.", code: "RECORDER_SIGNED_OUT" },
        { status: 401 },
      ),
    );
    await expect(steps.flush()).rejects.toThrow("Gone.");
    expect(calls.signedOut).toEqual(["revoked"]);
  });

  test("after a restart, load resends unacknowledged steps with their original indexes and keeps counting", async () => {
    const first = uploader();
    for (let i = 0; i < 3; i++) first.steps.add(click(i));
    answers.push(() => Response.json({ error: "down" }, { status: 503 }));
    await expect(first.steps.flush()).rejects.toBeDefined();
    timers = [];

    const second = uploader();
    await second.steps.load();
    expect(second.steps.count()).toBe(3);
    second.steps.add(click(3));
    await second.steps.flush();
    expect(received.at(-1)?.fromIndex).toBe(0);
    expect(received.at(-1)?.actions).toHaveLength(4);
  });

  test("the index keeps counting after every step was acknowledged", async () => {
    const first = uploader();
    first.steps.add(click(0));
    first.steps.add(click(1));
    await first.steps.flush();
    const second = uploader();
    await second.steps.load();
    second.steps.add(click(2));
    await second.steps.flush();
    expect(received.at(-1)?.fromIndex).toBe(2);
  });

  test("5,000 queued steps are all kept and sent in order", async () => {
    const { steps } = uploader();
    answers = Array.from(
      { length: 100 },
      () => () => Response.json({ error: "down" }, { status: 503 }),
    );
    for (let i = 0; i < 5000; i++) steps.add(click(i));
    await expect(steps.flush()).rejects.toBeDefined();
    expect((await storedIndexes()).length).toBe(5000);
    answers = [];
    received = [];
    await steps.flush();
    const indexes = received.flatMap((b) =>
      b.actions.map((_, i) => b.fromIndex + i),
    );
    expect(indexes).toEqual(Array.from({ length: 5000 }, (_, i) => i));
    expect(await storedIndexes()).toEqual([]);
  }, 60_000);

  test("drain uploads every queued step of one demonstration whatever the in-memory state", async () => {
    const orphan: StepTarget = {
      ...target,
      demonstrationId: crypto.randomUUID(),
    };
    const writer = uploader({ target: () => orphan });
    for (let i = 0; i < 3; i++) writer.steps.add(click(i));
    answers.push(() => Response.json({ error: "down" }, { status: 503 }));
    await expect(writer.steps.flush()).rejects.toBeDefined();
    received = [];
    answers = [];
    // A fresh uploader that never saw the demonstration.
    const { steps } = uploader({ target: () => null });
    await steps.drain(orphan);
    expect(received).toHaveLength(1);
    expect(received[0]?.actions).toHaveLength(3);
    expect(await storedIndexes(orphan.demonstrationId)).toEqual([]);
  });

  test("drain rejects on a 404 and leaves the steps", async () => {
    const { steps } = uploader();
    steps.add(click(0));
    await steps.flush();
    steps.add(click(1));
    answers.push(() => Response.json({ error: "Gone." }, { status: 404 }));
    await expect(steps.drain(target)).rejects.toThrow("Gone.");
    expect(await storedIndexes()).toEqual([1]);
  });

  test("drain reports a sign-out and keeps the steps", async () => {
    const { steps, calls } = uploader();
    steps.add(click(0));
    answers.push(() =>
      Response.json(
        { error: "Gone.", code: "RECORDER_SIGNED_OUT", reason: "organization" },
        { status: 401 },
      ),
    );
    await expect(steps.drain(target)).rejects.toThrow("Gone.");
    expect(calls.signedOut).toEqual(["organization"]);
    expect(await storedIndexes()).toEqual([0]);
  });

  test("adding a step with no recording open throws", () => {
    const { steps } = uploader({ target: () => null });
    expect(() => steps.add(click(0))).toThrow("No recording is open");
  });

  test("reset deletes the demonstration's queue and restarts its count", async () => {
    const { steps } = uploader();
    steps.add(click(0));
    steps.add(click(1));
    await steps.reset(target.demonstrationId);
    expect(steps.count()).toBe(0);
    expect(await storedIndexes()).toEqual([]);
    expect(timers).toEqual([]);
    steps.add(click(2));
    await steps.flush();
    expect(received.at(-1)?.fromIndex).toBe(0);
  });
});

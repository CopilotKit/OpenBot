import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  networkBodyRef,
  RECORDER_MEDIA_CHUNK_BYTES,
  RECORDER_NETWORK_BODY_MAX_BYTES,
  RECORDER_SIGNED_OUT,
} from "@openbot/shared/recorder-api";
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from "fake-indexeddb";
import {
  createBodyStore,
  type NetworkBodyRecord,
  recoverNetworkBodies,
} from "../src/background/network/body-store";
import type { RecordingContext } from "../src/background/network/index";
import * as database from "../src/shared/database";
import { openRecorderDatabase, requestToPromise } from "../src/shared/database";
import { OpenBotError } from "../src/shared/openbot-client";
import type { DrainRecord } from "../src/shared/storage";

type IndexedDbGlobals = {
  indexedDB?: IDBFactory;
  IDBKeyRange?: typeof FakeIDBKeyRange;
};
const globals = globalThis as unknown as IndexedDbGlobals;
let saved: IndexedDbGlobals = {};
let counter = 0;
let db: IDBDatabase;
let server: ReturnType<typeof Bun.serve>;
let context: RecordingContext;

type Put = {
  mediaId: string;
  index: number;
  bytes: Uint8Array;
  authorization: string | null;
};
let mediaPosts: { demonstrationId: string; body: unknown }[] = [];
let puts: Put[] = [];
let completes: { mediaId: string; body: unknown }[] = [];
let mediaAnswers: Response[] = [];
let putAnswers: Response[] = [];

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
const fire = (ms: number) => {
  const timer = timers.find((t) => t.ms === ms);
  if (!timer) throw new Error(`no timer of ${ms}`);
  timers = timers.filter((t) => t !== timer);
  timer.fn();
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

const record = (n: number, size = 10): NetworkBodyRecord => ({
  requestId: `r${n}`,
  url: `https://api.example.test/v1/items/${n}`,
  method: "POST",
  status: 200,
  request: { headers: { "content-type": "application/json" }, body: "{}" },
  response: { headers: {}, body: "x".repeat(size) },
});

const makeStore = () =>
  createBodyStore(() => context, { db: async () => db, timers: fakeTimers });

const joined = (rows: Put[]) => {
  const sorted = [...rows].sort((a, b) => a.index - b.index);
  const all = new Uint8Array(sorted.reduce((n, p) => n + p.bytes.length, 0));
  let at = 0;
  for (const part of sorted) {
    all.set(part.bytes, at);
    at += part.bytes.length;
  }
  return new TextDecoder().decode(all);
};
const lines = (rows: Put[]) =>
  joined(rows)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as NetworkBodyRecord);

const storedLines = async () =>
  (
    await requestToPromise<{ line: number }[]>(
      db.transaction("bodies", "readonly").objectStore("bodies").getAll(),
    )
  ).map((row) => row.line);

const mediaRecord = (id: string) => ({
  media: {
    id,
    kind: "network",
    mimeType: "application/x-ndjson",
    chunks: [],
    byteSize: 0,
    completedAt: null,
  },
});

beforeEach(async () => {
  saved = { indexedDB: globals.indexedDB, IDBKeyRange: globals.IDBKeyRange };
  globals.indexedDB = new IDBFactory();
  globals.IDBKeyRange = FakeIDBKeyRange;
  db = await openRecorderDatabase(`body-store-test-${Date.now()}-${counter++}`);
  timers = [];
  mediaPosts = [];
  puts = [];
  completes = [];
  mediaAnswers = [];
  putAnswers = [];
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const parts = path.split("/");
      // /api/recorder/demonstrations/:d/media[/:m/(chunks/:i|complete)]
      const demonstrationId = parts[4] ?? "";
      if (request.method === "POST" && parts.length === 6) {
        mediaPosts.push({ demonstrationId, body: await request.json() });
        return (
          mediaAnswers.shift() ??
          Response.json(mediaRecord(crypto.randomUUID()), { status: 201 })
        );
      }
      const mediaId = parts[6] ?? "";
      if (request.method === "PUT") {
        puts.push({
          mediaId,
          index: Number(parts[8]),
          bytes: new Uint8Array(await request.arrayBuffer()),
          authorization: request.headers.get("authorization"),
        });
        return putAnswers.shift() ?? Response.json(mediaRecord(mediaId));
      }
      completes.push({ mediaId, body: await request.json() });
      return Response.json(mediaRecord(mediaId));
    },
  });
  context = {
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

describe("body store", () => {
  test("the media is created once however many adds are concurrent, and lines count in call order", async () => {
    const store = makeStore();
    const refs = await Promise.all(
      [0, 1, 2, 3, 4].map((n) => store.add(record(n))),
    );
    expect(mediaPosts).toHaveLength(1);
    expect(mediaPosts[0]).toEqual({
      demonstrationId: context.demonstrationId,
      body: { kind: "network", mimeType: "application/x-ndjson" },
    });
    const mediaId = refs[0]?.split("/media/")[1]?.split("/")[0] ?? "";
    expect(mediaId).not.toBe("");
    expect(refs).toEqual(
      [0, 1, 2, 3, 4].map((n) =>
        networkBodyRef(context.openbotUrl, context.demonstrationId, mediaId, n),
      ),
    );
  });

  test("a line is in IndexedDB before add resolves, and the next line number is kept", async () => {
    const store = makeStore();
    await store.add(record(0));
    expect(await storedLines()).toEqual([0]);
    const mediaId = (await requestToPromise<string>(
      db
        .transaction("meta", "readonly")
        .objectStore("meta")
        .get(`media:${context.demonstrationId}:network`),
    )) as string;
    const next = await requestToPromise<number>(
      db
        .transaction("meta", "readonly")
        .objectStore("meta")
        .get(`bodies-next:${mediaId}`),
    );
    expect(next).toBe(1);
    expect(puts).toHaveLength(0);
  });

  test("lines go up in chunks of at most 512 KiB, split across lines, and leave IndexedDB once acknowledged", async () => {
    const store = makeStore();
    for (let n = 0; n < 4; n++) await store.add(record(n, 300 * 1024));
    await store.flush();
    const sorted = [...puts].sort((a, b) => a.index - b.index);
    expect(sorted.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(sorted[0]?.bytes.length).toBe(RECORDER_MEDIA_CHUNK_BYTES);
    expect(sorted[1]?.bytes.length).toBe(RECORDER_MEDIA_CHUNK_BYTES);
    expect(sorted.every((p) => p.authorization === "Bearer tok")).toBe(true);
    expect(lines(puts).map((r) => r.requestId)).toEqual([
      "r0",
      "r1",
      "r2",
      "r3",
    ]);
    expect(await storedLines()).toEqual([]);
  });

  test("a small body waits for the 5 s timer", async () => {
    const store = makeStore();
    await store.add(record(0));
    expect(puts).toHaveLength(0);
    fire(5000);
    await settle();
    expect(puts).toHaveLength(1);
    expect(lines(puts).map((r) => r.requestId)).toEqual(["r0"]);
    expect(await storedLines()).toEqual([]);
  });

  test("close sends what is left and completes the media with its chunk count", async () => {
    const store = makeStore();
    await store.add(record(0));
    await store.add(record(1));
    await store.close();
    expect(puts).toHaveLength(1);
    expect(completes).toEqual([
      { mediaId: puts[0]?.mediaId ?? "", body: { chunkCount: 1 } },
    ]);
    expect(await storedLines()).toEqual([]);
  });

  test("a changed demonstration starts a new media with lines from 0", async () => {
    const store = makeStore();
    const first = await store.add(record(0));
    context = { ...context, demonstrationId: crypto.randomUUID() };
    const second = await store.add(record(1));
    expect(mediaPosts.map((p) => p.demonstrationId)).toEqual([
      mediaPosts[0]?.demonstrationId ?? "",
      context.demonstrationId,
    ]);
    expect(mediaPosts).toHaveLength(2);
    expect(second).toContain(`/demonstrations/${context.demonstrationId}/`);
    expect(second.endsWith("/lines/0")).toBe(true);
    expect(first.endsWith("/lines/0")).toBe(true);
    expect(second).not.toBe(first);
  });

  test("a failed media creation rejects add, and the next add tries again", async () => {
    mediaAnswers = [Response.json({ error: "down" }, { status: 500 })];
    const store = makeStore();
    await expect(store.add(record(0))).rejects.toBeDefined();
    expect(await storedLines()).toEqual([]);
    const ref = await store.add(record(1));
    expect(ref.endsWith("/lines/0")).toBe(true);
    expect(mediaPosts).toHaveLength(2);
  });

  test("a store created after a service-worker restart uploads the pending lines with their original numbers, none twice", async () => {
    const first = makeStore();
    await first.add(record(0));
    await first.add(record(1));
    expect(puts).toHaveLength(0);
    const second = makeStore();
    await second.resume();
    expect(lines(puts).map((r) => r.requestId)).toEqual(["r0", "r1"]);
    await second.resume();
    expect(puts).toHaveLength(1);
    expect(mediaPosts).toHaveLength(1);
    const ref = await second.add(record(2));
    expect(ref.endsWith("/lines/2")).toBe(true);
    expect(mediaPosts).toHaveLength(1);
    expect(await storedLines()).toEqual([2]);
  });

  test("a chunk whose PUT failed is resent with the same index and bytes", async () => {
    putAnswers = [Response.json({ error: "down" }, { status: 500 })];
    const store = makeStore();
    await store.add(record(0));
    await expect(store.flush()).rejects.toBeDefined();
    expect(await storedLines()).toEqual([0]);
    await store.add(record(1));
    await store.flush();
    expect(puts).toHaveLength(3);
    expect(puts[1]?.index).toBe(0);
    expect(Array.from(puts[1]?.bytes ?? [])).toEqual(
      Array.from(puts[0]?.bytes ?? [1]),
    );
    expect(puts[2]?.index).toBe(1);
    expect(lines([puts[2] as Put]).map((r) => r.requestId)).toEqual(["r1"]);
    expect(await storedLines()).toEqual([]);
  });

  test("a failed timer flush stays in IndexedDB and tries again on the next timer", async () => {
    putAnswers = [Response.json({ error: "down" }, { status: 500 })];
    const store = makeStore();
    await store.add(record(0));
    fire(5000);
    await settle();
    expect(puts).toHaveLength(1);
    expect(await storedLines()).toEqual([0]);
    fire(5000);
    await settle();
    expect(puts).toHaveLength(2);
    expect(await storedLines()).toEqual([]);
  });

  test("recoverNetworkBodies uploads a drain's pending lines and completes its media, then does nothing", async () => {
    const store = makeStore();
    await store.add(record(0));
    await store.add(record(1));
    const drain = { demonstrationId: context.demonstrationId } as DrainRecord;
    const target = { openbotUrl: context.openbotUrl, token: "tok2" };
    await recoverNetworkBodies(drain, target, { db: async () => db });
    expect(lines(puts).map((r) => r.requestId)).toEqual(["r0", "r1"]);
    expect(puts[0]?.authorization).toBe("Bearer tok2");
    expect(completes).toEqual([
      { mediaId: puts[0]?.mediaId ?? "", body: { chunkCount: 1 } },
    ]);
    await recoverNetworkBodies(drain, target, { db: async () => db });
    expect(puts).toHaveLength(1);
    expect(completes).toHaveLength(1);
  });

  test("a chunk upload refused as signed out rejects recovery with a signed-out OpenBotError, and the lines stay", async () => {
    putAnswers = [
      Response.json(
        {
          error: "This Recorder was signed out.",
          code: RECORDER_SIGNED_OUT,
          reason: "revoked",
        },
        { status: 401 },
      ),
    ];
    const store = makeStore();
    await store.add(record(0));
    const failure = await recoverNetworkBodies(
      { demonstrationId: context.demonstrationId } as DrainRecord,
      { openbotUrl: context.openbotUrl, token: "tok" },
      { db: async () => db },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(OpenBotError);
    expect((failure as OpenBotError).signedOut).toBe(true);
    expect((failure as OpenBotError).body?.reason).toBe("revoked");
    expect((failure as OpenBotError).message).toBe(
      "This Recorder was signed out.",
    );
    expect(completes).toHaveLength(0);
    expect(await storedLines()).toEqual([0]);
  });

  test("recoverNetworkBodies completes a media whose lines were all acknowledged before the crash, then does nothing", async () => {
    const store = makeStore();
    for (let n = 0; n < 4; n++) await store.add(record(n, 300 * 1024));
    await store.flush();
    expect(puts).toHaveLength(3);
    expect(await storedLines()).toEqual([]);
    expect(completes).toHaveLength(0);
    const drain = { demonstrationId: context.demonstrationId } as DrainRecord;
    const target = { openbotUrl: context.openbotUrl, token: "tok2" };
    await recoverNetworkBodies(drain, target, { db: async () => db });
    expect(puts).toHaveLength(3);
    expect(completes).toEqual([
      { mediaId: puts[0]?.mediaId ?? "", body: { chunkCount: 3 } },
    ]);
    await recoverNetworkBodies(drain, target, { db: async () => db });
    expect(puts).toHaveLength(3);
    expect(completes).toHaveLength(1);
  });

  test("recoverNetworkBodies sends nothing for a media close already completed", async () => {
    const store = makeStore();
    await store.add(record(0));
    await store.close();
    expect(completes).toHaveLength(1);
    await recoverNetworkBodies(
      { demonstrationId: context.demonstrationId } as DrainRecord,
      { openbotUrl: context.openbotUrl, token: "tok" },
      { db: async () => db },
    );
    expect(puts).toHaveLength(1);
    expect(completes).toHaveLength(1);
  });

  test("the default opener opens the Recorder database once however many adds there are", async () => {
    const opens = spyOn(database, "openRecorderDatabase");
    try {
      const store = createBodyStore(() => context, { timers: fakeTimers });
      for (let n = 0; n < 5; n++) await store.add(record(n));
      await store.flush();
      expect(lines(puts).map((r) => r.requestId)).toEqual([
        "r0",
        "r1",
        "r2",
        "r3",
        "r4",
      ]);
      expect(opens).toHaveBeenCalledTimes(1);
    } finally {
      for (const result of opens.mock.results)
        (await (result.value as Promise<IDBDatabase>)).close();
      opens.mockRestore();
    }
  });

  test("recoverNetworkBodies sends nothing for a recording that never kept a body", async () => {
    await recoverNetworkBodies(
      { demonstrationId: crypto.randomUUID() } as DrainRecord,
      { openbotUrl: context.openbotUrl, token: "tok" },
      { db: async () => db },
    );
    expect(mediaPosts.length + puts.length + completes.length).toBe(0);
  });

  test("a 3 MiB body is kept as its first 2 MiB, marked truncated with its full size", async () => {
    const store = makeStore();
    const full = 3 * 1024 * 1024;
    await store.add({
      ...record(0),
      response: { headers: {}, body: "a".repeat(full) },
    });
    await store.flush();
    const [stored] = lines(puts);
    expect(stored?.response.status).toBe("truncated");
    expect(stored?.response.bytes).toBe(full);
    expect(stored?.response.body?.length).toBe(RECORDER_NETWORK_BODY_MAX_BYTES);
    expect(stored?.request.status).toBeUndefined();
  });

  test("the cut never splits a code point", async () => {
    const store = makeStore();
    // "€" is 3 bytes: 2 MiB is not a multiple of 3, so a byte cut lands inside one.
    const body = "€".repeat(900_000);
    await store.add({ ...record(0), response: { headers: {}, body } });
    await store.flush();
    const [stored] = lines(puts);
    const kept = stored?.response.body ?? "";
    expect(stored?.response.status).toBe("truncated");
    expect(stored?.response.bytes).toBe(900_000 * 3);
    expect(kept).not.toContain("�");
    expect(new TextEncoder().encode(kept).length).toBeLessThanOrEqual(
      RECORDER_NETWORK_BODY_MAX_BYTES,
    );
    expect(new TextEncoder().encode(kept).length).toBeGreaterThan(
      RECORDER_NETWORK_BODY_MAX_BYTES - 3,
    );
  });
});

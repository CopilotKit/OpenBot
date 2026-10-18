import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  RECORDER_MEDIA_CHUNK_BYTES,
  RECORDER_SIGNED_OUT,
} from "@openbot/shared/recorder-api";
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from "fake-indexeddb";
import {
  type MediaBuffer,
  openMediaBuffer,
} from "../src/offscreen/media-buffer";
import { createMediaUploader } from "../src/offscreen/uploader";

type IndexedDbGlobals = {
  indexedDB?: IDBFactory;
  IDBKeyRange?: typeof FakeIDBKeyRange;
};
const globals = globalThis as unknown as IndexedDbGlobals;
let saved: IndexedDbGlobals = {};
let counter = 0;
let buffer: MediaBuffer;
let server: ReturnType<typeof Bun.serve>;

type Put = { index: number; bytes: number; authorization: string | null };
let posts: unknown[] = [];
let puts: Put[] = [];
let completes: unknown[] = [];
let putAnswers: Response[] = [];
let delays: number[] = [];

const sleep = async (ms: number) => {
  delays.push(ms);
};
const target = () => ({
  openbotUrl: `http://127.0.0.1:${server.port}`,
  token: "tok",
  demonstrationId: "demo-1",
});
const pendingCounts: number[] = [];
const make = (overrides: { sleep?: (ms: number) => Promise<void> } = {}) =>
  createMediaUploader({
    target,
    buffer,
    kind: "screen",
    mimeType: "video/webm",
    onPending: (count) => pendingCounts.push(count),
    sleep,
    ...overrides,
  });
const bytes = (size: number) => new Blob([new Uint8Array(size)]);
const signedOut = () =>
  Response.json(
    { error: "Sign in again.", code: RECORDER_SIGNED_OUT },
    { status: 401 },
  );

beforeEach(async () => {
  saved = { indexedDB: globals.indexedDB, IDBKeyRange: globals.IDBKeyRange };
  globals.indexedDB = new IDBFactory();
  globals.IDBKeyRange = FakeIDBKeyRange;
  buffer = await openMediaBuffer(`uploader-test-${Date.now()}-${counter++}`);
  posts = [];
  puts = [];
  completes = [];
  putAnswers = [];
  delays = [];
  pendingCounts.length = 0;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname.endsWith("/media")) {
        posts.push(await request.json());
        return Response.json({ media: { id: "media-1" } }, { status: 201 });
      }
      const chunk = url.pathname.match(/\/chunks\/(\d+)$/);
      if (request.method === "PUT" && chunk) {
        const next = putAnswers.shift();
        if (next) return next;
        puts.push({
          index: Number(chunk[1]),
          bytes: (await request.arrayBuffer()).byteLength,
          authorization: request.headers.get("authorization"),
        });
        return Response.json({ media: { id: "media-1" } });
      }
      if (request.method === "POST" && url.pathname.endsWith("/complete")) {
        completes.push(await request.json());
        return Response.json({ media: { id: "media-1" } });
      }
      return new Response("no", { status: 404 });
    },
  });
});

afterEach(async () => {
  await server.stop(true);
  for (const key of ["indexedDB", "IDBKeyRange"] as const) {
    if (saved[key] === undefined) Reflect.deleteProperty(globals, key);
    else Object.assign(globals, { [key]: saved[key] });
  }
});

describe("media uploader", () => {
  test("creates the media once and remembers it", async () => {
    await make();
    expect(posts).toEqual([{ kind: "screen", mimeType: "video/webm" }]);
    expect(await buffer.mediaFor("demo-1", "screen")).toBe("media-1");
  });

  test("uploads chunks in order with the bearer and completes on finish", async () => {
    const uploader = await make();
    await uploader.add(bytes(10));
    await uploader.add(bytes(20));
    await uploader.add(bytes(30));
    await uploader.finish();
    expect(puts.map((p) => [p.index, p.bytes])).toEqual([
      [0, 10],
      [1, 20],
      [2, 30],
    ]);
    expect(puts.every((p) => p.authorization === "Bearer tok")).toBe(true);
    expect(completes).toEqual([{ chunkCount: 3 }]);
    expect(await buffer.take("media-1")).toEqual([]);
    expect(pendingCounts.at(-1)).toBe(0);
  });

  test("a 500 is retried after 1, 2, 4, 8 and 30 seconds, then 30 again", async () => {
    putAnswers = Array.from(
      { length: 6 },
      () => new Response("down", { status: 500 }),
    );
    const uploader = await make();
    await uploader.add(bytes(5));
    await uploader.finish();
    expect(delays).toEqual([1000, 2000, 4000, 8000, 30000, 30000]);
    expect(puts.map((p) => p.index)).toEqual([0]);
    expect(completes).toEqual([{ chunkCount: 1 }]);
  });

  test("a 1.2 MiB blob is buffered as three pieces under three consecutive indexes", async () => {
    const uploader = await make({
      sleep: () => new Promise<void>(() => {}),
    });
    putAnswers = [signedOut()];
    const size = Math.floor(1.2 * 1024 * 1024);
    await uploader.add(bytes(size));
    await uploader.finish();
    const kept = await buffer.take("media-1");
    expect(kept.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(kept.map((c) => c.blob.size)).toEqual([
      RECORDER_MEDIA_CHUNK_BYTES,
      RECORDER_MEDIA_CHUNK_BYTES,
      size - 2 * RECORDER_MEDIA_CHUNK_BYTES,
    ]);
    const next = await uploader
      .add(bytes(7))
      .then(() => buffer.take("media-1"));
    expect(next.map((c) => c.index)).toEqual([0, 1, 2, 3]);
  });

  test("a signed-out upload keeps its buffered chunks and does not complete", async () => {
    putAnswers = [signedOut()];
    const uploader = await make();
    await uploader.add(bytes(4));
    await uploader.add(bytes(6));
    await uploader.finish();
    expect(puts).toEqual([]);
    expect(completes).toEqual([]);
    expect((await buffer.take("media-1")).map((c) => c.index)).toEqual([0, 1]);
    expect(pendingCounts.at(-1)).toBe(2);
  });

  test("abandon drops the buffered chunks and later blobs", async () => {
    putAnswers = [signedOut()];
    const uploader = await make();
    await uploader.add(bytes(4));
    await uploader.finish();
    await uploader.abandon();
    expect(await buffer.take("media-1")).toEqual([]);
    await uploader.add(bytes(4));
    expect(await buffer.take("media-1")).toEqual([]);
    expect(pendingCounts.at(-1)).toBe(0);
  });

  test("abandon ends a retry that is waiting", async () => {
    putAnswers = [new Response("down", { status: 500 })];
    const uploader = await make({ sleep: () => new Promise<void>(() => {}) });
    await uploader.add(bytes(4));
    await Bun.sleep(50);
    await uploader.abandon();
    expect(await buffer.take("media-1")).toEqual([]);
    expect(puts).toEqual([]);
  });
});

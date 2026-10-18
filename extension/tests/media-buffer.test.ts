import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from "fake-indexeddb";
import { openMediaBuffer } from "../src/offscreen/media-buffer";

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
const freshName = () => `media-buffer-test-${Date.now()}-${counter++}`;
const chunk = (text: string) => new Blob([text], { type: "video/webm" });

describe("media buffer", () => {
  test("puts chunks and takes them back in index order", async () => {
    const buffer = await openMediaBuffer(freshName());
    await buffer.put("media-a", 2, chunk("two"));
    await buffer.put("media-a", 0, chunk("zero"));
    await buffer.put("media-a", 1, chunk("one"));
    await buffer.put("media-b", 0, chunk("other"));
    const taken = await buffer.take("media-a");
    expect(taken.map((item) => item.index)).toEqual([0, 1, 2]);
    expect(await Promise.all(taken.map((item) => item.blob.text()))).toEqual([
      "zero",
      "one",
      "two",
    ]);
  });

  test("take leaves the chunks in place and an unknown media is empty", async () => {
    const buffer = await openMediaBuffer(freshName());
    await buffer.put("media-a", 0, chunk("zero"));
    expect(await buffer.take("media-a")).toHaveLength(1);
    expect(await buffer.take("media-a")).toHaveLength(1);
    expect(await buffer.take("missing")).toEqual([]);
  });

  test("removes one chunk and keeps the rest", async () => {
    const buffer = await openMediaBuffer(freshName());
    await buffer.put("media-a", 0, chunk("zero"));
    await buffer.put("media-a", 1, chunk("one"));
    await buffer.remove("media-a", 0);
    expect((await buffer.take("media-a")).map((item) => item.index)).toEqual([
      1,
    ]);
  });

  test("drops one media without touching another", async () => {
    const buffer = await openMediaBuffer(freshName());
    await buffer.put("media-a", 0, chunk("zero"));
    await buffer.put("media-a", 1, chunk("one"));
    await buffer.put("media-b", 0, chunk("other"));
    await buffer.drop("media-a");
    expect(await buffer.take("media-a")).toEqual([]);
    expect(await buffer.take("media-b")).toHaveLength(1);
  });

  test("remembers a media id per demonstration and kind", async () => {
    const name = freshName();
    const buffer = await openMediaBuffer(name);
    expect(await buffer.mediaFor("demo-1", "screen")).toBeUndefined();
    await buffer.remember("demo-1", "screen", "media-screen");
    await buffer.remember("demo-1", "audio", "media-audio");
    await buffer.remember("demo-2", "screen", "media-other");
    expect(await buffer.mediaFor("demo-1", "screen")).toBe("media-screen");
    expect(await buffer.mediaFor("demo-1", "audio")).toBe("media-audio");
    expect(await buffer.mediaFor("demo-2", "screen")).toBe("media-other");
    expect(await buffer.mediaFor("demo-2", "audio")).toBeUndefined();
    const reopened = await openMediaBuffer(name);
    expect(await reopened.mediaFor("demo-1", "audio")).toBe("media-audio");
  });
});

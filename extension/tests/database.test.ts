import "fake-indexeddb/auto";
import { describe, expect, test } from "bun:test";
import {
  deleteDemonstrationData,
  openRecorderDatabase,
  RECORDER_DATABASE,
  RECORDER_DATABASE_VERSION,
  requestToPromise,
  STORES,
  tx,
} from "../src/shared/database";

let counter = 0;
const freshName = () => `recorder-test-${Date.now()}-${counter++}`;

const keyPathOf = (db: IDBDatabase, store: string) =>
  db.transaction(store, "readonly").objectStore(store).keyPath;

describe("recorder database", () => {
  test("declares the default name and version 1", () => {
    expect(RECORDER_DATABASE).toBe("openbot-recorder");
    expect(RECORDER_DATABASE_VERSION).toBe(1);
  });

  test("creates exactly the six stores with the documented key paths", async () => {
    const db = await openRecorderDatabase(freshName());
    expect([...db.objectStoreNames].sort()).toEqual([...STORES].sort());
    expect(STORES.length).toBe(6);
    expect(keyPathOf(db, "events")).toEqual(["trajectoryId", "seq"]);
    expect(keyPathOf(db, "meta")).toBeNull();
    expect(keyPathOf(db, "media")).toEqual(["mediaId", "index"]);
    expect(keyPathOf(db, "voice")).toEqual(["demonstrationId", "index"]);
    expect(keyPathOf(db, "steps")).toEqual(["demonstrationId", "index"]);
    expect(keyPathOf(db, "bodies")).toEqual(["mediaId", "line"]);
    db.close();
  });

  test("opening twice upgrades once", async () => {
    const name = freshName();
    const first = await openRecorderDatabase(name);
    await tx(first, ["meta"], "readwrite", (t) =>
      requestToPromise(t.objectStore("meta").put("kept", "marker")),
    );
    const second = await openRecorderDatabase(name);
    expect(second.version).toBe(1);
    const value = await tx(second, ["meta"], "readonly", (t) =>
      requestToPromise(t.objectStore("meta").get("marker")),
    );
    expect(value).toBe("kept");
    first.close();
    second.close();
  });

  test("tx resolves the work's value and rejects when the work throws", async () => {
    const db = await openRecorderDatabase(freshName());
    const value = await tx(db, ["meta"], "readwrite", async (t) => {
      await requestToPromise(t.objectStore("meta").put(7, "n"));
      return requestToPromise(t.objectStore("meta").get("n"));
    });
    expect(value).toBe(7);
    await expect(
      tx(db, ["meta"], "readwrite", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    db.close();
  });

  test("deleteDemonstrationData removes one demonstration and leaves another", async () => {
    const db = await openRecorderDatabase(freshName());
    const seed = (id: string, mediaId: string, bodiesId: string) =>
      tx(db, [...STORES], "readwrite", (t) => {
        t.objectStore("steps").put({ demonstrationId: id, index: 0 });
        t.objectStore("steps").put({ demonstrationId: id, index: 1 });
        t.objectStore("voice").put({ demonstrationId: id, index: 0 });
        t.objectStore("media").put({
          mediaId,
          index: 0,
          blob: new Blob(["a"]),
        });
        t.objectStore("media").put({
          mediaId,
          index: 1,
          blob: new Blob(["b"]),
        });
        t.objectStore("bodies").put({ mediaId: bodiesId, line: 0, text: "x" });
        t.objectStore("meta").put(mediaId, `media:${id}:screen`);
        t.objectStore("meta").put(bodiesId, `media:${id}:network`);
        t.objectStore("meta").put(1, `bodies-next:${bodiesId}`);
      });
    await seed("d1", "m1", "b1");
    await seed("d2", "m2", "b2");

    await deleteDemonstrationData(db, "d1");

    const count = (store: StoreNameLike) =>
      tx(db, [store], "readonly", (t) =>
        requestToPromise(t.objectStore(store).count()),
      );
    expect(await count("steps")).toBe(2);
    expect(await count("voice")).toBe(1);
    expect(await count("media")).toBe(2);
    expect(await count("bodies")).toBe(1);
    const keys = await tx(db, ["meta"], "readonly", (t) =>
      requestToPromise(t.objectStore("meta").getAllKeys()),
    );
    expect(keys.sort()).toEqual([
      "bodies-next:b2",
      "media:d2:network",
      "media:d2:screen",
    ]);
    const left = await tx(db, ["media"], "readonly", (t) =>
      requestToPromise(t.objectStore("media").getAll()),
    );
    expect(left.every((r) => r.mediaId === "m2")).toBe(true);
    db.close();
  });
});

type StoreNameLike = (typeof STORES)[number];

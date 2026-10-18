import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from "fake-indexeddb";
import {
  openRecorderDatabase,
  RECORDER_DATABASE,
  RECORDER_DATABASE_VERSION,
  requestToPromise,
  STORES,
  tx,
} from "../src/shared/database";

// Installed per test rather than by "fake-indexeddb/auto": that import sets the globals once at module
// load, and another file's teardown in the same `bun test` process can delete them afterwards.
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
const freshName = () => `recorder-test-${Date.now()}-${counter++}`;

const keyPathOf = (db: IDBDatabase, store: string) =>
  db.transaction(store, "readonly").objectStore(store).keyPath;

describe("recorder database", () => {
  test("declares the default name and version 1", () => {
    expect(RECORDER_DATABASE).toBe("openbot-recorder");
    expect(RECORDER_DATABASE_VERSION).toBe(1);
  });

  test("creates exactly the outbox's two stores with the documented key paths", async () => {
    const db = await openRecorderDatabase(freshName());
    expect([...db.objectStoreNames].sort()).toEqual(["events", "meta"]);
    expect([...STORES].sort()).toEqual(["events", "meta"]);
    expect(keyPathOf(db, "events")).toEqual(["trajectoryId", "seq"]);
    expect(keyPathOf(db, "meta")).toBeNull();
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

  test("tx waits for work that awaits something other than IndexedDB", async () => {
    const db = await openRecorderDatabase(freshName());
    const value = await tx(db, ["meta"], "readwrite", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "v";
    });
    expect(value).toBe("v");
    db.close();
  });

  test("tx rejects when work touches the transaction after it has finished", async () => {
    const db = await openRecorderDatabase(freshName());
    await expect(
      tx(db, ["meta"], "readwrite", async (t) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        t.objectStore("meta").put("late", "k");
      }),
    ).rejects.toThrow();
    const stored = await tx(db, ["meta"], "readonly", (t) =>
      requestToPromise(t.objectStore("meta").get("k")),
    );
    expect(stored).toBeUndefined();
    db.close();
  });

  test("tx rejects with the failing request's error when work does not await it", async () => {
    const db = await openRecorderDatabase(freshName());
    await tx(db, ["events"], "readwrite", (t) =>
      requestToPromise(
        t.objectStore("events").add({ trajectoryId: "t", seq: 0 }),
      ),
    );
    const error = await tx(db, ["events"], "readwrite", (t) => {
      t.objectStore("events").add({ trajectoryId: "t", seq: 0 });
      return "ok";
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((error as Error | undefined)?.name).toBe("ConstraintError");
    db.close();
  });

  test("tx resolves when the caller handled a request error", async () => {
    const db = await openRecorderDatabase(freshName());
    await tx(db, ["events"], "readwrite", (t) => {
      t.objectStore("events").add({ trajectoryId: "t", seq: 0 });
    });
    await tx(db, ["events"], "readwrite", (t) => {
      const duplicate = t
        .objectStore("events")
        .add({ trajectoryId: "t", seq: 0 });
      duplicate.onerror = (e) => e.preventDefault();
      t.objectStore("events").put({ trajectoryId: "t", seq: 1 });
    });
    const count = await tx(db, ["events"], "readonly", (t) =>
      requestToPromise(t.objectStore("events").count()),
    );
    expect(count).toBe(2);
    db.close();
  });
});

import { describe, expect, test } from "bun:test";
import type { SnapshotElement } from "../src/computer/schema";
import {
  createInMemorySnapshotStore,
  type StoredSnapshot,
} from "../src/computer/snapshot-store";

/**
 * The in-memory store's own behaviour, without a database.
 *
 * The database-backed store has to agree with this one within a single process; the difference
 * between them only shows with a second process, which is what the integration test is for. Here the
 * contract is the plain one: what was saved is what loads, the newest snapshot per computer wins, and
 * an unsnapshotted computer resolves to nothing rather than to a stale row.
 */

function snapshot(
  snapshotId: number,
  elements: SnapshotElement[],
  url = "https://example.com/order",
): StoredSnapshot {
  return {
    snapshotId,
    url,
    elements: new Map(elements.map((element) => [element.ref, element])),
  };
}

describe("the in-memory snapshot store", () => {
  test("loads back the snapshot it saved, elements and all", async () => {
    const store = createInMemorySnapshotStore();
    await store.save(
      "default",
      snapshot(7, [
        { ref: "e1", role: "input", name: "Customer name:", type: "text" },
        { ref: "e9", role: "button", name: "Submit order" },
      ]),
    );

    const loaded = await store.load("default");
    expect(loaded?.snapshotId).toBe(7);
    expect(loaded?.url).toBe("https://example.com/order");
    expect(loaded?.elements.get("e9")?.name).toBe("Submit order");
    expect(loaded?.elements.get("e1")?.type).toBe("text");
  });

  test("a computer that was never snapshotted loads as undefined", async () => {
    const store = createInMemorySnapshotStore();
    expect(await store.load("default")).toBeUndefined();
  });

  test("the newest snapshot replaces the last, so a ref resolves against the current page", async () => {
    const store = createInMemorySnapshotStore();
    await store.save(
      "default",
      snapshot(7, [{ ref: "e9", role: "button", name: "Submit order" }]),
    );
    await store.save(
      "default",
      snapshot(8, [{ ref: "e9", role: "button", name: "Cancel" }]),
    );

    const loaded = await store.load("default");
    // The generation moves forward and the same ref now names a different control. Keeping the older
    // snapshot would be exactly the stale mapping the gateway must never resolve against.
    expect(loaded?.snapshotId).toBe(8);
    expect(loaded?.elements.get("e9")?.name).toBe("Cancel");
  });

  test("clearing forgets the snapshot, so nothing resolves against a wiped computer", async () => {
    const store = createInMemorySnapshotStore();
    await store.save(
      "default",
      snapshot(7, [{ ref: "e9", role: "button", name: "Submit order" }]),
    );

    await store.clear("default");

    // A wiped computer starts counting generations from one again, so a row left behind would let a
    // ref from the previous session match the new one and resolve to a page that is gone.
    expect(await store.load("default")).toBeUndefined();
  });

  test("clearing one computer leaves the others alone", async () => {
    const store = createInMemorySnapshotStore();
    await store.save(
      "sales-bot",
      snapshot(3, [{ ref: "e1", role: "button", name: "Send" }]),
    );
    await store.save(
      "research-bot",
      snapshot(4, [{ ref: "e1", role: "link", name: "Open" }]),
    );

    await store.clear("sales-bot");

    expect(await store.load("sales-bot")).toBeUndefined();
    expect((await store.load("research-bot"))?.elements.get("e1")?.name).toBe(
      "Open",
    );
  });

  test("each computer keeps its own snapshot", async () => {
    const store = createInMemorySnapshotStore();
    await store.save(
      "sales-bot",
      snapshot(3, [{ ref: "e1", role: "button", name: "Send" }]),
    );
    await store.save(
      "research-bot",
      snapshot(4, [{ ref: "e1", role: "link", name: "Open" }]),
    );

    expect((await store.load("sales-bot"))?.elements.get("e1")?.name).toBe(
      "Send",
    );
    expect((await store.load("research-bot"))?.elements.get("e1")?.name).toBe(
      "Open",
    );
  });
});

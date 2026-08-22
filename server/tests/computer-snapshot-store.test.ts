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

  test("an older snapshot arriving late does not overwrite the newer one", async () => {
    // The property #46 established, asked of this store rather than of the table. A test that reaches
    // for the in-memory store because it has no database must not be told a different story about
    // when a save wins: two snapshots of one computer can complete out of order here too, and the
    // generation is what decides between them in both implementations.
    const store = createInMemorySnapshotStore();
    await store.save(
      "default",
      snapshot(8, [{ ref: "e9", role: "button", name: "Cancel" }]),
    );

    await store.save(
      "default",
      snapshot(7, [{ ref: "e9", role: "button", name: "Submit order" }]),
    );

    // A save of the generation already held loses too, the way `setWhere`'s `lt` refuses it: the
    // stored snapshot is the one that generation named, and a second delivery of it carries nothing
    // newer to say.
    await store.save(
      "default",
      snapshot(8, [{ ref: "e9", role: "button", name: "Submit order" }]),
    );

    const loaded = await store.load("default");
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

describe("a computer that has been replaced", () => {
  /*
   * The generation only orders snapshots within one run of the computer.
   *
   * A replaced container counts from one again, so its first snapshots look older than the row the
   * dead one left behind and none of them land. The row then describes a page nobody is on, and the
   * generation that finally matches resolves refs against it: the policy decides on an element from
   * a page that no longer exists, and the audit row names it.
   *
   * `resetComputer` clears the row for exactly this reason and is the only thing that does. The
   * supervisor replacing a computer whose image has changed does not, and the server is never told,
   * so the row outlives the session that wrote it.
   */
  test("its first snapshot replaces the dead one, however low the generation", async () => {
    const store = createInMemorySnapshotStore();
    await store.save("bot", {
      snapshotId: 7,
      url: "https://bank.example/transfer",
      elements: new Map([
        ["e9", { ref: "e9", role: "button", name: "Confirm transfer" }],
      ]),
      session: "2026-08-22T10:00:00Z",
    });

    await store.save("bot", {
      snapshotId: 1,
      url: "https://docs.example/index",
      elements: new Map([
        ["e9", { ref: "e9", role: "link", name: "Table of contents" }],
      ]),
      session: "2026-08-22T11:00:00Z",
    });

    const held = await store.load("bot");
    expect(held?.snapshotId).toBe(1);
    expect(held?.url).toBe("https://docs.example/index");
    expect(held?.session).toBe("2026-08-22T11:00:00Z");
  });

  test("within one session the generation still only goes forward", async () => {
    // The guard the replacement case must not undo: two replicas snapshotting at once, where the
    // older write must not overwrite the newer one.
    const store = createInMemorySnapshotStore();
    const session = "2026-08-22T10:00:00Z";
    await store.save("bot", {
      snapshotId: 7,
      url: "https://example.com/new",
      elements: new Map(),
      session,
    });
    await store.save("bot", {
      snapshotId: 5,
      url: "https://example.com/old",
      elements: new Map(),
      session,
    });

    expect((await store.load("bot"))?.url).toBe("https://example.com/new");
  });

  test("a provider that reports no session behaves as it did", async () => {
    // One shared computer and no supervisor: nothing to compare, so the generation rule stands
    // alone rather than every save counting as a new session and overwriting the last.
    const store = createInMemorySnapshotStore();
    await store.save("bot", {
      snapshotId: 7,
      url: "https://example.com/new",
      elements: new Map(),
    });
    await store.save("bot", {
      snapshotId: 5,
      url: "https://example.com/old",
      elements: new Map(),
    });

    expect((await store.load("bot"))?.url).toBe("https://example.com/new");
  });
});

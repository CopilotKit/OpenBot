import { afterEach, describe, expect, test } from "bun:test";
import type { SnapshotElement } from "../src/computer/schema";
import {
  createSnapshotStore,
  type StoredSnapshot,
} from "../src/computer/snapshot-store";
import { createDatabase } from "../src/db/client";
import { computerSnapshot } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * The snapshot a ref resolves against has to cross to another server.
 *
 * The gateway turns the opaque ref in a click into the element it points at by looking it up in the
 * snapshot this deployment took. OpenBot runs several processes behind a load balancer, and the one
 * that takes the snapshot is rarely the one that answers the click, so that mapping cannot live in a
 * `Map` in a process: on every other replica it would be empty, the policy would decide with no
 * element, and the boundary would be silently off. The row is the contract that carries the mapping
 * from the server that snapshotted to the server that acts.
 *
 * Another replica is simulated by building a second store on the same database, the way the policy
 * durability test simulates a restart. Reading back through the same store would only prove it
 * remembers what it was told a moment ago, which is not the property in question.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

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

afterEach(async () => {
  await database.delete(computerSnapshot);
});

describe("a snapshot taken on one server", () => {
  test("is resolvable on another, elements and generation intact", async () => {
    const tookSnapshot = createSnapshotStore(database);
    await tookSnapshot.save(
      "default",
      snapshot(7, [
        { ref: "e1", role: "input", name: "Customer name:", type: "text" },
        { ref: "e9", role: "button", name: "Submit order" },
      ]),
    );

    // A different process would hold none of that in memory. The second store reads it from Postgres.
    const handlesClick = createSnapshotStore(database);
    const loaded = await handlesClick.load("default");
    expect(loaded?.snapshotId).toBe(7);
    expect(loaded?.url).toBe("https://example.com/order");
    expect(loaded?.elements.get("e9")?.name).toBe("Submit order");
    // The type survives the JSON round trip, because a rule may care that a value went into a
    // password field rather than a text one.
    expect(loaded?.elements.get("e1")?.type).toBe("text");
  });

  test("a computer that was never snapshotted loads as undefined", async () => {
    const store = createSnapshotStore(database);
    expect(await store.load("never-snapshotted")).toBeUndefined();
  });

  test("a newer snapshot supersedes the last, keeping one row per computer", async () => {
    const first = createSnapshotStore(database);
    await first.save(
      "default",
      snapshot(7, [{ ref: "e9", role: "button", name: "Submit order" }]),
    );

    const second = createSnapshotStore(database);
    await second.save(
      "default",
      snapshot(8, [{ ref: "e9", role: "button", name: "Cancel" }]),
    );

    const rows = await database.select().from(computerSnapshot);
    // One live snapshot per computer, by construction: a ref is only ever resolved against the current
    // page, so a second row would be a page history the boundary has no use for.
    expect(rows).toHaveLength(1);

    const loaded = await createSnapshotStore(database).load("default");
    expect(loaded?.snapshotId).toBe(8);
    expect(loaded?.elements.get("e9")?.name).toBe("Cancel");
  });

  test("an older snapshot arriving late does not overwrite the newer one", async () => {
    // Two replicas snapshotting the same computer at once. Generation 8 is written first and
    // generation 7 arrives after it, which is the ordering a load balancer can produce and Postgres
    // has no way to prevent. Last-write-wins would put the older page back and every ref the model is
    // holding would stop resolving; the generation decides instead, because it comes from the
    // computer rather than from two machines' clocks.
    const ahead = createSnapshotStore(database);
    await ahead.save(
      "default",
      snapshot(8, [{ ref: "e9", role: "button", name: "Cancel" }]),
    );

    const behind = createSnapshotStore(database);
    await behind.save(
      "default",
      snapshot(7, [{ ref: "e9", role: "button", name: "Submit order" }]),
    );

    const loaded = await createSnapshotStore(database).load("default");
    expect(loaded?.snapshotId).toBe(8);
    expect(loaded?.elements.get("e9")?.name).toBe("Cancel");
  });

  test("clearing removes the row, so a wiped computer resolves nothing", async () => {
    const store = createSnapshotStore(database);
    await store.save(
      "default",
      snapshot(7, [{ ref: "e9", role: "button", name: "Submit order" }]),
    );

    await store.clear("default");

    expect(await database.select().from(computerSnapshot)).toHaveLength(0);
    expect(await createSnapshotStore(database).load("default")).toBeUndefined();
  });

  test("two computers keep their snapshots apart", async () => {
    const store = createSnapshotStore(database);
    await store.save(
      "sales-bot",
      snapshot(3, [{ ref: "e1", role: "button", name: "Send" }]),
    );
    await store.save(
      "research-bot",
      snapshot(4, [{ ref: "e1", role: "link", name: "Open" }]),
    );

    const other = createSnapshotStore(database);
    expect((await other.load("sales-bot"))?.elements.get("e1")?.name).toBe(
      "Send",
    );
    expect((await other.load("research-bot"))?.elements.get("e1")?.name).toBe(
      "Open",
    );
  });
});

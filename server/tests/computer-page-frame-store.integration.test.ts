import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createPageFrameStore } from "../src/computer/page-frames";
import { createDatabase } from "../src/db/client";
import { computerPageFrame } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * A conversation is a record, and a record must not change its mind.
 *
 * The transcript used to fetch the live screen for every past turn, so an answer about one page sat
 * under a picture of whichever page the Bot had open by the time somebody read it back. The frame is
 * kept per computer and page, written where the navigation happens.
 *
 * Driven against the database rather than a fake, because the two properties under test are both the
 * database's: which rows collide, and which one wins when they do.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const store = createPageFrameStore(database);
const computers: string[] = [];

function computerId(): string {
  const id = `frame-probe-${crypto.randomUUID().slice(0, 8)}`;
  computers.push(id);
  return id;
}

afterEach(async () => {
  for (const id of computers.splice(0)) {
    await database
      .delete(computerPageFrame)
      .where(eq(computerPageFrame.computerId, id));
  }
});

describe("kept page frames", () => {
  test("a page is read back with the frame it was opened on", async () => {
    const id = computerId();
    await store.save({
      computerId: id,
      url: "https://example.com/one",
      title: "One",
      frame: "AAAA",
    });

    const stored = await store.load(id, "https://example.com/one");
    expect(stored?.frame).toBe("AAAA");
    expect(stored?.title).toBe("One");
  });

  test("a page nobody opened has no frame", async () => {
    expect(await store.load(computerId(), "https://example.com/never")).toBe(
      null,
    );
  });

  /*
   * The whole point of keying on the page. Two turns that opened different addresses must not be able
   * to overwrite each other, or the transcript is back to showing one picture for every turn.
   */
  test("two pages on one computer keep their own frames", async () => {
    const id = computerId();
    await store.save({ computerId: id, url: "https://a.example", frame: "A" });
    await store.save({ computerId: id, url: "https://b.example", frame: "B" });

    expect((await store.load(id, "https://a.example"))?.frame).toBe("A");
    expect((await store.load(id, "https://b.example"))?.frame).toBe("B");
  });

  /*
   * A page visited twice is the same address showing something different, and the more recent visit
   * is the one a reader is most likely asking about.
   */
  test("visiting a page again replaces its frame", async () => {
    const id = computerId();
    await store.save({
      computerId: id,
      url: "https://news.example",
      title: "Before",
      frame: "OLD",
    });
    await store.save({
      computerId: id,
      url: "https://news.example",
      title: "After",
      frame: "NEW",
    });

    const stored = await store.load(id, "https://news.example");
    expect(stored?.frame).toBe("NEW");
    expect(stored?.title).toBe("After");
  });

  /*
   * The computer is part of the key, not decoration. A caller who may reach one Bot must not be able
   * to read another Bot's screen by naming a page both of them opened.
   */
  test("one computer cannot read another computer's frame", async () => {
    const mine = computerId();
    const theirs = computerId();
    await store.save({
      computerId: theirs,
      url: "https://payroll.example",
      frame: "SECRET",
    });

    expect(await store.load(mine, "https://payroll.example")).toBe(null);
  });

  /*
   * Refused rather than truncated. Half a PNG is not a smaller picture, it is a broken one, and the
   * turn falls back to naming the page it opened.
   */
  test("a frame too large to be a screenshot is not kept", async () => {
    const id = computerId();
    await store.save({
      computerId: id,
      url: "https://huge.example",
      frame: "x".repeat(4 * 1024 * 1024 + 1),
    });

    expect(await store.load(id, "https://huge.example")).toBe(null);
  });

  test("a frame with no page to file it under is not kept", async () => {
    const id = computerId();
    await store.save({ computerId: id, url: "", frame: "AAAA" });

    expect(await store.load(id, "")).toBe(null);
  });
});

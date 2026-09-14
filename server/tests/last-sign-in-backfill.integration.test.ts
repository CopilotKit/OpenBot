import { describe, expect, test } from "bun:test";
import { inArray, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The migration that gives an existing deployment its answer, run against a real database.
 *
 * `stampSignIn` only records sign-ins that happen after the upgrade, so on every machine that
 * already has OpenBot the column starts empty and the People screen would say nobody had ever
 * signed in until each of them came back. The backfill is what prevents that, it runs exactly once
 * per deployment, and nothing else in the suite executes it.
 *
 * It is found through `_journal.json` rather than by filename, because the number in front of a
 * migration is not stable: this one was renumbered when it was rebased onto a chain that had moved
 * on. A test naming `0035` would have kept passing against a copy of the file while the deployment
 * ran a different one, and a migration left out of the journal is one that never runs at all. So
 * the journal entry is the thing asserted, and the SQL is read from whatever file it names.
 */
const JOURNAL = (await Bun.file(
  new URL("../drizzle/meta/_journal.json", import.meta.url),
).json()) as { entries: { idx: number; tag: string }[] };

const entry = JOURNAL.entries.find((candidate) =>
  candidate.tag.endsWith("_backfill_last_signed_in_at"),
);

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const PREFIX = "backfill-test-";
const NEWEST = new Date("2026-09-05T09:00:00.000Z");
const OLDER = new Date("2026-09-01T09:00:00.000Z");
const ALREADY = new Date("2026-09-09T09:00:00.000Z");

/** Thrown to unwind the transaction, so the backfill never touches the rows of the database it ran against. */
class Rollback extends Error {}

describe("the backfill migration", () => {
  test("is registered in the journal, so it runs", () => {
    expect(entry).toBeDefined();
  });

  test("fills an empty answer from the sessions still there, and leaves one that exists alone", async () => {
    const migration = await Bun.file(
      new URL(`../drizzle/${entry?.tag}.sql`, import.meta.url),
    ).text();

    const blank = `${PREFIX}blank`;
    const answered = `${PREFIX}answered`;
    const neverHere = `${PREFIX}never-here`;
    const observed = new Map<string, Date | null>();

    try {
      await database.transaction(async (tx) => {
        for (const [id, stamp] of [
          [blank, null],
          [answered, ALREADY],
          [neverHere, null],
        ] as const) {
          await tx.insert(users).values({
            id,
            email: `${id}@openbot.test`,
            name: id,
            emailVerified: true,
            lastSignedInAt: stamp,
          });
        }

        // Two sessions on the person with no answer: the backfill takes the newer.
        for (const [suffix, at] of [
          ["newest", NEWEST],
          ["older", OLDER],
        ] as const) {
          await tx.insert(sessions).values({
            id: `${blank}-${suffix}`,
            userId: blank,
            token: `${blank}-${suffix}-token`,
            expiresAt: new Date(Date.now() + 86_400_000),
            createdAt: at,
          });
        }

        // One older session on the person who already has an answer: it must not move backwards.
        await tx.insert(sessions).values({
          id: `${answered}-session`,
          userId: answered,
          token: `${answered}-token`,
          expiresAt: new Date(Date.now() + 86_400_000),
          createdAt: OLDER,
        });

        for (const statement of migration.split("--> statement-breakpoint")) {
          if (statement.trim()) await tx.execute(sql.raw(statement));
        }

        const rows = await tx
          .select({ id: users.id, lastSignedInAt: users.lastSignedInAt })
          .from(users)
          .where(inArray(users.id, [blank, answered, neverHere]));
        for (const row of rows) observed.set(row.id, row.lastSignedInAt);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }

    expect(observed.get(blank)).toEqual(NEWEST);
    expect(observed.get(answered)).toEqual(ALREADY);
    // Nothing to backfill from is the case the pull request says it cannot fix, said out loud here.
    expect(observed.get(neverHere)).toBeNull();
  });
});

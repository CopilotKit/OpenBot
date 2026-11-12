import { afterAll, describe, expect, test } from "bun:test";
import { inArray, sql } from "drizzle-orm";
import {
  SKIN_IDS,
  type UserPreferences,
} from "@openbot/shared/user-preferences";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The migration that keeps each person's skin when a skin's id changes, run against a real
 * database.
 *
 * The server answers a saved skin id it no longer ships with the default, so without this file
 * everyone who picked the renamed skin would silently be dropped back to OpenBot's own look.
 *
 * Found through `_journal.json` rather than by filename, for `last-sign-in-backfill`'s reason: the
 * number in front of a migration is not stable across a rebase, and a migration left out of the
 * journal never runs at all.
 */
const JOURNAL = (await Bun.file(
  new URL("../drizzle/meta/_journal.json", import.meta.url),
).json()) as { entries: { idx: number; tag: string }[] };

const entry = JOURNAL.entries.find((candidate) =>
  candidate.tag.endsWith("_carry_retired_skin"),
);

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const PREFIX = "skin-carry-";

/** Thrown to unwind the transaction, so the migration never touches the rows of the database it ran against. */
class Rollback extends Error {}

afterAll(async () => {
  await database.$client.close();
});

describe("the carry-retired-skin migration", () => {
  test("is registered in the journal, so it runs", () => {
    expect(entry).toBeDefined();
  });

  test("names every skin this build ships, so none of them is moved", async () => {
    const migration = await Bun.file(
      new URL(`../drizzle/${entry?.tag}.sql`, import.meta.url),
    ).text();
    for (const id of SKIN_IDS) expect(migration).toContain(`'${id}'`);
  });

  test("moves a skin this build does not ship to openfuse and leaves everything else", async () => {
    const migration = await Bun.file(
      new URL(`../drizzle/${entry?.tag}.sql`, import.meta.url),
    ).text();

    const rows: { id: string; preferences: Record<string, unknown> }[] = [
      {
        id: `${PREFIX}retired`,
        preferences: { skin: "retired-skin", narration: "on" },
      },
      { id: `${PREFIX}none`, preferences: { narration: "off" } },
      ...SKIN_IDS.map((skin) => ({
        id: `${PREFIX}${skin}`,
        preferences: { skin },
      })),
    ];
    const observed = new Map<string, unknown>();

    try {
      await database.transaction(async (tx) => {
        for (const row of rows) {
          await tx.insert(users).values({
            id: row.id,
            email: `${row.id}@example.com`,
            // A retired id is exactly what the type no longer allows, so it is written as stored data.
            preferences: row.preferences as Partial<UserPreferences>,
          });
        }

        for (const statement of migration.split("--> statement-breakpoint")) {
          if (statement.trim()) await tx.execute(sql.raw(statement));
        }

        const after = await tx
          .select({ id: users.id, preferences: users.preferences })
          .from(users)
          .where(
            inArray(
              users.id,
              rows.map((row) => row.id),
            ),
          );
        for (const row of after) observed.set(row.id, row.preferences);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }

    expect(Object.fromEntries(observed)).toEqual({
      [`${PREFIX}retired`]: { skin: "openfuse", narration: "on" },
      [`${PREFIX}none`]: { narration: "off" },
      ...Object.fromEntries(
        SKIN_IDS.map((skin) => [`${PREFIX}${skin}`, { skin }]),
      ),
    });
  });
});

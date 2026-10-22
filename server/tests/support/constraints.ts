// server/tests/support/constraints.ts
//
// What a CHECK constraint ACTUALLY says in the database the tests are pointed at.
//
// A test that inserts a junk value and reads back the name of the constraint that refused it says
// two things: the constraint exists, and it refuses that one value. It says nothing about the
// roster, so widening one — `IN ('composio', 'arcade')` grown a third member nobody reviewed —
// leaves every such test green. That is a real failure mode and not a hypothetical: it is what a
// mutation of `0057_arcade_provider.sql` did, with the schema guards all passing.
//
// So ask postgres for the predicate itself. `pg_get_constraintdef` renders what the server stores,
// whatever spelling the migration used to write it, which also means the comparison survives
// `IN (...)` being recorded as `= ANY (ARRAY[...])`.
import { sql } from "drizzle-orm";
import type { createDatabase } from "../../src/db/client";

type Database = ReturnType<typeof createDatabase>;

/**
 * The string literals a CHECK constraint names, sorted, so a test can pin the roster exactly.
 *
 * Throws when no CHECK of that name exists, because a renamed or missing constraint is the louder
 * half of the same mistake and must not read as an empty roster that an `toEqual([])` could match.
 */
export const checkRoster = async (
  database: Database,
  constraint: string,
): Promise<string[]> => {
  const rows = await database.execute(sql`
    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conname = ${constraint} AND contype = 'c'
  `);
  const definition = rows[0]?.definition as string | undefined;
  if (!definition) {
    throw new Error(
      `no CHECK constraint named "${constraint}" in this database; it was renamed, dropped, or its migration never ran`,
    );
  }
  return [...definition.matchAll(/'((?:[^']|'')*)'/g)]
    .map((match) => match[1]!.replace(/''/g, "'"))
    .sort();
};

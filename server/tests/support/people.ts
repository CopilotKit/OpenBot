// server/tests/support/people.ts
//
// `users` rows for the ids a test is about.
//
// Several tables name `users.id` and carry the foreign key that says so, and `pending_authorizations`
// is now one of them — both `actor_id` and `user_id` cascade from it. A test that invented an actor
// id and inserted an attempt under it was relying on a column that named a table and did not hold
// anybody to it; once the key exists, the row the test is actually about cannot be written until the
// person it names exists. That is the constraint doing its job, not the test being awkward, so the
// seeding lives in one place rather than being spelled eight different ways across the arcade files.
import { sql } from "drizzle-orm";
// `../../src`, not `../src`: this file is one level deeper than the test files it serves. The
// sibling `constraints.ts` has the shallow spelling, which resolves to nothing and silently leaves
// its `Database` as `any` — it is in `typecheck-baseline.txt` as debt, and not a spelling to copy.
import type { createDatabase } from "../../src/db/client";

type Database = ReturnType<typeof createDatabase>;

/**
 * Make sure a `users` row exists for each id, inventing the rest of the person.
 *
 * Idempotent on the id, because a suite that seeds the same actor in `beforeAll` and again inside a
 * case should not fail on the second call — and because `email` is unique, so the email is derived
 * from the id rather than from a counter that two files would collide on.
 *
 * Does NOT clean up after itself: the caller owns the lifetime, and the cascade this exists for
 * means deleting the person is also how a caller deletes everything hanging off them.
 */
export const seedPeople = async (
  database: Database,
  ids: readonly string[],
): Promise<void> => {
  const unique = [...new Set(ids)].filter((id) => id.length > 0);
  if (unique.length === 0) return;
  for (const id of unique) {
    await database.execute(sql`
      INSERT INTO users (id, email, name, email_verified)
      VALUES (${id}, ${`${id}@example.invalid`}, ${id}, true)
      ON CONFLICT (id) DO NOTHING
    `);
  }
};

/** One person, for the common case where a test names exactly one. */
export const seedPerson = async (
  database: Database,
  id: string,
): Promise<void> => seedPeople(database, [id]);

/** Remove the people a test seeded, taking everything keyed to them with it. */
export const removePeople = async (
  database: Database,
  ids: readonly string[],
): Promise<void> => {
  const unique = [...new Set(ids)].filter((id) => id.length > 0);
  if (unique.length === 0) return;
  for (const id of unique) {
    await database.execute(sql`DELETE FROM users WHERE id = ${id}`);
  }
};

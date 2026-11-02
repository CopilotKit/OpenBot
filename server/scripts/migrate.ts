/**
 * Apply the migrations, using only what a running deployment already has.
 *
 * NOT `drizzle-kit migrate`, and that is the whole point of this file. The CLI is a development
 * dependency: it reads `drizzle.config.ts`, which means compiling TypeScript, which means the esbuild
 * that `bun install --production` correctly leaves out of a runtime image. Asked to migrate there it
 * prints "Reading config file", exits 1, and says nothing at all, so a deployment looks like it
 * migrated and comes up against an empty database complaining that `users` does not exist.
 *
 * The migrator underneath it is part of `drizzle-orm`, which is a runtime dependency because the
 * server imports it anyway. It needs a connection and the folder of SQL files, both of which are in
 * the image, and it keeps its journal where `MIGRATIONS_JOURNAL` in `src/db/apply-migrations` says.
 * That is drizzle's default table, the one the CLI uses when `drizzle.config.ts` names none, so a
 * database migrated by the CLI before this script existed is read here without translation, and
 * the two were interchangeable — for exactly as long as those two names stay in step.
 *
 * It is now what every path runs — the image, the Helm Job, the compose stack, CI, and `db:migrate`
 * — because the two stopped being interchangeable in the direction that matters: only this one
 * refuses a database holding a stamp newer than a migration it is about to walk past. See
 * `src/db/migration-reach`.
 */
import { join } from "node:path";
import postgres, { type Sql } from "postgres";
import { applyMigrations } from "../src/db/apply-migrations";

/**
 * The whole run against one connection, and the connection released afterwards.
 *
 * Exported, and the work injectable, so that what happens when the release itself fails can be
 * tested without a database that refuses to close. `tests/migrate-teardown.test.ts`.
 */
export async function runMigrations(
  client: Sql,
  migrationsFolder: string,
  apply: typeof applyMigrations = applyMigrations,
): Promise<void> {
  try {
    /*
     * Guarded, because the migrator's own idea of "applied" is one number.
     *
     * It runs a migration when the journal stamps it later than the newest stamp the database holds,
     * and it has nothing to say about a migration stamped earlier that it has never run. See
     * `src/db/migration-reach`: a database that ran a branch's migrations before that branch was
     * merged and renumbered holds a stamp newer than the migrations the merge brought in, and the
     * unguarded migrator walks past them and prints the line below anyway.
     */
    await apply(client, migrationsFolder);
    console.info(JSON.stringify({ type: "migrations-applied", status: "ok" }));
  } catch (failure) {
    /*
     * Released whatever happened, so a failure exits rather than hanging on an open socket — but
     * NOT with an awaited `end()` in a `finally`. A rejection there replaces the error in flight,
     * and the error in flight is the one this script exists to deliver: the refusal naming the
     * migrations a database walked past would leave as a bare socket error. The release's own
     * failure is reported beside it, and the run's failure is the one that propagates.
     */
    await client.end({ timeout: 5 }).catch((teardown: unknown) => {
      console.error(
        JSON.stringify({
          type: "migrations-connection-release-failed",
          error:
            teardown instanceof Error ? teardown.message : String(teardown),
        }),
      );
    });
    throw failure;
  }
  // After a clean run a failed release has nothing to hide, so it is the run's outcome.
  await client.end({ timeout: 5 });
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL must be configured before running a database migration command",
    );
  }

  /*
   * One connection, and `max: 1`.
   *
   * Migrations are a single ordered conversation with the database, and a pool would let two
   * statements that must be ordered land on different connections.
   */
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  await runMigrations(client, join(import.meta.dir, "..", "drizzle"));
}

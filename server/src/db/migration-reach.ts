/**
 * Whether every migration in the folder can still be reached by the migrator, on THIS database.
 *
 * WHAT THE MIGRATOR ACTUALLY DOES. `PgDialect.migrate` reads one row of its journal table (see
 * `MigrationsJournal`) — `order by created_at desc limit 1` — and then runs a migration
 * if, and only if, its journal `when` is greater than `Number(created_at)` of that row. That row is
 * not always the newest stamp: Postgres sorts NULLs FIRST in a descending order, so a single row
 * with a NULL `created_at` is the row it reads, and `Number(null)` is 0. See `migratorHighWaterMark`. It never looks at hashes, never looks at tags, and never notices that a
 * migration it walked past was one it has never run. A migration whose `when` is at or below the
 * high-water mark is therefore not "pending": it is unreachable, forever, and the migrator will
 * report success without it.
 *
 * WHY THAT IS NOT HYPOTHETICAL. A branch that ships migrations and is then merged with `main` has
 * its own migrations renumbered and restamped to sit after main's. Every database that ran the
 * branch BEFORE the merge has already recorded the branch's old, higher stamp. Main's migrations
 * now carry a `when` older than that mark, so they are skipped — silently — while the renumbered
 * branch migrations, stamped later still, run perfectly. The database ends up missing tables that
 * the migrator just said it had applied. A fresh database is unaffected, which is exactly why CI,
 * which always migrates from empty, cannot see it.
 *
 * WHY THIS REFUSES RATHER THAN REPAIRS. Running the unreachable SQL and backfilling its row is a
 * two-line change and the wrong one. The migrations that are out of reach are out of reach because
 * some OTHER journal already ran against this database, and nothing here knows what that journal
 * did — whether its statements created the same objects under other names, left half a schema
 * behind, or were the hand-repair of an earlier failure. The honest answer to "this database cannot
 * be brought up to date by running the folder forward" is to say so, loudly, with the names in
 * hand, and to stop. An operator can then drop a disposable database, or repair a durable one
 * deliberately. What must never happen again is `{"type":"migrations-applied","status":"ok"}` over
 * tables that do not exist.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** One migration in the folder, as the migrator reads it. */
export type FolderMigration = {
  tag: string;
  /** The journal's `when`: the only thing the migrator compares. */
  when: number;
  /**
   * sha256 of the whole `.sql` file, hex.
   *
   * Computed exactly as `drizzle-orm/migrator`'s `readMigrationFiles` computes it — the whole file
   * as read, before any statement splitting — because this is matched against the hashes that the
   * migrator itself wrote into its journal table. A different recipe here would make
   * every applied migration look unapplied.
   */
  hash: string;
};

/**
 * One row of the migrator's journal table (see `MigrationsJournal`).
 *
 * `createdAt` is nullable because the column is: drizzle creates it as a bare `bigint`, and a NULL
 * there is not noise to be defaulted away — it is the row the migrator compares against. A reader
 * that turns NULL into a number before it gets here hides exactly the case that matters.
 */
export type AppliedMigration = { hash: string; createdAt: number | null };

/**
 * Where the migrator keeps its bookkeeping: the table it reads its high-water mark from and records
 * each applied migration in.
 *
 * The SHAPE lives here, in the module with no database in it, and the VALUE does not:
 * `MIGRATIONS_JOURNAL` in `./apply-migrations` is the one place the name is chosen, and it is handed
 * to everything that needs it — the reach check's read, `migrate()`, and `outOfReachRefusal`'s repair
 * instructions. The value cannot move here without this module deciding deployment configuration,
 * and it cannot be imported from there without a cycle (`./apply-migrations` imports this module),
 * so it is passed in. Nothing in this file may spell the table's name.
 */
export type MigrationsJournal = {
  migrationsSchema: string;
  migrationsTable: string;
};

/**
 * The journal table as an operator would type it into `psql`: schema-qualified, each part quoted.
 *
 * Quoted always rather than when needed, because "when needed" is a reserved-word list this file
 * has no business keeping; a quoted lower-case identifier means exactly what the bare one does.
 */
function journalTable({
  migrationsSchema,
  migrationsTable,
}: MigrationsJournal): string {
  const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
  return `${quote(migrationsSchema)}.${quote(migrationsTable)}`;
}

type Journal = { entries: { idx: number; tag: string; when: number }[] };

/**
 * The folder, read the way the migrator reads it: the journal decides, not the directory listing.
 *
 * A `.sql` file with no journal entry never runs and is not this function's business; an entry with
 * no file stops the migrator dead, and `readFile` rejecting here says so in the same breath.
 */
export async function readMigrationFolder(
  folder: string,
): Promise<FolderMigration[]> {
  const journal = JSON.parse(
    await readFile(join(folder, "meta", "_journal.json"), "utf8"),
  ) as Journal;

  return Promise.all(
    journal.entries.map(async (entry) => ({
      tag: entry.tag,
      when: entry.when,
      hash: createHash("sha256")
        .update(await readFile(join(folder, `${entry.tag}.sql`), "utf8"))
        .digest("hex"),
    })),
  );
}

/**
 * The number the migrator will compare every journal `when` against, chosen the way it chooses it.
 *
 * `PgDialect.migrate` (drizzle-orm 0.45.2) runs `select … order by created_at desc limit 1` and then
 * `Number(lastDbMigration.created_at) < migration.folderMillis`. Two things follow, and this
 * function must reproduce both, because a guard that picks a different row than the migrator is a
 * guard about some other migrator:
 *
 *  - Postgres puts NULLs FIRST in a descending sort, so one NULL `created_at` is the row it reads,
 *    however many real stamps sit below it. `Math.max` over the stamps picks the largest real one
 *    and disagrees.
 *  - `Number(null)` is 0, so that row's mark is 0 and every migration in the folder is "after" it:
 *    the migrator re-runs the whole history and dies on the first `CREATE TYPE` that already exists.
 *
 * `undefined` for an empty table: the migrator then has no row and runs everything, correctly.
 */
export function migratorHighWaterMark(
  applied: readonly AppliedMigration[],
): number | undefined {
  if (applied.length === 0) return undefined;
  if (applied.some((row) => row.createdAt === null)) return 0;
  return Math.max(...applied.map((row) => row.createdAt ?? 0));
}

/**
 * The migrations the migrator would get wrong on this database, judged against the row it reads.
 *
 * Two ways, both of which end with the migrator's word and the database disagreeing:
 *
 *  - OUT OF REACH: never applied, and stamped at or below the mark — walked past forever, while the
 *    run reports success.
 *  - TO BE RE-RUN: already applied (its hash is recorded), yet stamped ABOVE the mark — run a second
 *    time. With honest stamps the mark is at least every applied migration's `when`, so this is
 *    empty; it fills when the row the migrator reads is not the newest stamp, which a NULL
 *    `created_at` guarantees.
 *
 * An empty `applied` is a database the migrator has never touched, where everything is reachable by
 * definition — a fresh database can never be in this trouble, and saying so explicitly keeps the
 * check from having an opinion about the one case it has no evidence for.
 */
export function migrationsOutOfReach(
  folder: readonly FolderMigration[],
  applied: readonly AppliedMigration[],
): FolderMigration[] {
  const highWaterMark = migratorHighWaterMark(applied);
  if (highWaterMark === undefined) return [];

  const appliedHashes = new Set(applied.map((row) => row.hash));

  return folder.filter((migration) =>
    migration.when <= highWaterMark
      ? !appliedHashes.has(migration.hash)
      : appliedHashes.has(migration.hash),
  );
}

/**
 * The refusal, written for whoever is reading a failed deploy at an unreasonable hour.
 *
 * It names the mark and what set it, every migration that cannot be reached, and the two ways out,
 * because the one thing an operator cannot work out from a stack trace is that the database is
 * *ahead* of the folder rather than behind it.
 *
 * `journal` is required, not defaulted: the repair instructions are SQL an operator will paste, and
 * they must name the table the check actually read. A default here would be a second spelling of the
 * name, and the first configuration that moved the journal would make this message send someone to
 * repair a table that is not the one refusing them.
 */
export function outOfReachRefusal(
  outOfReach: readonly FolderMigration[],
  folder: readonly FolderMigration[],
  applied: readonly AppliedMigration[],
  journal: MigrationsJournal,
): string {
  const table = journalTable(journal);
  const highWaterMark = migratorHighWaterMark(applied) ?? 0;
  const appliedHashes = new Set(applied.map((row) => row.hash));
  const skipped = outOfReach.filter(
    (migration) => !appliedHashes.has(migration.hash),
  );
  const rerun = outOfReach.filter((migration) =>
    appliedHashes.has(migration.hash),
  );
  const nulls = applied.filter((row) => row.createdAt === null).length;
  const inFolder = new Set(folder.map((migration) => migration.hash));
  /*
   * Rows this folder cannot account for. Not a failure on its own — a squashed or deleted migration
   * leaves them too — but when migrations are out of reach these rows are almost always the reason,
   * so the count is the fastest thing an operator can act on.
   */
  const unknown = applied.filter((row) => !inFolder.has(row.hash)).length;
  const mark =
    nulls > 0
      ? "a row with no created_at, which the migrator reads first and counts as 0"
      : (folder.find((migration) => migration.when === highWaterMark)?.tag ??
        "a migration this folder does not contain");
  const list = (migrations: readonly FolderMigration[]) =>
    migrations.map(
      (migration) => `  - ${migration.tag} (stamped ${migration.when})`,
    );

  return [
    `This database's migration journal, ${table}, has already recorded a migration stamped ${highWaterMark} (${mark}), and the migrator only runs migrations stamped after the row it reads: the first one ordered by created_at descending.`,
    ...(nulls === 0
      ? []
      : [
          `${nulls === 1 ? "1 applied row has" : `${nulls} applied rows have`} a NULL created_at. Postgres sorts NULLs first in a descending order, so that row, not the newest stamp, is the mark.`,
        ]),
    ...(skipped.length === 0
      ? []
      : [
          `${skipped.length === 1 ? "This migration is" : `These ${skipped.length} migrations are`} stamped at or below that mark and ${skipped.length === 1 ? "has" : "have"} never been applied here, so running the migrator would skip ${skipped.length === 1 ? "it" : "them"} and report success over the schema ${skipped.length === 1 ? "it" : "they"} should have created:`,
          ...list(skipped),
        ]),
    ...(rerun.length === 0
      ? []
      : [
          `${rerun.length === 1 ? "This migration has" : `These ${rerun.length} migrations have`} already been applied here but ${rerun.length === 1 ? "is" : "are"} stamped above that mark, so running the migrator would run ${rerun.length === 1 ? "it" : "them"} a second time:`,
          ...list(rerun),
        ]),
    unknown === 0
      ? "Every applied migration is still present in this folder."
      : `${unknown} applied ${unknown === 1 ? "migration is" : "migrations are"} not in this folder at all, which is what a renumbered or rewritten migration history looks like from here: this database ran a journal that no longer exists.`,
    nulls > 0
      ? `Nothing has been applied. Give every row with a NULL created_at the journal \`when\` of the migration whose hash it records (\`update ${table} set created_at = <its journal when> where hash = <sha256 of the file>\`), or delete a row that matches no migration, and run again.`
      : `Nothing has been applied. Recreate the database from empty if it is disposable (a development, preview or CI database usually is); otherwise apply the SQL above by hand and record each one with \`insert into ${table} (hash, created_at) values (<sha256 of the file>, <its journal when>)\`, which leaves the high-water mark where it is.`,
  ].join("\n");
}

/**
 * Apply a migration folder to a database, or refuse before touching it.
 *
 * Separate from `scripts/migrate.ts` so that the refusal has a test. The script is an executable —
 * it reads the environment and exits — and the only way to find out what it does to a database that
 * is one journal out of step is to run it against such a database, which is what
 * `tests/migration-reach.integration.test.ts` does through this function.
 *
 * See `./migration-reach` for what is being checked and why the answer is a refusal rather than a
 * repair.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Sql, TransactionSql } from "postgres";
import {
  type AppliedMigration,
  type MigrationsJournal,
  migrationsOutOfReach,
  outOfReachRefusal,
  readMigrationFolder,
} from "./migration-reach";

/**
 * Where the migrator keeps its bookkeeping, named once.
 *
 * `migrate()` writes to whatever `migrationsSchema` / `migrationsTable` it is handed, and the
 * reach check below reads the same table to decide whether migrating is safe. If the two ever named
 * different tables the check would read an absent table, see nothing applied, and wave every
 * migration through — the refusal silently switched off. So both are handed this one object, and
 * nothing else in the server spells the name.
 *
 * The same object reaches the refusal's repair SQL (`outOfReachRefusal`), so the table an operator
 * is told to fix is the table the check read. The type is declared in `./migration-reach` and the
 * value here: that module is the dependency, not the dependent, and importing this value into it
 * would close a cycle.
 */
export type { MigrationsJournal };

export const MIGRATIONS_JOURNAL: MigrationsJournal = {
  migrationsSchema: "drizzle",
  migrationsTable: "__drizzle_migrations",
};

/**
 * What the migrator has already recorded here, or nothing at all.
 *
 * `to_regclass` rather than a query that may fail: a database the migrator has never touched has no
 * journal schema, and selecting from a table that is not there would be an error indistinguishable
 * from a database that cannot be read.
 */
async function appliedMigrations(
  client: TransactionSql,
  { migrationsSchema, migrationsTable }: MigrationsJournal,
): Promise<AppliedMigration[]> {
  const [present] = await client<{ table: string | null }[]>`
    select to_regclass(format('%I.%I', ${migrationsSchema}::text, ${migrationsTable}::text))::text as table
  `;
  if (!present?.table) return [];

  const rows = await client<{ hash: string; created_at: string | null }[]>`
    select hash, created_at from ${client(migrationsSchema)}.${client(migrationsTable)}
  `;
  return rows.map((row) => ({
    hash: row.hash,
    /*
     * A NULL `created_at` is CARRIED, never coerced. `Number(null)` is 0, and 0 is a legitimate
     * stamp — so coercing here would hand `migratorHighWaterMark` a row indistinguishable from an
     * early migration and the guard would pass on exactly the database it exists to refuse. The
     * column is a bare `bigint` drizzle leaves nullable; see `./migration-reach`.
     */
    createdAt: row.created_at === null ? null : Number(row.created_at),
  }));
}

/** Thrown instead of migrating, when migrating would skip work and call it done. */
export class MigrationsOutOfReachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationsOutOfReachError";
  }
}

/**
 * One lock per database for every run of this function, whatever journal it carries.
 *
 * A constant rather than anything derived from the folder: the runs that must not overlap are
 * precisely the ones whose folders differ. Advisory locks are scoped to the database, so two
 * databases on one server never wait on each other.
 */
const MIGRATION_LOCK = "openbot:apply-migrations";

/**
 * Check, then migrate, with nothing able to commit in between.
 *
 * THE GAP THIS CLOSES. The reach check reads the journal table; the migrator then reads it AGAIN to
 * find its high-water mark. Run as two steps, a second migrator could commit between
 * those reads — and if it carries a different journal (an operator's `db:migrate` from a checkout,
 * or a second release's Job started while the first is still running) its stamp can land above a
 * migration this run still has pending. The check passed before that stamp existed; the migrator
 * reads it afterwards, walks past the migration, and the run reports success over a table that is
 * not there: the exact outcome the check exists to prevent, arrived at through the gap between the
 * two reads. A rival with the SAME journal (a Job pod the controller started twice) is the lesser
 * case: both read the same mark, both run the same SQL, and one dies on a duplicate `CREATE`.
 *
 * So both run inside one transaction that first takes a transaction-scoped advisory lock. Every
 * other run of this function queues behind it and, once admitted, checks a table the previous run
 * has already committed. The lock goes with the transaction — on commit, on the refusal's rollback,
 * or when the connection dies — so there is no unlock to forget and no session to leak it into.
 *
 * WHAT IT DOES NOT COVER. A migrator that is not this function (`drizzle-kit migrate`, or an image
 * built before this lock) does not take it, and can still interleave. Every path this repository
 * runs goes through here; see `scripts/migrate.ts`.
 */
export async function applyMigrations(
  client: Sql,
  migrationsFolder: string,
  journal: MigrationsJournal = MIGRATIONS_JOURNAL,
): Promise<void> {
  const folder = await readMigrationFolder(migrationsFolder);

  await client.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${MIGRATION_LOCK}, 0))`;

    const applied = await appliedMigrations(tx, journal);
    const outOfReach = migrationsOutOfReach(folder, applied);
    if (outOfReach.length > 0) {
      throw new MigrationsOutOfReachError(
        outOfReachRefusal(outOfReach, folder, applied, journal),
      );
    }

    await migrate(drizzle(withinTransaction(client, tx)), {
      migrationsFolder,
      ...journal,
    });
  });
}

/**
 * The open transaction, in the shape `drizzle()` takes a client in.
 *
 * Drizzle's migrator reads its high-water mark and runs the migrations through the client it is
 * given, and opens its own transaction with `client.begin`. A postgres.js transaction has no
 * `begin` — only `savepoint` — and no `options`, which `drizzle()` writes its type parsers into. So
 * this hands it exactly those three things: `unsafe` and `savepoint` from the transaction, so every
 * statement the migrator sends is inside the lock, and `options` from the pool the transaction
 * belongs to, which is where postgres.js reads parsers from. Its transaction becomes a savepoint in
 * ours, with the same all-or-nothing effect it always had.
 *
 * If a later drizzle-orm reaches for anything else on its client, it fails here with a TypeError at
 * the first migration rather than migrating outside the lock — and
 * `tests/migration-reach.integration.test.ts` runs exactly this path.
 */
function withinTransaction(client: Sql, tx: TransactionSql): Sql {
  const adapter = {
    options: client.options,
    unsafe: tx.unsafe.bind(tx),
    begin: <T>(fn: (sql: TransactionSql) => T | Promise<T>) => tx.savepoint(fn),
  };
  // The cast is the claim above: drizzle uses these three members and no others.
  return adapter as unknown as Sql;
}

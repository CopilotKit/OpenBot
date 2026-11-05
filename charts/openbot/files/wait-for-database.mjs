/*
 * Holds a workload that reads OpenBot's database until that database can serve it.
 *
 * Run by the chart as the `wait-for-database` init container, with `bun -e` from /app/server in the
 * OpenBot image itself: the same image as the container it holds, so nothing new is pulled, and the
 * same directory the migrations Job runs `scripts/migrate.ts` from, so the migrations it waits for are
 * exactly the ones that image carries and that Job applies.
 *
 * Two things must be true before it lets go, and neither is enough on its own:
 *
 *  - The database accepts THIS workload's connection: its own DATABASE_URL, user and password, through
 *    `postgres`, the client `scripts/migrate.ts` uses. A server that is merely up, which is all
 *    `pg_isready` says, can still refuse the credentials or be replaying its log.
 *  - Every migration in this image's journal is recorded in the migrator's journal table, matched by
 *    the hash the migrator itself stores. Not a count and not the newest stamp: a database that ran
 *    some other journal can hold more rows or a later stamp and still lack a table this code reads.
 *    The migrator applies its pending migrations in one transaction, so a run still in progress shows
 *    none of them, and this cannot pass on a half-migrated database. A database AHEAD of this image (an
 *    older image restarting after an upgrade migrated) holds every hash it carries and passes, which is
 *    what lets old replicas keep running through a rollout.
 *
 * Bounded by OPENBOT_DATABASE_WAIT_SECONDS. When that runs out it says what it last saw and exits 1, so
 * the pod's own restart policy, and whoever is watching it, decide what happens next. It never prints
 * DATABASE_URL, which carries the password.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";

// Where the migrator records what it applied: `MIGRATIONS_JOURNAL` in server/src/db/apply-migrations.ts.
// Named again here because this runs outside the server's code. If the two ever differ, this never
// lets go of a migrated database, which tests/chart-database-wait.test.ts migrates for real to catch.
const JOURNAL_TABLE = "drizzle.__drizzle_migrations";
const POLL_MS = 2_000;
const REPEAT_MS = 30_000;

const seconds = Number(process.env.OPENBOT_DATABASE_WAIT_SECONDS);
const url = process.env.DATABASE_URL;
const hint = process.env.OPENBOT_DATABASE_WAIT_HINT ?? "";
if (!Number.isInteger(seconds) || seconds < 1) {
  console.error(
    "OPENBOT_DATABASE_WAIT_SECONDS must be a whole number of seconds of at least 1.",
  );
  process.exit(1);
}
if (!url) {
  console.error(
    "DATABASE_URL is not set, so there is no database to wait for.",
  );
  process.exit(1);
}

/*
 * The journal decides, not the directory listing, and each file is hashed the way drizzle-orm's
 * `readMigrationFiles` hashes it: the whole file as a string, before any statement splitting.
 */
const journal = JSON.parse(
  readFileSync("drizzle/meta/_journal.json").toString(),
);
const migrations = journal.entries.map(({ tag }) => ({
  tag,
  hash: createHash("sha256")
    .update(readFileSync(`drizzle/${tag}.sql`).toString())
    .digest("hex"),
}));
const newest = migrations.at(-1)?.tag ?? "none";
const started = Date.now();
const elapsed = () => Math.round((Date.now() - started) / 1000);

let reason = "no attempt has finished yet";

/*
 * A timer rather than a check between attempts, so the bound holds even when an attempt itself hangs:
 * a connection that is opened and then never answered would otherwise hold this past it.
 */
setTimeout(() => {
  console.error(
    `OpenBot's database was not ready within ${seconds}s: ${reason}.${hint ? ` ${hint}` : ""}`,
  );
  process.exit(1);
}, seconds * 1000);

/** Why the database cannot serve this workload yet, or undefined when it can. */
async function notReady() {
  const sql = postgres(url, {
    max: 1,
    connect_timeout: 5,
    onnotice: () => {},
  });
  try {
    const [found] =
      await sql`select to_regclass(${JOURNAL_TABLE})::text as journal`;
    if (!found?.journal) {
      return "it accepts this workload's connection, and no migration has been applied to it yet";
    }
    const rows = await sql.unsafe(`select hash from ${JOURNAL_TABLE}`);
    const applied = new Set(rows.map((row) => row.hash));
    const missing = migrations.filter(
      (migration) => !applied.has(migration.hash),
    );
    if (missing.length === 0) return undefined;
    return `it accepts this workload's connection, and ${migrations.length - missing.length} of the ${migrations.length} migrations this image carries are applied: ${missing[0].tag} is not`;
  } catch (error) {
    return `it does not accept this workload's connection yet (${error instanceof Error ? error.message : String(error)})`;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

console.log(
  `Waiting until OpenBot's database accepts this workload's connection and holds all ${migrations.length} migrations this image carries, through ${newest}. Giving up after ${seconds}s.`,
);
let said;
let saidAt = 0;
for (;;) {
  const now = await notReady();
  if (now === undefined) {
    console.log(
      `OpenBot's database is ready after ${elapsed()}s: it accepts this workload's connection and holds all ${migrations.length} migrations through ${newest}.`,
    );
    process.exit(0);
  }
  reason = now;
  // Said when it changes, and repeated now and then, so a long wait still shows it is alive.
  if (now !== said || Date.now() - saidAt >= REPEAT_MS) {
    console.log(`Still waiting after ${elapsed()}s: ${now}.`);
    said = now;
    saidAt = Date.now();
  }
  await Bun.sleep(POLL_MS);
}

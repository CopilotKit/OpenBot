import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import {
  applyMigrations,
  MIGRATIONS_JOURNAL,
  type MigrationsJournal,
  MigrationsOutOfReachError,
} from "../src/db/apply-migrations";
import { testDatabaseUrl } from "./support/database";

/**
 * The renumber, run for real, because the whole defect is what a real migrator does to a real
 * database and nothing short of one can show it.
 *
 * A database is created per case and dropped afterwards. A schema inside the shared test database
 * would not do: the migrator's own bookkeeping lives in one table (`MIGRATIONS_JOURNAL`), and these
 * cases are entirely about what that one table already contains, so they need a database whose
 * contents nothing else wrote.
 *
 * The migrations below are two statements long on purpose. The journal that matters here is the
 * sequence of stamps, not the SQL, and this file has no business taking seconds to re-run the
 * fifty-odd real ones twice per case.
 */

const server = new URL(testDatabaseUrl());
const administrative = new URL(server.href);
administrative.pathname = "/postgres";

const created: string[] = [];

async function throwawayDatabase(): Promise<string> {
  const name = `openbot_reach_${Math.random().toString(36).slice(2, 10)}`;
  const admin = postgres(administrative.href, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  created.push(name);
  const url = new URL(server.href);
  url.pathname = `/${name}`;
  return url.href;
}

afterAll(async () => {
  const admin = postgres(administrative.href, { max: 1, onnotice: () => {} });
  try {
    for (const name of created) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
});

type Entry = { tag: string; when: number; sql: string };

/** A migration folder on disk, in the shape `readMigrationFiles` insists on. */
async function folderOf(entries: Entry[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "migration-reach-"));
  await mkdir(join(directory, "meta"), { recursive: true });
  for (const entry of entries) {
    await writeFile(join(directory, `${entry.tag}.sql`), entry.sql);
  }
  await writeFile(
    join(directory, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: entries.map((entry, idx) => ({
        idx,
        version: "7",
        when: entry.when,
        tag: entry.tag,
        breakpoints: true,
      })),
    }),
  );
  return directory;
}

const first: Entry = {
  tag: "0000_first",
  when: 1_000_000,
  sql: 'CREATE TABLE "first" ("id" text PRIMARY KEY);\n',
};

/** The branch's own migration, as it shipped before the merge renumbered it. */
const asShipped: Entry = {
  tag: "0001_branch",
  when: 3_000_000,
  sql: 'CREATE TABLE "branch" ("id" text PRIMARY KEY);\n',
};

const exists = async (client: postgres.Sql, table: string) => {
  const [row] = await client<{ present: string | null }[]>`
    select to_regclass(${`public.${table}`})::text as present
  `;
  return row?.present !== null && row?.present !== undefined;
};

describe("a database that ran a branch before the branch was merged", () => {
  test("is refused, rather than migrated past the work it cannot reach", async () => {
    const url = await throwawayDatabase();
    const client = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await applyMigrations(client, await folderOf([first, asShipped]));
      expect(await exists(client, "branch")).toBe(true);

      /*
       * The merge: main's migration takes the number the branch's had, stamped when main's author
       * generated it — before the branch shipped — and the branch's work is restamped after both.
       * The unguarded migrator runs `0002`, walks past `0001`, and reports success.
       */
      const merged = await folderOf([
        first,
        {
          tag: "0001_from_main",
          when: 2_000_000,
          sql: 'CREATE TABLE "from_main" ("id" text PRIMARY KEY);\n',
        },
        {
          ...asShipped,
          tag: "0002_branch_renumbered",
          when: 4_000_000,
          sql: 'ALTER TABLE "branch" ADD COLUMN "renumbered" boolean;\n',
        },
      ]);

      const refusal = await applyMigrations(client, merged).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(MigrationsOutOfReachError);
      expect((refusal as Error).message).toContain(
        "0001_from_main (stamped 2000000)",
      );

      // And refused before anything ran, rather than part way through: the database is exactly as
      // the branch left it, which is the state an operator can reason about.
      expect(await exists(client, "from_main")).toBe(false);
      const [row] = await client<{ count: string }[]>`
        select count(*)::text as count
        from ${client(MIGRATIONS_JOURNAL.migrationsSchema)}.${client(MIGRATIONS_JOURNAL.migrationsTable)}
      `;
      expect(row?.count).toBe("2");
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  test("is refused before the statement that would have failed on it", async () => {
    /*
     * The other half, and the one that at least announces itself. Where the renumbered migration
     * recreates a table the branch already created, the unguarded migrator dies on `CREATE TABLE`
     * with a duplicate — after having skipped the migration below the mark, so that the obvious
     * hand repair (drop the table, run again) is what turns a loud failure into a silent one.
     */
    const url = await throwawayDatabase();
    const client = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await applyMigrations(client, await folderOf([first, asShipped]));

      const merged = await folderOf([
        first,
        {
          tag: "0001_from_main",
          when: 2_000_000,
          sql: 'CREATE TABLE "from_main" ("id" text PRIMARY KEY);\n',
        },
        { ...asShipped, tag: "0002_branch_renumbered", when: 4_000_000 },
      ]);

      await expect(applyMigrations(client, merged)).rejects.toThrow(
        MigrationsOutOfReachError,
      );
    } finally {
      await client.end({ timeout: 5 });
    }
  });
});

describe("a journal kept somewhere other than the default", () => {
  /*
   * The check and the migrator must read and write the same bookkeeping table. Were the check to
   * look somewhere fixed while the migrator honoured its configuration, the check would find no
   * table, conclude nothing had been applied, and let the migrator walk past the unreachable
   * migration exactly as if there were no check at all.
   */
  const elsewhere: MigrationsJournal = {
    migrationsSchema: "c4_journal",
    migrationsTable: "applied_migrations",
  };

  test("is the table the check reads, so a renumber is still refused", async () => {
    const url = await throwawayDatabase();
    const client = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await applyMigrations(
        client,
        await folderOf([first, asShipped]),
        elsewhere,
      );

      const merged = await folderOf([
        first,
        {
          tag: "0001_from_main",
          when: 2_000_000,
          sql: 'CREATE TABLE "from_main" ("id" text PRIMARY KEY);\n',
        },
        {
          ...asShipped,
          tag: "0002_branch_renumbered",
          when: 4_000_000,
          sql: 'ALTER TABLE "branch" ADD COLUMN "renumbered" boolean;\n',
        },
      ]);

      const refusal = await applyMigrations(client, merged, elsewhere).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(MigrationsOutOfReachError);
      expect(await exists(client, "from_main")).toBe(false);

      // And the repair the refusal prescribes is SQL against the table it actually read.
      const message = (refusal as Error).message;
      expect(message).toContain(
        'insert into "c4_journal"."applied_migrations" (hash, created_at)',
      );
      expect(message).not.toContain(MIGRATIONS_JOURNAL.migrationsTable);

      // And the bookkeeping is where it was configured to be, and nowhere else.
      const [row] = await client<{ count: string }[]>`
        select count(*)::text as count
        from ${client(elsewhere.migrationsSchema)}.${client(elsewhere.migrationsTable)}
      `;
      expect(row?.count).toBe("2");
      const [fallback] = await client<{ present: string | null }[]>`
        select to_regclass(format('%I.%I', ${MIGRATIONS_JOURNAL.migrationsSchema}::text, ${MIGRATIONS_JOURNAL.migrationsTable}::text))::text as present
      `;
      expect(fallback?.present).toBeNull();
    } finally {
      await client.end({ timeout: 5 });
    }
  });
});

describe("an ordinary database", () => {
  test("migrates from empty and then forward, without being refused", async () => {
    const url = await throwawayDatabase();
    const client = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await applyMigrations(client, await folderOf([first]));
      await applyMigrations(
        client,
        await folderOf([
          first,
          {
            tag: "0001_next",
            when: 2_000_000,
            sql: 'CREATE TABLE "next" ("id" text PRIMARY KEY);\n',
          },
        ]),
      );

      expect(await exists(client, "next")).toBe(true);
    } finally {
      await client.end({ timeout: 5 });
    }
  });
});

/**
 * Two migrators against one database, interleaved at every point one of them talks to it.
 *
 * The reach check is a read, and the migrator's own decision is a second, later read of the same
 * table. If anything can commit between them, the check's verdict is about a database that no
 * longer exists by the time the migrator acts on it. The case that matters is a rival running a
 * DIFFERENT journal — an operator's `db:migrate` from a checkout, a second release's Job, a Job pod
 * the controller started twice while an older one is still running — that records a stamp above a
 * migration this run still has pending. The check passed before that stamp existed; the migrator
 * reads it afterwards and walks past the migration, and the run reports success over a table that is
 * not there. That is the exact outcome the reach check exists to prevent, arrived at through the gap
 * between the two reads.
 *
 * So the rival is started at the k-th database call this run makes, for every k, through a client
 * that pauses there. The pause ends when the rival has either finished or is visibly waiting on a
 * lock — waiting for it to FINISH would deadlock against a migrator that correctly holds one.
 * Whatever order results, a run that resolves must have applied everything in its folder: being
 * refused, or failing loudly, is an acceptable outcome; reporting success over a skipped migration
 * is not.
 */
describe("a migrator racing another migrator with a different journal", () => {
  const fromMain: Entry = {
    tag: "0001_from_main",
    when: 2_000_000,
    sql: 'CREATE TABLE "from_main" ("id" text PRIMARY KEY);\n',
  };
  const rivalOnly: Entry = {
    tag: "0001_rival",
    when: 3_000_000,
    sql: 'CREATE TABLE "rival" ("id" text PRIMARY KEY);\n',
  };

  type Gate = { count: number; at: number; hit: Promise<void> | undefined };

  /**
   * `client`, except that its `at`-th call into the database first waits for `pause()`.
   *
   * Every way a caller reaches the server is counted — a tagged query, `unsafe`, `begin`,
   * `savepoint`, and the connection a `begin` or `savepoint` hands to its callback — so a pause can
   * land between ANY two statements, including those issued inside a transaction.
   */
  function pausing<T extends object>(
    client: T,
    gate: Gate,
    pause: () => Promise<void>,
  ): T {
    const before = (): Promise<void> => {
      gate.count += 1;
      if (gate.count !== gate.at) return Promise.resolve();
      gate.hit = pause();
      return gate.hit;
    };
    /*
     * A lazy thenable: the query is built, and so sent, only once the pause is over, and only in
     * the form — awaited, or `.values()` — that the caller actually asked for.
     */
    const deferred = (build: () => unknown) => {
      const waited = before();
      return {
        // biome-ignore lint/suspicious/noThenProperty: it stands in for a query, which is awaitable
        then: (
          resolve: (value: unknown) => unknown,
          reject: (error: unknown) => unknown,
        ) => waited.then(() => build()).then(resolve, reject),
        values: () =>
          waited.then(() =>
            (build() as { values: () => Promise<unknown> }).values(),
          ),
      };
    };
    return new Proxy(client, {
      apply: (target, _this, args) =>
        deferred(() =>
          Reflect.apply(
            target as (...a: unknown[]) => unknown,
            undefined,
            args,
          ),
        ),
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== "function") return value;
        const method = value as (...args: unknown[]) => unknown;
        if (property === "unsafe") {
          return (...args: unknown[]) => deferred(() => method(...args));
        }
        if (property === "begin" || property === "savepoint") {
          return (...args: unknown[]) => {
            const fn = args.pop() as (sql: unknown) => unknown;
            return before().then(() =>
              method(...args, (inner: object) =>
                fn(pausing(inner, gate, pause)),
              ),
            );
          };
        }
        return value;
      },
    });
  }

  test("never reports success over a migration a rival's stamp put out of its reach", async () => {
    let pausesExercised = 0;
    for (let at = 1; ; at += 1) {
      const url = await throwawayDatabase();
      const setup = postgres(url, { max: 1, onnotice: () => {} });
      const ours = postgres(url, { max: 1, onnotice: () => {} });
      const rival = postgres(url, {
        max: 1,
        onnotice: () => {},
        connection: { application_name: "migration-rival" },
      });
      try {
        await applyMigrations(setup, await folderOf([first]));
        const ourFolder = await folderOf([first, fromMain]);
        const rivalFolder = await folderOf([first, rivalOnly]);

        let rivalRun: Promise<unknown> | undefined;
        let rivalSettled = false;
        const gate: Gate = { count: 0, at, hit: undefined };
        const pause = async () => {
          rivalRun = applyMigrations(rival, rivalFolder).then(
            () => {
              rivalSettled = true;
              return "applied" as const;
            },
            (error: unknown) => {
              rivalSettled = true;
              return error;
            },
          );
          // Finished, or parked behind a lock: either way it has had every chance to get in first.
          const deadline = Date.now() + 10_000;
          while (!rivalSettled) {
            const [row] = await setup<{ waiting: boolean }[]>`
              select exists (
                select 1 from pg_stat_activity
                where application_name = 'migration-rival'
                  and wait_event_type = 'Lock'
              ) as waiting
            `;
            if (row?.waiting) break;
            if (Date.now() > deadline) {
              throw new Error(
                `the rival migrator neither finished nor waited on a lock (paused at call ${at})`,
              );
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        };

        const outcome = await applyMigrations(
          pausing(ours, gate, pause),
          ourFolder,
        ).then(
          () => "applied" as const,
          (error: unknown) => error,
        );
        if (gate.hit === undefined) break; // every call this run makes has had a rival in front of it
        await gate.hit;
        const rivalOutcome = await rivalRun;
        pausesExercised += 1;

        // Refused or failed is acceptable. Applied means applied.
        if (outcome === "applied") {
          expect({
            pausedAtCall: at,
            fromMainExists: await exists(setup, "from_main"),
          }).toEqual({ pausedAtCall: at, fromMainExists: true });
        }
        if (rivalOutcome === "applied") {
          expect({
            pausedAtCall: at,
            rivalExists: await exists(setup, "rival"),
          }).toEqual({ pausedAtCall: at, rivalExists: true });
        }
      } finally {
        await ours.end({ timeout: 5 });
        await rival.end({ timeout: 5 });
        await setup.end({ timeout: 5 });
      }
    }
    /*
     * A harness whose pause never landed would pass vacuously. Every run makes at least the two
     * reads of the check and the migrator's own statements; each of them must have been tried.
     */
    expect(pausesExercised).toBeGreaterThanOrEqual(4);
  }, 120_000);
});

describe("a database whose migrations table holds a NULL created_at", () => {
  test("is refused, rather than migrated from the start again", async () => {
    /*
     * drizzle reads `order by created_at desc limit 1`; Postgres sorts NULLs first, so the planted
     * row is the mark, `Number(null)` is 0, and the unguarded migrator re-runs `0000_first` and dies
     * on `relation "first" already exists`. The guard must pick the same row and refuse first.
     */
    const url = await throwawayDatabase();
    const client = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const folder = await folderOf([first, asShipped]);
      await applyMigrations(client, folder);
      await client`
        insert into ${client(MIGRATIONS_JOURNAL.migrationsSchema)}.${client(MIGRATIONS_JOURNAL.migrationsTable)} (hash, created_at)
        values ('hand-written', null)
      `;

      const refusal = await applyMigrations(client, folder).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(MigrationsOutOfReachError);
      expect((refusal as Error).message).toContain(
        "1 applied row has a NULL created_at",
      );
      expect((refusal as Error).message).toContain(
        "0000_first (stamped 1000000)",
      );
    } finally {
      await client.end({ timeout: 5 });
    }
  });
});

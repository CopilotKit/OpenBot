import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS_JOURNAL } from "../src/db/apply-migrations";
import {
  type AppliedMigration,
  type FolderMigration,
  type MigrationsJournal,
  migrationsOutOfReach,
  migratorHighWaterMark,
  outOfReachRefusal,
  readMigrationFolder,
} from "../src/db/migration-reach";

/**
 * The check that `migration-journal.test.ts` cannot make.
 *
 * That file reads one journal and asks whether it is internally consistent — stamps increasing, a
 * file for every entry, a snapshot for every file. Every one of those passed over the defect this
 * file exists for, because the defect is not inside the journal. It is between the journal in the
 * repository and the stamps that a PREVIOUS journal already wrote into a running database: the
 * merge that renumbered this branch's migrations gave main's `0053_identity_links` a `when` older
 * than the stamp a pre-merge database had already recorded for the branch's own work, and the
 * migrator skips what it finds below the newest stamp without a word. `migrate` printed
 * `{"type":"migrations-applied","status":"ok"}` while `identity_links` and
 * `identity_link_challenges` did not exist.
 *
 * No journal, read alone, can show that. So the check lives in the migrator's path instead, and
 * this is its test.
 */

const migration = (
  tag: string,
  when: number,
  hash: string,
): FolderMigration => ({ tag, when, hash });

const applied = (hash: string, createdAt: number | null): AppliedMigration => ({
  hash,
  createdAt,
});

describe("migrations out of reach", () => {
  test("finds none on a database the migrator has never touched", () => {
    const folder = [
      migration("0000_first", 1000, "a"),
      migration("0001_second", 2000, "b"),
    ];

    expect(migrationsOutOfReach(folder, [])).toEqual([]);
  });

  test("finds none when the database is simply behind the folder", () => {
    const folder = [
      migration("0000_first", 1000, "a"),
      migration("0001_second", 2000, "b"),
      migration("0002_third", 3000, "c"),
    ];

    // The normal case, and the one that must never be refused: two applied, one pending.
    expect(
      migrationsOutOfReach(folder, [applied("a", 1000), applied("b", 2000)]),
    ).toEqual([]);
  });

  test("finds none when the database is exactly up to date", () => {
    const folder = [
      migration("0000_first", 1000, "a"),
      migration("0001_second", 2000, "b"),
    ];

    expect(
      migrationsOutOfReach(folder, [applied("a", 1000), applied("b", 2000)]),
    ).toEqual([]);
  });

  test("names a migration stamped below the mark that has never been applied", () => {
    /*
     * The renumber, in miniature. The database ran a branch whose migration was stamped 3000; the
     * merge then brought in a migration from main stamped 2000 and restamped the branch's work
     * 4000. The migrator compares against 3000, so 2000 is walked past, 4000 runs, and the run is
     * reported as a success that applied everything.
     */
    const folder = [
      migration("0000_first", 1000, "a"),
      migration("0001_from_main", 2000, "main"),
      migration("0002_branch_renumbered", 4000, "renumbered"),
    ];
    const database = [applied("a", 1000), applied("branch-as-shipped", 3000)];

    expect(migrationsOutOfReach(folder, database)).toEqual([
      migration("0001_from_main", 2000, "main"),
    ]);
  });

  test("names a migration stamped exactly on the mark", () => {
    /*
     * The comparison the migrator makes is `recorded < when`, so a migration stamped exactly at the
     * mark is skipped as surely as one stamped below it. Off by one here would be a check that
     * passes a database it cannot bring up to date.
     */
    const folder = [
      migration("0000_first", 1000, "a"),
      migration("0001_tied", 2000, "tied"),
    ];

    expect(migrationsOutOfReach(folder, [applied("a", 2000)])).toEqual([
      migration("0001_tied", 2000, "tied"),
    ]);
  });

  test("names every unreachable migration, not just the first", () => {
    const folder = [
      migration("0001_one", 1000, "one"),
      migration("0002_two", 2000, "two"),
      migration("0003_three", 5000, "three"),
    ];

    expect(
      migrationsOutOfReach(folder, [applied("something-else", 3000)]),
    ).toEqual([
      migration("0001_one", 1000, "one"),
      migration("0002_two", 2000, "two"),
    ]);
  });

  test("is not fooled by a migration whose file has been rewritten", () => {
    // Applied under one hash, present in the folder under another: the database ran different SQL
    // from the file that now claims to be it, and the difference will never be applied.
    const folder = [migration("0000_first", 1000, "rewritten")];

    expect(migrationsOutOfReach(folder, [applied("original", 1000)])).toEqual([
      migration("0000_first", 1000, "rewritten"),
    ]);
  });
});

describe("the row the migrator reads", () => {
  /*
   * The guard is only as good as its agreement with the migrator about WHICH applied row is the
   * mark. drizzle reads `order by created_at desc limit 1`, and Postgres sorts NULLs first in a
   * descending order: one NULL `created_at` is the row it reads, `Number(null)` is 0, and every
   * migration in the folder looks unapplied. `Math.max` over the stamps picks the newest real one
   * instead, finds nothing out of reach, and waves through a run that dies re-creating the first
   * type the database already has (`type "agent_type" already exists`).
   */
  test("is a NULL created_at, however many real stamps sit below it", () => {
    const folder = [
      migration("0000_first", 1000, "a"),
      migration("0001_second", 2000, "b"),
    ];
    const database = [
      applied("a", 1000),
      applied("b", 2000),
      applied("hand-written", null),
    ];

    expect(migratorHighWaterMark(database)).toBe(0);
    expect(migrationsOutOfReach(folder, database)).toEqual(folder);
  });

  test("is the newest stamp when no created_at is NULL", () => {
    expect(
      migratorHighWaterMark([applied("a", 1000), applied("b", 2000)]),
    ).toBe(2000);
  });

  test("does not exist on a database the migrator has never touched", () => {
    expect(migratorHighWaterMark([])).toBeUndefined();
  });

  test("refuses every applied migration the shipped folder would run a second time", async () => {
    const folder = await readMigrationFolder(
      new URL("../drizzle/", import.meta.url).pathname,
    );
    const database = [
      ...folder.map((entry) => applied(entry.hash, entry.when)),
      applied("hand-written", null),
    ];

    expect(
      migrationsOutOfReach(folder, database).map((entry) => entry.tag),
    ).toEqual(folder.map((entry) => entry.tag));
  });

  test("says that a NULL created_at is the mark, and names what would run twice", () => {
    const folder = [
      migration("0000_first", 1000, "a"),
      migration("0001_second", 2000, "b"),
    ];
    const database = [
      applied("a", 1000),
      applied("b", 2000),
      applied("hand-written", null),
    ];
    const text = outOfReachRefusal(
      migrationsOutOfReach(folder, database),
      folder,
      database,
      MIGRATIONS_JOURNAL,
    );

    expect(text).toContain("1 applied row has a NULL created_at");
    expect(text).toContain("would run them a second time");
    expect(text).toContain("0000_first (stamped 1000)");
    expect(text).toContain("0001_second (stamped 2000)");
    expect(text).not.toContain("would skip");
  });
});

describe("the refusal", () => {
  const folder = [
    migration("0000_first", 1000, "a"),
    migration("0001_from_main", 2000, "main"),
    migration("0002_branch_renumbered", 4000, "renumbered"),
  ];
  const database = [applied("a", 1000), applied("branch-as-shipped", 3000)];
  const text = outOfReachRefusal(
    migrationsOutOfReach(folder, database),
    folder,
    database,
    MIGRATIONS_JOURNAL,
  );

  test("names the migration that cannot be reached", () => {
    expect(text).toContain("0001_from_main (stamped 2000)");
  });

  test("names the mark that puts it out of reach", () => {
    expect(text).toContain("stamped 3000");
  });

  test("says that the database ran a journal this folder no longer has", () => {
    expect(text).toContain("1 applied migration is not in this folder at all");
  });

  test("says that nothing was applied", () => {
    expect(text).toContain("Nothing has been applied.");
  });
});

describe("the refusal, for a journal kept somewhere other than the default", () => {
  /*
   * The repair instructions are SQL an operator pastes into psql. They must name the table the
   * check read — never a spelling of the default that the configuration no longer guarantees.
   */
  const elsewhere: MigrationsJournal = {
    migrationsSchema: "c4_journal",
    migrationsTable: "applied_migrations",
  };
  const folder = [
    migration("0000_first", 1000, "a"),
    migration("0001_from_main", 2000, "main"),
    migration("0002_branch_renumbered", 4000, "renumbered"),
  ];

  test("tells the operator to record a skipped migration in that table", () => {
    const database = [applied("a", 1000), applied("branch-as-shipped", 3000)];
    const text = outOfReachRefusal(
      migrationsOutOfReach(folder, database),
      folder,
      database,
      elsewhere,
    );

    expect(text).toContain(
      'insert into "c4_journal"."applied_migrations" (hash, created_at)',
    );
    expect(text).not.toContain("__drizzle_migrations");
  });

  test("tells the operator to repair a NULL created_at in that table", () => {
    const database = [
      applied("a", 1000),
      applied("main", 2000),
      applied("hand-written", null),
    ];
    const text = outOfReachRefusal(
      migrationsOutOfReach(folder, database),
      folder,
      database,
      elsewhere,
    );

    expect(text).toContain("1 applied row has a NULL created_at");
    expect(text).toContain('update "c4_journal"."applied_migrations" set');
    expect(text).not.toContain("__drizzle_migrations");
  });

  test("quotes a name that would otherwise need it", () => {
    const database = [applied("a", 1000), applied("branch-as-shipped", 3000)];
    const text = outOfReachRefusal(
      migrationsOutOfReach(folder, database),
      folder,
      database,
      { migrationsSchema: "Ops", migrationsTable: 'odd"name' },
    );

    expect(text).toContain('insert into "Ops"."odd""name" (hash, created_at)');
  });
});

describe("reading a migration folder", () => {
  test("hashes the whole file the way the migrator does", async () => {
    const directory = await mkdtemp(join(tmpdir(), "migration-reach-"));
    const sql = 'CREATE TABLE "one" ("id" text);\n';
    await writeFile(join(directory, "0000_one.sql"), sql);
    await Bun.write(
      join(directory, "meta", "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [
          {
            idx: 0,
            version: "7",
            when: 1000,
            tag: "0000_one",
            breakpoints: true,
          },
        ],
      }),
    );

    expect(await readMigrationFolder(directory)).toEqual([
      {
        tag: "0000_one",
        when: 1000,
        // Whole file, before any `--> statement-breakpoint` split, which is what
        // `drizzle-orm/migrator` records and therefore what the database holds.
        hash: createHash("sha256").update(sql).digest("hex"),
      },
    ]);
  });
});

describe("the migrations this repository ships", () => {
  test("reach a database that has never been migrated", async () => {
    const folder = await readMigrationFolder(
      new URL("../drizzle/", import.meta.url).pathname,
    );

    expect(migrationsOutOfReach(folder, [])).toEqual([]);
  });

  test("reach a database that is up to date with them", async () => {
    const folder = await readMigrationFolder(
      new URL("../drizzle/", import.meta.url).pathname,
    );

    expect(
      migrationsOutOfReach(
        folder,
        folder.map((entry) => applied(entry.hash, entry.when)),
      ),
    ).toEqual([]);
  });

  test("do not reach a database that ran the arcade branch before it was merged", async () => {
    /*
     * The incident, pinned, because it is the only shape of this failure anybody has actually met.
     *
     * Before the merge, the arcade work shipped as `0053_adorable_frank_castle` (1791773482676) and
     * `0054_spicy_wallflower` (1791774497487). The merge renumbered it to `0057_arcade_provider`
     * (1791908858814, since squashed and restamped) and put main's `0053_identity_links` (1791547580808) in its place — a stamp
     * OLDER than what such a database had already recorded. Everything up to `0052` is byte for
     * byte the same file on both sides of the merge, so those rows are built from this folder.
     *
     * The expected answer is one name, and it is the migration whose two tables were missing from
     * the reproduction: `identity_links` and `identity_link_challenges`.
     */
    const folder = await readMigrationFolder(
      new URL("../drizzle/", import.meta.url).pathname,
    );
    const asShipped = [
      ...folder
        .filter((entry) => entry.when <= 1791396757748)
        .map((entry) => applied(entry.hash, entry.when)),
      applied("0053_adorable_frank_castle", 1791773482676),
      applied("0054_spicy_wallflower", 1791774497487),
    ];

    expect(
      migrationsOutOfReach(folder, asShipped).map((entry) => entry.tag),
    ).toEqual(["0053_identity_links"]);
  });
});

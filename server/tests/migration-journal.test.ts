import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";

/**
 * The migration journal, which decides what actually runs.
 *
 * Drizzle applies a migration when its journal `when` is later than the newest one the database has
 * recorded, so the ordering that matters is the timestamps, not the file names. A migration stamped
 * ahead of real time therefore does not merely sort oddly: it silently swallows every migration
 * authored after it until the clock catches up, and `drizzle-kit migrate` reports success while
 * doing it.
 *
 * That happened here. `0012` was hand-written with `when = previous + 86_400_000`, a day into the
 * future, and the next migration to arrive carried a real timestamp, so it was older by comparison.
 * `migrate` said "migrations applied successfully!", the table it should have created did not exist,
 * and the only symptom was an integration test failing with `relation "skill_tools" does not exist`.
 *
 * Nothing else in the build would have caught that, which is why this is a test rather than a note.
 */

type Entry = { idx: number; tag: string; when: number };

/**
 * A column as a snapshot describes it, which is more than its name.
 *
 * `type` and `notNull` are here because they are what `generate` DIFFS: a snapshot that names the
 * right column under the wrong type has the next migration emit an `ALTER COLUMN` nobody wrote, or
 * emit nothing where one was needed, and `notNull` decides whether the statement it emits can run
 * against rows that already exist. Both were read by nobody until the check below.
 */
type SnapshotColumn = { name: string; type?: string; notNull?: boolean };

type Snapshot = {
  tables?: Record<
    string,
    {
      name: string;
      columns?: Record<string, SnapshotColumn>;
      indexes?: Record<string, unknown>;
    }
  >;
};

const directory = new URL("../drizzle/", import.meta.url);

const readJournal = async (): Promise<Entry[]> => {
  const journal = JSON.parse(
    await readFile(new URL("meta/_journal.json", directory), "utf8"),
  ) as { entries: Entry[] };
  return journal.entries;
};

/** The snapshot `generate` writes for an entry is named after its index, never after its tag. */
const snapshotName = (idx: number) =>
  `${String(idx).padStart(4, "0")}_snapshot.json`;

const readSnapshot = async (idx: number): Promise<Snapshot> =>
  JSON.parse(
    await readFile(new URL(`meta/${snapshotName(idx)}`, directory), "utf8"),
  ) as Snapshot;

/*
 * A minute, not a day. The mistake this file exists for is `when = previous + 86_400_000`, so a
 * day of slack is exactly the amount that lets it through: at the moment it is authored such a
 * stamp sits a day ahead of the clock and a hair under `now + 86_400_000`, and the guard that was
 * written to name it never once could. What the slack is actually for is a migration generated on
 * a developer's machine whose clock runs a little fast and pushed straight into CI, which is
 * seconds of disagreement, not hours.
 */
const CLOCK_SKEW_ALLOWANCE = 60_000;

/**
 * Entries stamped later than the moment we are asking, which is the only moment such a stamp can
 * be caught at. This is deliberately a function of `now` rather than of `Date.now()` directly:
 * "ahead of real time" is a claim about when the entry was authored, so the test below asks it
 * about the present, and the test after that asks it about the day the documented mistake was made.
 *
 * Its reach is narrower than it looks, and that is not a hole. A stamp a day into the future is
 * only harmful while it is the newest entry, because the migration that lands next is the one it
 * swallows — and that migration carries a real timestamp, so it sorts *before* the bad one and the
 * ordering test above fails on it. Once the clock has passed the bad stamp nothing can be swallowed
 * any more. Between them the two tests say `max(when) <= now`, with no window in between.
 */
const stampedAhead = (entries: Entry[], now: number) =>
  entries
    .filter((entry) => entry.when > now + CLOCK_SKEW_ALLOWANCE)
    .map(
      (entry) =>
        `${entry.tag} is stamped ${entry.when}, ${entry.when - now}ms ahead of the clock`,
    );

const quoted = (sql: string, pattern: RegExp) =>
  [...sql.matchAll(pattern)].map((match) => match.slice(1) as string[]);

const tableNames = (snapshot: Snapshot) =>
  new Set(Object.values(snapshot.tables ?? {}).map((table) => table.name));

const tableIn = (snapshot: Snapshot, name: string) =>
  Object.values(snapshot.tables ?? {}).find((table) => table.name === name);

const columnNames = (snapshot: Snapshot, name: string) =>
  new Set(Object.keys(tableIn(snapshot, name)?.columns ?? {}));

const indexNames = (snapshot: Snapshot, name: string) =>
  new Set(Object.keys(tableIn(snapshot, name)?.indexes ?? {}));

const columnIn = (snapshot: Snapshot, table: string, column: string) =>
  tableIn(snapshot, table)?.columns?.[column];

/**
 * What an `ADD COLUMN` actually declares, out of everything it says after the column's name.
 *
 * THE NAME IS NOT THE COLUMN. Matching only names let the snapshot call a column anything it liked
 * — `probe_action` as a `boolean`, and `NOT NULL` where the statement adds it nullable — and every
 * check here went on agreeing. Both halves are what `generate` diffs the next schema against, so a
 * snapshot wrong about either has the next migration emit a statement nobody wrote: an `ALTER
 * COLUMN ... TYPE` correcting a type no database ever had, or a `SET NOT NULL` against a table full
 * of the nulls the real column has been collecting since.
 *
 * AND `NOT NULL` IS THE HALF THAT FAILS ON PRODUCTION AND NOT IN REVIEW. A column added nullable
 * and snapshotted `notNull` makes the next `generate` emit the constraint, which passes on an empty
 * development database and stops dead on the first deployment holding a row that never filled it in.
 *
 * The default is dropped rather than compared: drizzle records it in its own spelling — `false` for
 * the SQL `false`, `"now()"` for `now()`, a quoted string for a quoted string — and a comparison
 * against the SQL literal would be a comparison of two notations rather than of two schemas.
 */
const declared = (tail: string): { type: string; notNull: boolean } => ({
  type: tail
    .replace(/\bNOT NULL\b/gi, " ")
    .replace(/\bDEFAULT\s+(?:'(?:[^']|'')*'|[^\s;]+)/gi, " ")
    .trim()
    .replace(/\s+/g, " "),
  notNull: /\bNOT NULL\b/i.test(tail),
});

const everyIndexName = (snapshot: Snapshot) =>
  new Set(
    Object.values(snapshot.tables ?? {}).flatMap((table) =>
      Object.keys(table.indexes ?? {}),
    ),
  );

/**
 * What the SQL says it does, against what the two snapshots say happened.
 *
 * Read in both directions on purpose. A snapshot that describes a different schema than the
 * migration beside it satisfies "a snapshot exists" perfectly well, and then `generate` diffs the
 * next migration against a schema the database was never in. So every table, column and index the
 * snapshot pair moves has to be named by a statement in the file, and every statement in the file
 * has to show up in the snapshot pair.
 */
const disagreements = (sql: string, before: Snapshot, after: Snapshot) => {
  const created = quoted(
    sql,
    /CREATE TABLE (?:IF NOT EXISTS )?"([^"]+)"/gi,
  ).map(([table]) => table!);
  const dropped = quoted(sql, /DROP TABLE (?:IF EXISTS )?"([^"]+)"/gi).map(
    ([table]) => table!,
  );
  /*
   * The third capture is everything the statement says after the name — the type, and whatever
   * `DEFAULT` and `NOT NULL` follow it. See {@link declared}: the name alone says a column arrived
   * and nothing about what arrived.
   */
  const columnsAdded = quoted(
    sql,
    /ALTER TABLE "([^"]+)" ADD COLUMN (?:IF NOT EXISTS )?"([^"]+)"([^;]*)/gi,
  );
  const columnsDropped = quoted(
    sql,
    /ALTER TABLE "([^"]+)" DROP COLUMN (?:IF EXISTS )?"([^"]+)"/gi,
  );
  const indexesCreated = quoted(
    sql,
    /CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?"([^"]+)"/gi,
  ).map(([index]) => index!);
  const indexesDropped = quoted(
    sql,
    /DROP INDEX (?:IF EXISTS )?"([^"]+)"/gi,
  ).map(([index]) => index!);

  const was = tableNames(before);
  const is = tableNames(after);
  const problems: string[] = [];

  for (const table of is)
    if (!was.has(table) && !created.includes(table))
      problems.push(
        `the snapshot adds "${table}", the migration never creates it`,
      );
  for (const table of created)
    if (!is.has(table) || was.has(table))
      problems.push(
        `the migration creates "${table}", the snapshot does not add it`,
      );
  for (const table of was)
    if (!is.has(table) && !dropped.includes(table))
      problems.push(
        `the snapshot drops "${table}", the migration never drops it`,
      );
  for (const table of dropped)
    if (is.has(table))
      problems.push(
        `the migration drops "${table}", the snapshot still has it`,
      );

  /*
   * Only tables that survive the migration. Dropping a table takes its columns and indexes with it
   * without a statement naming any of them, and demanding one would be demanding SQL nobody writes.
   */
  for (const table of [...is].filter((name) => was.has(name))) {
    const columnsWas = columnNames(before, table);
    const columnsIs = columnNames(after, table);
    const named = (list: string[][], column: string) =>
      list.some(([on, which]) => on === table && which === column);

    for (const column of columnsIs)
      if (!columnsWas.has(column) && !named(columnsAdded, column))
        problems.push(
          `the snapshot adds "${table}"."${column}", the migration never adds it`,
        );
    for (const column of columnsWas)
      if (!columnsIs.has(column) && !named(columnsDropped, column))
        problems.push(
          `the snapshot drops "${table}"."${column}", the migration never drops it`,
        );
    for (const [on, column] of columnsAdded)
      if (on === table && !(columnsIs.has(column!) && !columnsWas.has(column!)))
        problems.push(
          `the migration adds "${table}"."${column}", the snapshot does not add it`,
        );
    for (const [on, column] of columnsDropped)
      if (on === table && !(columnsWas.has(column!) && !columnsIs.has(column!)))
        problems.push(
          `the migration drops "${table}"."${column}", the snapshot does not drop it`,
        );

    /*
     * AND WHAT THE ADDED COLUMN IS, not merely that it is there. See {@link declared}. Only columns
     * the snapshot really holds are asked — one it does not is already reported above, and asking
     * twice would name a single mistake in two sentences.
     */
    for (const [on, column, tail] of columnsAdded) {
      if (on !== table) continue;
      const added = columnIn(after, table, column!);
      if (!added) continue;
      const statement = declared(tail ?? "");
      if (added.type !== statement.type)
        problems.push(
          `the migration adds "${table}"."${column}" as ${statement.type}, the snapshot calls it ${added.type}`,
        );
      if ((added.notNull ?? false) !== statement.notNull)
        problems.push(
          `the migration adds "${table}"."${column}" ${statement.notNull ? "NOT NULL" : "nullable"}, the snapshot says the opposite`,
        );
    }

    const indexesWas = indexNames(before, table);
    const indexesIs = indexNames(after, table);
    for (const index of indexesIs)
      if (!indexesWas.has(index) && !indexesCreated.includes(index))
        problems.push(
          `the snapshot adds index "${index}" on "${table}", the migration never creates it`,
        );
    for (const index of indexesWas)
      if (!indexesIs.has(index) && !indexesDropped.includes(index))
        problems.push(
          `the snapshot drops index "${index}" on "${table}", the migration never drops it`,
        );
  }

  const indexes = everyIndexName(after);
  for (const index of indexesCreated)
    if (!indexes.has(index))
      problems.push(
        `the migration creates index "${index}", the snapshot lacks it`,
      );
  for (const index of indexesDropped)
    if (indexes.has(index))
      problems.push(
        `the migration drops index "${index}", the snapshot still has it`,
      );

  return problems;
};

describe("the migration journal", () => {
  test("stamps every migration later than the one before it", async () => {
    const entries = await readJournal();

    const outOfOrder = entries
      .map((entry, index) => ({ entry, previous: entries[index - 1] }))
      .filter(({ entry, previous }) => previous && entry.when <= previous.when)
      .map(
        ({ entry, previous }) =>
          `${entry.tag} (${entry.when}) is not after ${previous?.tag} (${previous?.when})`,
      );

    expect(outOfOrder).toEqual([]);
  });

  test("stamps nothing later than the moment this test runs", async () => {
    expect(stampedAhead(await readJournal(), Date.now())).toEqual([]);
  });

  test("would have caught the migration stamped a day past the one before it", () => {
    /*
     * The mistake from the header, reconstructed, because the check above can only see it on the
     * day it is made. `0012` was stamped `previous + 86_400_000` and then sat in the journal for
     * years; asking today whether it is in the future says no, and says nothing about whether the
     * guard works. So ask on the day it was written instead, which is the day CI would have run on
     * the change that introduced it, and pin the answer here where the clock cannot erode it.
     */
    const authored = 1_787_358_347_113;
    const entries: Entry[] = [
      { idx: 11, tag: "0011_drop_the_old_connector_tables", when: authored },
      {
        idx: 12,
        tag: "0012_truncate_is_not_a_way_around_append_only",
        when: authored + 86_400_000,
      },
    ];

    expect(stampedAhead(entries, authored)).toEqual([
      "0012_truncate_is_not_a_way_around_append_only is stamped 1787444747113, 86400000ms ahead of the clock",
    ]);
  });

  test("has an entry for every migration file, and a file for every entry", async () => {
    // A journal and a directory that disagree is the other way this goes wrong quietly: a file with
    // no entry never runs, and an entry with no file stops `migrate` dead.
    const files = (await readdir(directory))
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.replace(/\.sql$/, ""))
      .sort();

    const entries = await readJournal();

    expect(entries.map((entry) => entry.tag).sort()).toEqual(files);
  });

  test("names every entry after its own index", async () => {
    /*
     * `idx` is what the snapshot is named after and what orders the entries; the tag prefix is only
     * a label. A hand-written migration that disagrees with itself — `idx: 30` under the tag
     * `0031_...` — leaves every check that reads the prefix looking at the wrong file while
     * reporting success, so pin the two together before anything else trusts either.
     */
    const entries = await readJournal();

    const mislabelled = entries
      .filter(
        (entry) =>
          entry.tag.split("_")[0] !== String(entry.idx).padStart(4, "0"),
      )
      .map((entry) => `${entry.tag} is entry idx ${entry.idx}`);

    expect(mislabelled).toEqual([]);
  });

  test("has a snapshot for every migration, and a migration for every snapshot", async () => {
    /*
     * A third way this goes wrong quietly, and the one that bites the NEXT person rather than this
     * one. `generate` diffs the schema against the newest snapshot in `meta/`, so a migration that
     * ships without one leaves the previous snapshot as the newest: the columns it added are absent
     * from what `generate` compares against, and the next migration re-emits them. That migration
     * then fails on every database the first one already ran on, because `ADD COLUMN` is not
     * conditional. A hand-written migration needs a hand-written snapshot for the same reason a
     * generated one gets one for free.
     *
     * Both directions. A snapshot nothing claims is the same accident seen from the other side —
     * a migration deleted or renumbered without its snapshot, leaving `generate` to diff against a
     * schema no entry in the journal produces.
     */
    const snapshots = new Set(
      (await readdir(new URL("meta/", directory))).filter((name) =>
        name.endsWith("_snapshot.json"),
      ),
    );

    const entries = await readJournal();

    const missing = entries
      .map((entry) => ({ entry, snapshot: snapshotName(entry.idx) }))
      .filter(({ snapshot }) => !snapshots.has(snapshot))
      .map(({ entry, snapshot }) => `${entry.tag} has no meta/${snapshot}`);

    const claimed = new Set(entries.map((entry) => snapshotName(entry.idx)));
    const orphaned = [...snapshots]
      .filter((snapshot) => !claimed.has(snapshot))
      .map((snapshot) => `meta/${snapshot} belongs to no entry`)
      .sort();

    expect([...missing, ...orphaned]).toEqual([]);
  });

  test("has a snapshot that describes what its migration actually does", async () => {
    /*
     * Existing is not corresponding. The check above is satisfied by any file of the right name,
     * including last migration's snapshot copied forward and including one generated from a schema
     * this migration never produces — and a snapshot that lies is worse than one that is missing,
     * because a missing one at least re-emits statements that fail loudly, while a wrong one lets
     * `generate` emit a diff against a schema no database has ever been in.
     *
     * So read each migration against the pair of snapshots that bracket it and require the two to
     * say the same thing. Pure data migrations get held to this too, and get held to it hardest: a
     * backfill that moves no DDL must leave a snapshot with nothing changed in it.
     */
    const entries = await readJournal();

    const wrong: string[] = [];
    for (const entry of entries) {
      const sql = await readFile(
        new URL(`${entry.tag}.sql`, directory),
        "utf8",
      );
      const after = await readSnapshot(entry.idx);
      const before = entry.idx === 0 ? {} : await readSnapshot(entry.idx - 1);
      wrong.push(
        ...disagreements(sql, before, after).map(
          (problem) => `${entry.tag}: ${problem}`,
        ),
      );
    }

    expect(wrong).toEqual([]);
  });
});

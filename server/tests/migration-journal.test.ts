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
describe("the migration journal", () => {
  test("stamps every migration later than the one before it", async () => {
    const journal = JSON.parse(
      await readFile(
        new URL("../drizzle/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ) as { entries: { idx: number; tag: string; when: number }[] };

    const outOfOrder = journal.entries
      .map((entry, index) => ({ entry, previous: journal.entries[index - 1] }))
      .filter(({ entry, previous }) => previous && entry.when <= previous.when)
      .map(
        ({ entry, previous }) =>
          `${entry.tag} (${entry.when}) is not after ${previous?.tag} (${previous?.when})`,
      );

    expect(outOfOrder).toEqual([]);
  });

  test("stamps nothing in the future", async () => {
    /*
     * The specific mistake, named. A timestamp ahead of now passes the ordering check above on its
     * own, and then eats the next migration somebody writes. A day of slack absorbs a machine whose
     * clock is a little fast without absorbing a hand-typed "tomorrow".
     */
    const journal = JSON.parse(
      await readFile(
        new URL("../drizzle/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ) as { entries: { tag: string; when: number }[] };

    const limit = Date.now() + 86_400_000;
    const ahead = journal.entries
      .filter((entry) => entry.when > limit)
      .map((entry) => `${entry.tag} is stamped ${entry.when}, in the future`);

    expect(ahead).toEqual([]);
  });

  test("has an entry for every migration file, and a file for every entry", async () => {
    // A journal and a directory that disagree is the other way this goes wrong quietly: a file with
    // no entry never runs, and an entry with no file stops `migrate` dead.
    const directory = new URL("../drizzle/", import.meta.url);
    const files = (await readdir(directory))
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.replace(/\.sql$/, ""))
      .sort();

    const journal = JSON.parse(
      await readFile(new URL("meta/_journal.json", directory), "utf8"),
    ) as { entries: { tag: string }[] };

    expect(journal.entries.map((entry) => entry.tag).sort()).toEqual(files);
  });
});

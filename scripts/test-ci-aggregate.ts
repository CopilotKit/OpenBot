import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mergeTimings, totalOfShards } from "./test-floor";

/**
 * The `tests` check over the shards of the suite: every shard succeeded, every shard reported its
 * count, and the counts add up to the floor (see scripts/test-floor.ts).
 *
 * Usage: `SHARDS_RESULT=<the shard job's result> bun scripts/test-ci-aggregate.ts <directory> [timings]`,
 * where the directory holds what the shards wrote (`scripts/test-ci.ts` with TEST_COUNT_DIR set). A
 * directory that does not exist is read as no counts at all, which fails. With a second path, the
 * shards' per-file durations are also merged into it, a fresh scripts/test-timings.json.
 */

async function writeStderr(text: string) {
  if (!text) return;
  if (process.stderr.write(text)) return;
  await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
}

const [directory, timingsOutput] = process.argv.slice(2);
if (!directory) {
  await writeStderr(
    "Usage: SHARDS_RESULT=<result> bun scripts/test-ci-aggregate.ts <directory of shard counts> [merged timings]\n",
  );
  process.exit(2);
}

let names: string[] = [];
try {
  names = (await readdir(directory)).sort();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const read = (pick: (name: string) => boolean) =>
  Promise.all(
    names.filter(pick).map(async (name) => ({
      name,
      text: await readFile(join(directory, name), "utf8"),
    })),
  );

// The timings are an aid for balancing the next run, so they are merged even when the run failed,
// and a run is never failed over them.
if (timingsOutput) {
  const timings = await read(
    (name) => name.startsWith("timings-") && name.endsWith(".json"),
  );
  if (timings.length > 0) {
    try {
      await writeFile(
        timingsOutput,
        mergeTimings(timings.map((file) => file.text)),
      );
    } catch (error) {
      await writeStderr(`Could not merge the shards' timings: ${error}\n`);
    }
  }
}

const counts = await read(
  (name) => name.startsWith("shard-") && name.endsWith(".json"),
);
const verdict = totalOfShards(process.env.SHARDS_RESULT ?? "", counts);
await writeStderr(verdict.report);
if (!verdict.pass) process.exitCode = 1;

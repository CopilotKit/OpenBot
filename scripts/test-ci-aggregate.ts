import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { totalOfShards } from "./test-floor";

/**
 * The `tests` check over the shards of the suite: every shard succeeded, every shard reported its
 * count, and the counts add up to the floor (see scripts/test-floor.ts).
 *
 * Usage: `SHARDS_RESULT=<the shard job's result> bun scripts/test-ci-aggregate.ts <directory>`,
 * where the directory holds the count files the shards wrote (`scripts/test-ci.ts` with
 * TEST_COUNT_DIR set). A directory that does not exist is read as no counts at all, which fails.
 */

async function writeStderr(text: string) {
  if (!text) return;
  if (process.stderr.write(text)) return;
  await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
}

const directory = process.argv[2];
if (!directory) {
  await writeStderr(
    "Usage: SHARDS_RESULT=<result> bun scripts/test-ci-aggregate.ts <directory of shard counts>\n",
  );
  process.exit(2);
}

let names: string[] = [];
try {
  names = (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const files = await Promise.all(
  names.map(async (name) => ({
    name,
    text: await readFile(join(directory, name), "utf8"),
  })),
);

const verdict = totalOfShards(process.env.SHARDS_RESULT ?? "", files);
await writeStderr(verdict.report);
if (!verdict.pass) process.exitCode = 1;

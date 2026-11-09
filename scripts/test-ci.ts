import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  belowFloor,
  MINIMUM_TESTS,
  parseShard,
  type Shard,
  type ShardCount,
  shardCountFile,
  shardTimingsFile,
  TEST_TIMINGS,
  testsRan,
} from "./test-floor";

/**
 * The test run, with a floor under how much of it must actually execute (see scripts/test-floor.ts).
 *
 * Run whole, `bun run test:ci` checks the floor itself. Run as one shard of several, the way CI runs
 * it, the floor belongs to the suite and not to the shard, so this checks what a shard can check (its
 * tests passed and its count can be read) and writes the count for `scripts/test-ci-aggregate.ts`,
 * which adds the shards up in the `tests` check.
 *
 * The shard comes from `--shard=<index>/<count>` or from TEST_SHARD, and is passed through to
 * `bun test --shard`, balanced by the per-file durations in scripts/test-timings.json. With
 * TEST_COUNT_DIR set, the shard's count, and how long each of its files took, are written there,
 * one file each per shard.
 */

async function writeStderr(text: string) {
  if (!text) return;
  if (process.stderr.write(text)) return;
  await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
}

const shardArgument = process.argv
  .slice(2)
  .find((argument) => argument.startsWith("--shard="))
  ?.slice("--shard=".length);
const shardValue = shardArgument ?? process.env.TEST_SHARD?.trim();

let shard: Shard | undefined;
if (shardValue) {
  try {
    shard = parseShard(shardValue);
  } catch (error) {
    await writeStderr(`${(error as Error).message}\n`);
    process.exit(1);
  }
}

const countDirectory = process.env.TEST_COUNT_DIR?.trim();

// Shards are cut by time rather than by file count when there is a record of how long each file
// takes, because a few files take a minute each and dealt round-robin they land on the same runner.
// Bun reads every --timings file as one table and writes --update-timings to the first, so with a
// count directory the shard also records how long its own files took, for refreshing the record.
const timings: string[] = [];
if (shard) {
  const measured = countDirectory
    ? join(countDirectory, shardTimingsFile(shard))
    : undefined;
  if (measured) {
    await mkdir(countDirectory as string, { recursive: true });
    timings.push(`--timings=${measured}`);
  }
  if (existsSync(TEST_TIMINGS)) timings.push(`--timings=${TEST_TIMINGS}`);
  if (measured) timings.push("--update-timings");
}

// `bun run test` rather than `bun test`, so the pretest hook fires and the generated application
// config exists before route imports need it.
const proc = Bun.spawn(
  [
    "bun",
    "run",
    "test",
    ...(shard ? [`--shard=${shard.index}/${shard.count}`] : []),
    ...timings,
  ],
  {
    stdout: "inherit",
    stderr: "pipe",
  },
);

// Bun writes its summary to stderr, so it is captured and echoed rather than inherited.
const stderr = await new Response(proc.stderr).text();
await writeStderr(stderr);

const exitStatus = await proc.exited;
if (exitStatus !== 0) {
  process.exitCode = exitStatus;
} else {
  const count = testsRan(stderr);

  if (count === undefined) {
    await writeStderr(
      "\nCould not read how many tests ran from bun's output. Refusing to report a pass on a run that cannot be counted.\n",
    );
    process.exitCode = 1;
  } else if (shard) {
    if (countDirectory) {
      const record: ShardCount = {
        shard: shard.index,
        of: shard.count,
        tests: count,
      };
      await mkdir(countDirectory, { recursive: true });
      await writeFile(
        join(countDirectory, shardCountFile(shard)),
        `${JSON.stringify(record)}\n`,
      );
    }
    await writeStderr(
      `\n${count} tests ran in shard ${shard.index}/${shard.count}. The floor of ${MINIMUM_TESTS} is ` +
        "checked on all the shards together.\n",
    );
  } else if (count < MINIMUM_TESTS) {
    await writeStderr(`\n${belowFloor(count)}`);
    process.exitCode = 1;
  } else {
    await writeStderr(`\n${count} tests ran (floor ${MINIMUM_TESTS}).\n`);
  }
}

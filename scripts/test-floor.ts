/**
 * The floor under how much of the test suite must actually execute, and the rules for reading it,
 * shared by `scripts/test-ci.ts` (one run, or one shard of one) and `scripts/test-ci-aggregate.ts`
 * (the `tests` check over every shard).
 *
 * A test file that throws while it is being imported never runs its tests and never reports them as
 * failures; the file is simply absent from the totals. So the count is asserted as well as the
 * result. A drop is treated as a failure, because a smaller suite with no failure report gives false
 * coverage.
 *
 * The floor is deliberately a floor and not an exact number. Tests are added constantly and a check
 * that has to be edited for every new test is a check people learn to edit without thinking.
 *
 * In CI the suite runs in shards, and the floor is a property of the suite, so it is checked on the
 * sum of the shards and never on one shard: a shard does not know how big it is supposed to be.
 */

export const MINIMUM_TESTS = 400;

export interface Shard {
  /** From 1 to `count`. */
  index: number;
  count: number;
}

/** `2/4` as shard 2 of 4, the form `bun test --shard` takes. Throws on anything else. */
export function parseShard(value: string): Shard {
  const match = value.trim().match(/^(\d+)\/(\d+)$/);
  const index = match ? Number.parseInt(match[1] as string, 10) : 0;
  const count = match ? Number.parseInt(match[2] as string, 10) : 0;
  if (!match || index < 1 || count < 1 || index > count) {
    throw new Error(
      `"${value}" is not a shard. Write it as index/count, for example 2/4, with the index from 1 to the count.`,
    );
  }
  return { index, count };
}

/**
 * How many tests bun says it ran, from the `Ran N tests across M files.` line of its summary, or
 * undefined when there is no such line. The LAST one: a test that runs a nested suite and echoes its
 * output would otherwise be read in place of the run's own summary, which bun prints at the end.
 */
export function testsRan(stderr: string): number | undefined {
  const last = [...stderr.matchAll(/Ran (\d+) tests? across/g)].at(-1);
  return last ? Number.parseInt(last[1] as string, 10) : undefined;
}

/** Why a passing run that counted fewer than the floor is still a failure. */
export function belowFloor(count: number, where = ""): string {
  return (
    `${count} tests ran${where}, and at least ${MINIMUM_TESTS} were expected.\n\n` +
    "Every test passed, so this is not a failing test, it is a suite that got smaller. The usual\n" +
    "cause is a file that threw while being imported, which takes its tests with it and reports\n" +
    "nothing. Run `bun test` and look for an unhandled error between the file groups.\n\n" +
    "If tests were deliberately removed, lower MINIMUM_TESTS in scripts/test-floor.ts and say why.\n"
  );
}

/** What one shard reports, written by `scripts/test-ci.ts` and read by the aggregate. */
export interface ShardCount {
  shard: number;
  of: number;
  tests: number;
}

/** The file one shard's count is written to, distinct per shard so they can sit in one directory. */
export function shardCountFile({ index, count }: Shard): string {
  return `shard-${index}-of-${count}.json`;
}

/**
 * How long each test file takes, in bun's `--timings` format, which CI's shards are balanced by.
 * Relative to the repository root, where the suite runs. A file it does not name is counted as the
 * median, so it only needs refreshing when the balance drifts: the `tests` job of every CI run
 * uploads a fresh one as the `test-timings` artifact, to download over this file.
 */
export const TEST_TIMINGS = "scripts/test-timings.json";

/** The file one shard records its own files' durations to, next to its count. */
export function shardTimingsFile({ index, count }: Shard): string {
  return `timings-${index}-of-${count}.json`;
}

/**
 * The shards' duration records as one, sorted by path so a refresh diffs cleanly. Each shard
 * records only the files it ran, so together they cover the suite once.
 */
export function mergeTimings(texts: string[]): string {
  const files: Record<string, number> = {};
  for (const text of texts) {
    const parsed = JSON.parse(text) as { files?: Record<string, number> };
    Object.assign(files, parsed.files ?? {});
  }
  const sorted = Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return `${JSON.stringify({ version: 1, files: sorted }, null, 2)}\n`;
}

export type Verdict =
  | { pass: true; total: number; report: string }
  | { pass: false; report: string };

function readShardCount(text: string): ShardCount | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { shard, of, tests } = value as Record<string, unknown>;
  const whole = (n: unknown): n is number =>
    typeof n === "number" && Number.isSafeInteger(n);
  if (!whole(shard) || !whole(of) || !whole(tests)) return undefined;
  if (shard < 1 || of < shard || tests < 0) return undefined;
  return { shard, of, tests };
}

/**
 * The `tests` result over every shard. It passes only when the shards all succeeded, every shard
 * from 1 to the count reported exactly once, and the counts sum to at least the floor.
 *
 * `shardsResult` is the matrix job's result as GitHub Actions gives it to a job that needs it
 * (`success` only when every shard succeeded). `files` are the count records the shards uploaded.
 */
export function totalOfShards(
  shardsResult: string,
  files: { name: string; text: string }[],
): Verdict {
  if (shardsResult !== "success") {
    return {
      pass: false,
      report:
        `The test shards finished with "${shardsResult || "no result"}", not success, so the suite did\n` +
        "not pass. The shard that failed names the test in its own log.\n",
    };
  }

  if (files.length === 0) {
    return {
      pass: false,
      report:
        "No shard reported how many tests it ran. Refusing to report a pass on a run that cannot be\n" +
        "counted.\n",
    };
  }

  const counts: ShardCount[] = [];
  for (const { name, text } of files) {
    const count = readShardCount(text);
    if (!count) {
      return {
        pass: false,
        report: `Could not read a shard's count from ${name}: ${JSON.stringify(text.slice(0, 200))}\n`,
      };
    }
    counts.push(count);
  }

  const totals = [...new Set(counts.map((count) => count.of))];
  if (totals.length !== 1) {
    return {
      pass: false,
      report: `The shards disagree on how many shards there are: ${totals.sort((a, b) => a - b).join(", ")}.\n`,
    };
  }
  const of = totals[0] as number;

  const seen = new Map<number, number>();
  for (const count of counts)
    seen.set(count.shard, (seen.get(count.shard) ?? 0) + 1);
  const repeated = [...seen].filter(([, times]) => times > 1).map(([n]) => n);
  if (repeated.length > 0) {
    return {
      pass: false,
      report: `More than one count came from ${repeated.map((n) => `shard ${n} of ${of}`).join(", ")}.\n`,
    };
  }
  const missing = Array.from({ length: of }, (_, i) => i + 1).filter(
    (n) => !seen.has(n),
  );
  if (missing.length > 0) {
    return {
      pass: false,
      report:
        `No count came from ${missing.map((n) => `shard ${n} of ${of}`).join(", ")}. A shard that did\n` +
        "not report is a part of the suite nobody saw run.\n",
    };
  }

  const total = counts.reduce((sum, count) => sum + count.tests, 0);
  const where = ` across ${of} shards`;
  if (total < MINIMUM_TESTS) {
    return { pass: false, report: belowFloor(total, where) };
  }

  const each = [...counts]
    .sort((a, b) => a.shard - b.shard)
    .map((count) => `${count.shard}: ${count.tests}`)
    .join(", ");
  return {
    pass: true,
    total,
    report: `${total} tests ran${where} (floor ${MINIMUM_TESTS}; per shard ${each}).\n`,
  };
}

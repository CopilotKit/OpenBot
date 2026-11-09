import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MINIMUM_TESTS,
  parseShard,
  testsRan,
  totalOfShards,
} from "./test-floor";

// The rule the `tests` check applies over the shards. A shard is one runner's slice of the suite,
// and the floor has to hold for the suite, so it is checked on the sum and never shard by shard.

/** One shard's record, as `scripts/test-ci.ts` writes it. */
const record = (shard: number, of: number, tests: number) => ({
  name: `shard-${shard}-of-${of}.json`,
  text: `${JSON.stringify({ shard, of, tests })}\n`,
});

// Four shards of the run on main that this split replaced: 14779 tests across 1244 files.
const fourShards = [
  record(1, 4, 3702),
  record(2, 4, 3655),
  record(3, 4, 3810),
  record(4, 4, 3612),
];

describe("the floor over the shards", () => {
  test("shards that sum above the floor pass, and the total is reported", () => {
    const verdict = totalOfShards("success", fourShards);
    expect(verdict.pass).toBe(true);
    expect(verdict.report).toContain("14779 tests ran across 4 shards");
    expect(verdict.report).toContain(`floor ${MINIMUM_TESTS}`);
  });

  test("shards that each pass but sum below the floor fail, with the reason", () => {
    const verdict = totalOfShards("success", [
      record(1, 4, 120),
      record(2, 4, 95),
      record(3, 4, 101),
      record(4, 4, 80),
    ]);
    expect(verdict.pass).toBe(false);
    expect(verdict.report).toContain(
      `396 tests ran across 4 shards, and at least ${MINIMUM_TESTS} were expected.`,
    );
    expect(verdict.report).toContain(
      "a file that threw while being imported, which takes its tests with it",
    );
    expect(verdict.report).toContain("lower MINIMUM_TESTS");
  });

  test("exactly the floor passes", () => {
    const verdict = totalOfShards("success", [
      record(1, 2, MINIMUM_TESTS - 150),
      record(2, 2, 150),
    ]);
    expect(verdict.pass).toBe(true);
  });

  test("a failed shard fails the total, even with every other count in", () => {
    const verdict = totalOfShards("failure", fourShards.slice(0, 3));
    expect(verdict.pass).toBe(false);
    expect(verdict.report).toContain("failure");
  });

  test("a failed shard fails the total even when its count is somehow present", () => {
    expect(totalOfShards("failure", fourShards).pass).toBe(false);
  });

  test("cancelled or skipped shards are not a pass", () => {
    expect(totalOfShards("cancelled", fourShards).pass).toBe(false);
    expect(totalOfShards("skipped", fourShards).pass).toBe(false);
    expect(totalOfShards("", fourShards).pass).toBe(false);
  });

  test("a missing shard fails, and is named, even when the rest clear the floor", () => {
    const verdict = totalOfShards("success", [
      fourShards[0]!,
      fourShards[1]!,
      fourShards[3]!,
    ]);
    expect(verdict.pass).toBe(false);
    expect(verdict.report).toContain("shard 3 of 4");
  });

  test("no counts at all fails", () => {
    const verdict = totalOfShards("success", []);
    expect(verdict.pass).toBe(false);
    expect(verdict.report).toContain("No shard reported");
  });

  test("the same shard twice fails rather than being counted twice", () => {
    const verdict = totalOfShards("success", [
      record(1, 2, 300),
      { ...record(1, 2, 300), name: "copy.json" },
    ]);
    expect(verdict.pass).toBe(false);
    expect(verdict.report).toContain("shard 1 of 2");
  });

  test("shards that disagree on how many there are fail", () => {
    const verdict = totalOfShards("success", [
      record(1, 2, 3000),
      record(2, 3, 3000),
      record(3, 3, 3000),
    ]);
    expect(verdict.pass).toBe(false);
    expect(verdict.report).toContain("disagree");
  });

  test("a record that cannot be read fails and is named", () => {
    for (const text of [
      "",
      "{",
      '{"shard":1,"of":1}',
      '{"shard":1,"of":1,"tests":"3702"}',
      '{"shard":0,"of":1,"tests":3702}',
      '{"shard":2,"of":1,"tests":3702}',
      '{"shard":1,"of":1,"tests":-1}',
      '{"shard":1.5,"of":2,"tests":3702}',
      "null",
    ]) {
      const verdict = totalOfShards("success", [{ name: "bad.json", text }]);
      expect(verdict.pass).toBe(false);
      expect(verdict.report).toContain("bad.json");
    }
  });
});

describe("a shard", () => {
  test("reads as index/count", () => {
    expect(parseShard("1/4")).toEqual({ index: 1, count: 4 });
    expect(parseShard(" 4/4 ")).toEqual({ index: 4, count: 4 });
  });

  test("is refused when it is not one", () => {
    for (const value of ["", "4", "0/4", "5/4", "1/0", "a/4", "1/4/2", "-1/4"])
      expect(() => parseShard(value)).toThrow("index/count");
  });
});

describe("the count in bun's summary", () => {
  test("is read from a shard's summary", () => {
    const stderr = [
      "bun test v1.4.3 (6b9f6b5d)",
      "--shard=2/4: running 311/1244 test files",
      "",
      " 3611 pass",
      " 44 skip",
      " 0 fail",
      " 9071 expect() calls",
      "Ran 3655 tests across 311 files. [205.47s]",
    ].join("\n");
    expect(testsRan(stderr)).toBe(3655);
  });

  test("is the last summary, not one a test echoed from a nested run", () => {
    const stderr = [
      "scripts/some-nested.test.ts:",
      "Ran 3 tests across 1 file. [12.00ms]",
      "(pass) runs a nested suite [40.12ms]",
      "",
      " 1 pass",
      " 0 fail",
      "Ran 1 test across 1 file. [80.00ms]",
    ].join("\n");
    expect(testsRan(stderr)).toBe(1);
  });

  test("is absent when bun printed no summary", () => {
    expect(testsRan('error: script "test" exited with code 1\n')).toBe(
      undefined,
    );
  });
});

// The scripts end to end, the way CI runs them: a real `bun test --shard` in a throwaway project,
// and the aggregate reading what the shards wrote.

const createdDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  createdDirectories.push(directory);
  return directory;
}

/** The environment without the shard CI handed the outer run, so a nested run is never sharded. */
function cleanEnvironment(extra: Record<string, string>) {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.TEST_SHARD;
  delete env.TEST_COUNT_DIR;
  return { ...env, ...extra };
}

async function run(
  command: string[],
  cwd: string,
  env: Record<string, string | undefined>,
) {
  const proc = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stderr, stdout };
}

async function projectWithTests(files: Record<string, number>) {
  const directory = await temporaryDirectory("openbot-test-shard-");
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ scripts: { test: "bun test" } }),
  );
  for (const [name, tests] of Object.entries(files)) {
    const body = Array.from(
      { length: tests },
      (_, index) => `test("${name} ${index}", () => expect(1).toBe(1));`,
    ).join("\n");
    await writeFile(
      join(directory, name),
      `import { expect, test } from "bun:test";\n${body}\n`,
    );
  }
  return directory;
}

describe("scripts/test-ci.ts on a shard", () => {
  test("runs only its shard and writes the count where the total can read it", async () => {
    // Sorted by path and dealt round-robin: a and c to shard 1, b to shard 2.
    const project = await projectWithTests({
      "a.test.ts": 3,
      "b.test.ts": 5,
      "c.test.ts": 2,
    });
    const counts = join(project, "counts");

    for (const [shard, expected] of [
      ["1/2", 5],
      ["2/2", 5],
    ] as const) {
      const result = await run(
        ["bun", join(import.meta.dir, "test-ci.ts")],
        project,
        cleanEnvironment({ TEST_SHARD: shard, TEST_COUNT_DIR: counts }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(`--shard=${shard}`);
      expect(result.stderr).toContain(
        `${expected} tests ran in shard ${shard}`,
      );
    }

    expect((await readdir(counts)).sort()).toEqual([
      "shard-1-of-2.json",
      "shard-2-of-2.json",
      "timings-1-of-2.json",
      "timings-2-of-2.json",
    ]);
    expect(
      JSON.parse(await readFile(join(counts, "shard-1-of-2.json"), "utf8")),
    ).toEqual({ shard: 1, of: 2, tests: 5 });

    // Ten tests in all is below the floor, which only the total can see.
    const merged = join(project, "test-timings.json");
    const total = await run(
      ["bun", join(import.meta.dir, "test-ci-aggregate.ts"), counts, merged],
      project,
      cleanEnvironment({ SHARDS_RESULT: "success" }),
    );
    expect(total.exitCode).toBe(1);
    expect(total.stderr).toContain(
      `10 tests ran across 2 shards, and at least ${MINIMUM_TESTS} were expected.`,
    );

    // Each shard recorded only its own files, and together they are the suite, once.
    const timings = JSON.parse(await readFile(merged, "utf8"));
    expect(timings.version).toBe(1);
    expect(Object.keys(timings.files)).toEqual([
      "a.test.ts",
      "b.test.ts",
      "c.test.ts",
    ]);
  });

  test("with a record of how long files take, shards are cut by time instead", async () => {
    const project = await projectWithTests({
      "a.test.ts": 3,
      "b.test.ts": 5,
      "c.test.ts": 2,
      "d.test.ts": 4,
    });
    // c takes three times as long as any other file. Bun keeps neighbouring files together, so the
    // even cut by time is a and b (8 tests) against c and d (6). Round-robin would deal a and c
    // (5 tests) against b and d (9).
    await mkdir(join(project, "scripts"));
    await writeFile(
      join(project, "scripts/test-timings.json"),
      JSON.stringify({
        version: 1,
        files: {
          "a.test.ts": 1000,
          "b.test.ts": 1000,
          "c.test.ts": 3000,
          "d.test.ts": 1000,
        },
      }),
    );
    for (const [shard, expected] of [
      ["1/2", 8],
      ["2/2", 6],
    ] as const) {
      const result = await run(
        ["bun", join(import.meta.dir, "test-ci.ts")],
        project,
        cleanEnvironment({ TEST_SHARD: shard }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(
        `${expected} tests ran in shard ${shard}`,
      );
    }
  });

  test("the shard can be passed as an argument", async () => {
    const project = await projectWithTests({ "a.test.ts": 1, "b.test.ts": 2 });
    const result = await run(
      ["bun", join(import.meta.dir, "test-ci.ts"), "--shard=2/2"],
      project,
      cleanEnvironment({}),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("2 tests ran in shard 2/2");
  });

  test("a failing test fails its shard and writes no count", async () => {
    const project = await projectWithTests({ "a.test.ts": 2 });
    await writeFile(
      join(project, "b.test.ts"),
      'import { expect, test } from "bun:test";\ntest("red", () => expect(1).toBe(2));\n',
    );
    const counts = join(project, "counts");
    const result = await run(
      ["bun", join(import.meta.dir, "test-ci.ts")],
      project,
      cleanEnvironment({ TEST_SHARD: "2/2", TEST_COUNT_DIR: counts }),
    );
    expect(result.exitCode).not.toBe(0);
    const written = await readdir(counts).catch(() => [] as string[]);
    expect(written.filter((name) => name.startsWith("shard-"))).toEqual([]);
  });

  test("a shard that is not one is refused before anything runs", async () => {
    const project = await projectWithTests({ "a.test.ts": 1 });
    const result = await run(
      ["bun", join(import.meta.dir, "test-ci.ts")],
      project,
      cleanEnvironment({ TEST_SHARD: "5/4" }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("index/count");
    expect(result.stderr).not.toContain("bun test v");
  });
});

describe("CI's wiring of the shards to the total", () => {
  /** A GitHub Actions expression, written so the linter does not read it as a template literal. */
  const expression = (value: string) => ["$", "{{ ", value, " }}"].join("");
  type Job = {
    name?: string;
    if?: string;
    needs?: string[];
    strategy?: { matrix?: { shard?: number[] } };
    steps?: { uses?: string; run?: string; with?: Record<string, string> }[];
  };
  const jobs = (
    Bun.YAML.parse(
      readFileSync(
        join(import.meta.dir, "../.github/workflows/ci.yml"),
        "utf8",
      ),
    ) as { jobs: Record<string, Job> }
  ).jobs;

  test("every shard from 1 to the count runs, and each is told which it is", () => {
    const shards = jobs.test!.strategy!.matrix!.shard!;
    expect(shards).toEqual(shards.map((_, index) => index + 1));
    const handOver = jobs.test!.steps!.find((step) =>
      step.uses?.endsWith("/.github/actions/test-shard"),
    );
    expect(handOver?.with?.shard).toBe(
      `${expression("matrix.shard")}/${expression("strategy.job-total")}`,
    );
  });

  // Skipped would read as a pass to anything that requires the check.
  test("the total is the `tests` check, runs even when a shard failed, and verify needs it", () => {
    const total = jobs["test-total"]!;
    expect(total.name).toBe("tests");
    expect(total.needs).toEqual(["test"]);
    expect(total.if).toBe("always()");
    expect(jobs.verify!.needs).toContain("test-total");
    expect(jobs.verify!.needs).toContain("test");
  });
});

describe("scripts/test-ci-aggregate.ts", () => {
  async function totalOf(
    shardsResult: string,
    records: { name: string; text: string }[],
  ) {
    const directory = await temporaryDirectory("openbot-test-counts-");
    for (const { name, text } of records)
      await writeFile(join(directory, name), text);
    return run(
      ["bun", join(import.meta.dir, "test-ci-aggregate.ts"), directory],
      directory,
      cleanEnvironment({ SHARDS_RESULT: shardsResult }),
    );
  }

  test("passes four shards above the floor", async () => {
    const result = await totalOf("success", fourShards);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("14779 tests ran across 4 shards");
  });

  test("fails a failed shard", async () => {
    const result = await totalOf("failure", fourShards.slice(0, 3));
    expect(result.exitCode).toBe(1);
  });

  test("fails a missing shard", async () => {
    const result = await totalOf("success", fourShards.slice(1));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("shard 1 of 4");
  });

  test("fails when the counts directory was never created", async () => {
    const result = await run(
      [
        "bun",
        join(import.meta.dir, "test-ci-aggregate.ts"),
        join(tmpdir(), "openbot-no-such-counts-directory"),
      ],
      tmpdir(),
      cleanEnvironment({ SHARDS_RESULT: "success" }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No shard reported");
  });
});

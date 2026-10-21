export {};

/**
 * `server/tests` in shards, because the whole directory in one process no longer runs.
 *
 * Around a hundred of those files open a module-scope connection pool. PostgreSQL's default
 * `max_connections` is 100, so a single `bun test server/tests` exhausts the server's connection
 * slots during the import phase and dies with `sorry, too many clients already` BEFORE it reports
 * anything. That is a harness ceiling, not a regression, and it is never a reason to change source.
 *
 * Shards keep the pools-per-process count under the ceiling. The suite is split into fixed-size
 * groups of files and each group runs in its own `bun test` invocation, so each process opens its
 * own pools and gives them back when it exits.
 *
 * Why this script exists at all, rather than a remembered shell incantation: a sharded sweep is the
 * only thing that has ever caught a test file that went red and stayed red. A targeted run passes,
 * `typecheck` passes (`server/tests` is outside `tsc`), a reviewer reads the diff and sees nothing,
 * and the branch is red the whole time. The sweep belongs at every quality gate, and a check that
 * has to be retyped from memory at every gate is a check that gets skipped.
 *
 * Two deliberate properties:
 *
 * - **Every shard's summary line is read, and the exit code comes from `bun test` itself.** Piping
 *   bun's output through `grep` or `tail` overwrites `$?` with the pipe's status, which is how a
 *   failing shard reports success. Each shard's stderr is captured and echoed VERBATIM so a failure
 *   message survives in full for diagnosis.
 * - **A shard whose summary cannot be parsed fails the run.** A pass that cannot be counted is not
 *   a pass; an import-time throw takes its file's tests with it and reports no failure.
 *
 * Usage: `bun run test:server:sharded`, with `TEST_DATABASE_URL` set for the integration suites.
 * `SHARD_SIZE` overrides the files-per-shard count.
 */

const SHARD_SIZE = Number.parseInt(process.env.SHARD_SIZE ?? "55", 10);

async function writeStderr(text: string) {
  if (!text) return;
  if (process.stderr.write(text)) return;
  await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
}

if (!process.env.TEST_DATABASE_URL?.trim()) {
  await writeStderr(
    "TEST_DATABASE_URL is empty or unset. The integration suites would each fail to connect, which\n" +
      "looks like a hundred broken tests rather than one missing variable. Run this as\n" +
      "TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_test bun run test:server:sharded\n",
  );
  process.exit(1);
}

const files = (
  await Array.fromAsync(
    new Bun.Glob("server/tests/**/*.test.ts").scan({ cwd: process.cwd() }),
  )
).sort();

if (files.length === 0) {
  await writeStderr(
    "No test files matched server/tests/**/*.test.ts. Refusing to report a pass.\n",
  );
  process.exit(1);
}

const shards: string[][] = [];
for (let index = 0; index < files.length; index += SHARD_SIZE) {
  shards.push(files.slice(index, index + SHARD_SIZE));
}

// `bun run generate:app-config` once, up front, rather than per shard: the `pretest` hook that
// normally produces it fires for `bun run test`, and these shards invoke `bun test` directly.
const config = Bun.spawn(["bun", "run", "generate:app-config"], {
  stdout: "inherit",
  stderr: "inherit",
});
if ((await config.exited) !== 0) {
  await writeStderr(
    "\nCould not generate the application config, so route imports would fail.\n",
  );
  process.exit(1);
}

await writeStderr(
  `\nRunning ${files.length} files in ${shards.length} shards of up to ${SHARD_SIZE}.\n`,
);

let passed = 0;
let failed = 0;
let skipped = 0;
const unreadable: number[] = [];
const red: number[] = [];

for (const [index, shard] of shards.entries()) {
  await writeStderr(
    `\n--- shard ${index + 1}/${shards.length} (${shard.length} files) ---\n`,
  );

  const proc = Bun.spawn(["bun", "test", ...shard], {
    stdout: "inherit",
    stderr: "pipe",
  });

  // Bun writes its summary to stderr, so it is captured to be parsed, then echoed unmodified.
  const stderr = await new Response(proc.stderr).text();
  await writeStderr(stderr);

  // Read the status from the process, never from the text: a parse failure and a test failure are
  // different outcomes and both have to be reported.
  const exitStatus = await proc.exited;
  if (exitStatus !== 0) red.push(index + 1);

  const passMatch = stderr.match(/(\d+) pass/);
  const failMatch = stderr.match(/(\d+) fail/);
  const skipMatch = stderr.match(/(\d+) skip/);

  if (!passMatch) {
    unreadable.push(index + 1);
  } else {
    passed += Number.parseInt(passMatch[1] as string, 10);
    failed += failMatch ? Number.parseInt(failMatch[1] as string, 10) : 0;
    skipped += skipMatch ? Number.parseInt(skipMatch[1] as string, 10) : 0;
  }
}

await writeStderr(
  `\n=== ${shards.length} shards: ${passed} pass / ${failed} fail / ${skipped} skip ===\n`,
);

if (red.length > 0) {
  await writeStderr(`Shards that exited non-zero: ${red.join(", ")}.\n`);
  process.exitCode = 1;
}

if (unreadable.length > 0) {
  await writeStderr(
    `Could not read a summary line from shard(s) ${unreadable.join(", ")}. Refusing to report a\n` +
      "pass on a run that cannot be counted: the usual cause is a file that threw while being\n" +
      "imported, which takes its tests with it and reports nothing.\n",
  );
  process.exitCode = 1;
}

export {};

/**
 * The test run, with a floor under how much of it must actually execute.
 *
 * A test file that throws while it is being imported never runs its tests and never reports them as
 * failures; the file is simply absent from the totals.
 *
 * This asserts the count as well as the result. A drop is treated as a failure, because a smaller
 * suite with no failure report gives false coverage.
 *
 * The floor is deliberately a floor and not an exact number. Tests are added constantly and a check
 * that has to be edited for every new test is a check people learn to edit without thinking.
 */

const MINIMUM_TESTS = 400;

async function writeStderr(text: string) {
  if (!text) return;
  if (process.stderr.write(text)) return;
  await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
}

// `bun run test` rather than `bun test`, so the pretest hook fires and the generated application
// config exists before route imports need it.
const proc = Bun.spawn(["bun", "run", "test"], {
  stdout: "inherit",
  stderr: "pipe",
});

// Bun writes its summary to stderr, so it is captured and echoed rather than inherited.
const stderr = await new Response(proc.stderr).text();
await writeStderr(stderr);

const exitStatus = await proc.exited;
if (exitStatus !== 0) {
  process.exitCode = exitStatus;
} else {
  const ran = stderr.match(/Ran (\d+) tests? across/);
  const count = ran ? Number.parseInt(ran[1] as string, 10) : 0;

  if (!ran) {
    await writeStderr(
      "\nCould not read how many tests ran from bun's output. Refusing to report a pass on a run that cannot be counted.\n",
    );
    process.exitCode = 1;
  } else if (count < MINIMUM_TESTS) {
    await writeStderr(
      `\n${count} tests ran, and at least ${MINIMUM_TESTS} were expected.\n\n` +
        "Every test passed, so this is not a failing test, it is a suite that got smaller. The usual\n" +
        "cause is a file that threw while being imported, which takes its tests with it and reports\n" +
        "nothing. Run `bun test` and look for an unhandled error between the file groups.\n\n" +
        `If tests were deliberately removed, lower MINIMUM_TESTS in scripts/test-ci.ts and say why.\n`,
    );
    process.exitCode = 1;
  } else {
    await writeStderr(`\n${count} tests ran (floor ${MINIMUM_TESTS}).\n`);
  }
}

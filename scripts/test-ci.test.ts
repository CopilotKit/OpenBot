import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

const createdDirectories: string[] = [];
const expectedTail =
  "SYNTHETIC_EXPECTED_TAIL: preserve the child failure details";

async function createProjectWithFailingTest() {
  const directory = await mkdtemp(join(tmpdir(), "openbot-test-ci-"));
  createdDirectories.push(directory);
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ scripts: { test: "bun synthetic-child.ts" } }),
  );
  await writeFile(
    join(directory, "synthetic-child.ts"),
    String.raw`
export {};

const stderr = [
  "start of child stderr",
  ...Array.from(
    { length: 5000 },
    (_, index) => "filler-" + String(index).padStart(5, "0") + ": " + "x".repeat(200),
  ),
  "SYNTHETIC_EXPECTED_TAIL: preserve the child failure details",
].join("\n") + "\n";

if (!process.stderr.write(stderr)) {
  await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
}
process.exitCode = 7;
`,
  );
  return directory;
}

async function runBun(directory: string, script: string) {
  const proc = Bun.spawn(["bun", script], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stderr, stdout };
}

async function runBunThroughLogPipe(directory: string, script: string) {
  const proc = Bun.spawn(
    ["bash", "-o", "pipefail", "-c", 'bun "$1" 2>&1 | cat', "bash", script],
    {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stderr, stdout };
}

afterEach(async () => {
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

test("preserves the child stderr tail before returning the child status", async () => {
  const directory = await createProjectWithFailingTest();

  const child = await runBun(directory, "synthetic-child.ts");
  expect(child.exitCode).toBe(7);
  expect(child.stdout).toBe("");
  expect(child.stderr).toContain(expectedTail);

  const fixedWrapper = await runBunThroughLogPipe(
    directory,
    join(import.meta.dir, "test-ci.ts"),
  );
  expect(fixedWrapper.exitCode).toBe(7);
  expect(fixedWrapper.stderr).toBe("");
  expect(fixedWrapper.stdout).toContain(expectedTail);
  expect(fixedWrapper.stdout).toContain(
    'error: script "test" exited with code 7',
  );
});

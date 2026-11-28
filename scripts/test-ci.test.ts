import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

async function runBun(directory: string, script: string, args: string[] = []) {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.TEST_SHARD;
  delete env.TEST_COUNT_DIR;
  const proc = Bun.spawn(["bun", script, ...args], {
    cwd: directory,
    env,
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
  // Without the shard CI hands the outer run, so this nested run is the whole synthetic project.
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.TEST_SHARD;
  delete env.TEST_COUNT_DIR;
  const proc = Bun.spawn(
    ["bash", "-o", "pipefail", "-c", 'bun "$1" 2>&1 | cat', "bash", script],
    {
      cwd: directory,
      env,
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

test("CI discovery runs production tests without importing Workbench or fake-native tests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openbot-test-ci-discovery-"));
  createdDirectories.push(directory);
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      scripts: {
        pretest:
          'bun -e \'require("node:fs").writeFileSync("pretest-ran", "yes")\'',
        test: "bun test",
      },
    }),
  );
  await writeFile(
    join(directory, "bunfig.toml"),
    '[test]\npathIgnorePatterns = ["agent-langgraph-ts/**"]\n',
  );
  await mkdir(join(directory, "src"));
  await writeFile(
    join(directory, "src/production.test.ts"),
    `import {expect,test} from "bun:test";
import {readFileSync,writeFileSync} from "node:fs";
test("production test really executes",()=>{expect(readFileSync("pretest-ran","utf8")).toBe("yes");writeFileSync("production-ran","yes")});`,
  );
  const forbidden = [
    "workbench",
    "app/workbench/nested",
    "fakeNative",
    "desktop/src/fakeNative",
    "agent-langgraph-ts",
  ];
  for (const path of forbidden) {
    await mkdir(join(directory, path), { recursive: true });
    await writeFile(
      join(directory, path, "must-not-import.test.ts"),
      `throw new Error("CI imported ${path}");`,
    );
  }
  // One shard bypasses only the aggregate floor, so this small project exercises real discovery
  // and the pretest hook without changing the production suite's minimum count.
  const result = await runBun(directory, join(import.meta.dir, "test-ci.ts"), [
    "--shard=1/1",
  ]);
  expect(result.stderr).not.toContain("CI imported");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("1 tests ran in shard 1/1");
  expect(await readFile(join(directory, "production-ran"), "utf8")).toBe("yes");
});

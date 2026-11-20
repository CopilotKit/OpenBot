/**
 * Runs the test files ci.yml's `changes` job picked (scripts/ci-changes.ts), for `tests (changed
 * files)`: the suite's tests with `bun test`, and the browser tests in a real browser, the way
 * `app (real browser)` and its WebKit and desktop setup window jobs run them.
 *
 * Each group has to pass and has to run at least one test: a file that throws while it is imported
 * registers nothing and would otherwise pass, which is the failure the suite's floor guards against
 * (scripts/test-floor.ts).
 *
 * Env, each a JSON array of paths from the repository root: TESTS, BROWSER_TESTS, WEBKIT_TESTS (the
 * browser tests that also want WebKit) and DESKTOP_BROWSER_TESTS (run from desktop/).
 */
import { existsSync, lstatSync } from "node:fs";
import { isBunTest, unusualPath } from "./ci-changes";
import { testsRan } from "./test-floor";

/** A path from the changes job, held to being a test file inside this checkout. */
export function testPaths(json: string | undefined, name: string): string[] {
  const parsed: unknown = JSON.parse(json || "[]");
  if (!Array.isArray(parsed)) throw new Error(`${name} is not a JSON array`);
  return parsed.map((path) => {
    if (
      typeof path !== "string" ||
      !isBunTest(path) ||
      path.startsWith("/") ||
      path.split("/").includes("..") ||
      unusualPath(path)
    ) {
      throw new Error(
        `${name} holds ${JSON.stringify(path)}, which is not a test file here`,
      );
    }
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      throw new Error(
        `${name} holds ${path}, which is not a file in this checkout`,
      );
    }
    return path;
  });
}

async function runGroup(
  label: string,
  command: string[],
  files: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<boolean> {
  if (files.length === 0) return true;
  console.log(`\n${label}: ${files.join(" ")}`);
  const proc = Bun.spawn([...command, ...files], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: "inherit",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  process.stderr.write(stderr);
  const status = await proc.exited;
  if (status !== 0) return false;
  const count = testsRan(stderr);
  if (!count) {
    console.error(
      `\n${label}: ${count === 0 ? "no test ran" : "could not read how many tests ran"}. A file that throws while it is imported registers nothing, so this is a failure.`,
    );
    return false;
  }
  console.log(`\n${label}: ${count} tests ran.`);
  return true;
}

if (import.meta.main) {
  const tests = testPaths(process.env.TESTS, "TESTS");
  const webkit = new Set(testPaths(process.env.WEBKIT_TESTS, "WEBKIT_TESTS"));
  const browser = testPaths(process.env.BROWSER_TESTS, "BROWSER_TESTS");
  const desktop = testPaths(
    process.env.DESKTOP_BROWSER_TESTS,
    "DESKTOP_BROWSER_TESTS",
  );
  if (desktop.some((path) => !path.startsWith("desktop/"))) {
    throw new Error("DESKTOP_BROWSER_TESTS holds a path outside desktop/");
  }
  // `./` so no file name can read as a flag.
  const own = (paths: string[]) => paths.map((path) => `./${path}`);
  const browserEnv = { OPENBOT_APP_BROWSER: "1" };
  const results = [
    // `bun run test`, so the pretest hook writes the generated app config the tests import.
    await runGroup("Changed tests", ["bun", "run", "test"], own(tests)),
    await runGroup(
      "Changed browser tests",
      ["bun", "run", "test"],
      own(browser.filter((path) => !webkit.has(path))),
      { env: browserEnv },
    ),
    await runGroup(
      "Changed browser tests, in Chromium and WebKit",
      ["bun", "run", "test"],
      own(browser.filter((path) => webkit.has(path))),
      { env: { ...browserEnv, OPENBOT_APP_ENGINES: "chromium,webkit" } },
    ),
    await runGroup(
      "Changed desktop browser tests",
      ["bun", "test"],
      desktop.map((path) => `./${path.slice("desktop/".length)}`),
      { cwd: "desktop", env: browserEnv },
    ),
  ];
  if (results.some((passed) => !passed)) process.exitCode = 1;
}

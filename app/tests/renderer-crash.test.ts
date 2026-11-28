import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * A real-browser test the browser's renderer crashed in runs once more; nothing else does.
 *
 * The real-browser files take `test` from renderer-crash.ts, because WebKit on Linux crashes its own
 * renderer under CI's load and failed tests for nothing they check. This runs tests written that way
 * (renderer-crash.fixture.ts) in a process of their own, in Chromium, whose `chrome://crash` crashes
 * the renderer on purpose, and reads what ran: a test the renderer crashed in once passes on its
 * second go, a test that fails any other way fails on its first, and one that crashes every time
 * fails after two.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/renderer-crash.test.ts
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

describe.skipIf(!asked)("a renderer crash in a real-browser test", () => {
  test("is run once more; any other failure is not", async () => {
    const run = Bun.spawn(
      ["bun", "test", join(import.meta.dir, "renderer-crash.fixture.ts")],
      {
        cwd: join(import.meta.dir, "..", ".."),
        env: { ...process.env, OPENBOT_APP_BROWSER: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const said = `${await new Response(run.stdout).text()}${await new Response(run.stderr).text()}`;
    await run.exited;
    const goes = (name: string) =>
      said.split("\n").filter((line) => line.startsWith(`[go] ${name} `))
        .length;
    // Bun names a failed test in its output, and a passed one only on a terminal: a test that ran
    // and is not named failed is one that passed.
    const result = (name: string) =>
      said.split("\n").some((line) => line.startsWith(`(fail) ${name} [`))
        ? "fail"
        : goes(name) > 0
          ? "pass"
          : "never ran";

    expect(result("crashes once")).toBe("pass");
    expect(goes("crashes once")).toBe(2);
    expect(result("crashes once, through skipIf")).toBe("pass");
    expect(goes("crashes once, through skipIf")).toBe(2);
    // An assertion that fails is the test's, at once.
    expect(result("fails without a crash")).toBe("fail");
    expect(goes("fails without a crash")).toBe(1);
    // A second crash is not run again.
    expect(result("crashes every time")).toBe("fail");
    expect(goes("crashes every time")).toBe(2);
    expect(said).toContain(
      "The browser's renderer crashed during this test, so it runs once more.",
    );
  }, 120_000);
});

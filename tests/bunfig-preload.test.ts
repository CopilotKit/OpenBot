import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The two bunfig.toml files, held against each other.
 *
 * Bun reads bunfig.toml from the current working directory and nowhere else, so the root one does
 * not cover `bun test` run from inside `app`, which has its own. Every extra file is another thing
 * to forget: a preload added to one and not the other reintroduces exactly the failure the preload
 * exists to prevent, and reintroduces it silently, because a test file that throws while being
 * imported reports nothing at all. `app` went without one, and from inside it every test that opens
 * a Dialog timed out waiting for a dialog Base UI never mounted.
 *
 * So the drift is asserted away rather than documented away. Each list is resolved against its
 * own file's directory and compared as absolute paths, which is the comparison that matters: they
 * are meant to name the same scripts, not to contain the same strings.
 */

const repositoryRoot = resolve(import.meta.dir, "..");

function preloadedScripts(bunfigPath: string): string[] {
  const parsed = Bun.TOML.parse(readFileSync(bunfigPath, "utf8")) as {
    test?: { preload?: string[] };
  };
  const declared = parsed.test?.preload ?? [];
  return declared.map((entry) => resolve(dirname(bunfigPath), entry)).sort();
}

describe("bunfig preload", () => {
  const rootBunfig = resolve(repositoryRoot, "bunfig.toml");

  /*
   * Every package whose tests render Base UI and are run from inside it as well as from the root. The extension went
   * without one too: from inside extension/ the popup's Discard dialog never mounted, and its two tests failed there
   * while passing from the root.
   */
  for (const directory of ["app", "extension"]) {
    test(`the root and ${directory} configs preload the same scripts`, () => {
      const bunfig = resolve(repositoryRoot, directory, "bunfig.toml");
      expect(existsSync(bunfig)).toBe(true);
      expect(preloadedScripts(bunfig)).toEqual(preloadedScripts(rootBunfig));
    });
  }

  /*
   * The desktop runs its own tests from inside desktop/ too, with all of the root's preloads but the
   * network guard, and the app's preload through tests/support/app-preload-if-installed.ts, which
   * leaves it out where only desktop/ is installed (desktop/bunfig.toml says why).
   */
  test("the desktop config preloads the root's scripts but the network guard", () => {
    const bunfig = resolve(repositoryRoot, "desktop", "bunfig.toml");
    const guard = resolve(repositoryRoot, "tests/support/network-guard.ts");
    const appPreload = resolve(repositoryRoot, "app/tests/preload.ts");
    const appPreloadIfInstalled = resolve(
      repositoryRoot,
      "tests/support/app-preload-if-installed.ts",
    );
    expect(preloadedScripts(bunfig)).toEqual(
      preloadedScripts(rootBunfig)
        .filter((script) => script !== guard)
        .map((script) =>
          script === appPreload ? appPreloadIfInstalled : script,
        )
        .sort(),
    );
  });

  test("every preloaded script exists", () => {
    const scripts = preloadedScripts(rootBunfig);

    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(existsSync(script)).toBe(true);
    }
  });
});

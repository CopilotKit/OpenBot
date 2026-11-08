import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The three bunfig.toml files, held against each other.
 *
 * Bun reads bunfig.toml from the current working directory and nowhere else, so the root one does
 * not cover `bun test` run from inside `server` or `app`, and each of those has its own. Every extra
 * file is another thing to forget: a preload added to one and not the others reintroduces exactly
 * the failure the preload exists to prevent, and reintroduces it silently, because a test file that
 * throws while being imported reports nothing at all. `app` went without one, and from inside it
 * every test that opens a Dialog timed out waiting for a dialog Base UI never mounted.
 *
 * So the drift is asserted away rather than documented away. Each list is resolved against its
 * own file's directory and compared as absolute paths, which is the comparison that matters: they
 * are meant to name the same scripts, not to contain the same strings.
 */

const repositoryRoot = resolve(import.meta.dir, "..", "..");

function preloadedScripts(bunfigPath: string): string[] {
  const parsed = Bun.TOML.parse(readFileSync(bunfigPath, "utf8")) as {
    test?: { preload?: string[] };
  };
  const declared = parsed.test?.preload ?? [];
  return declared.map((entry) => resolve(dirname(bunfigPath), entry)).sort();
}

describe("bunfig preload", () => {
  const rootBunfig = resolve(repositoryRoot, "bunfig.toml");
  const serverBunfig = resolve(repositoryRoot, "server", "bunfig.toml");
  const appBunfig = resolve(repositoryRoot, "app", "bunfig.toml");

  test("the root and server configs preload the same scripts", () => {
    expect(preloadedScripts(serverBunfig)).toEqual(
      preloadedScripts(rootBunfig),
    );
  });

  test("the root and app configs preload the same scripts", () => {
    expect(existsSync(appBunfig)).toBe(true);
    expect(preloadedScripts(appBunfig)).toEqual(preloadedScripts(rootBunfig));
  });

  test("every preloaded script exists", () => {
    const scripts = preloadedScripts(rootBunfig);

    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(existsSync(script)).toBe(true);
    }
  });
});

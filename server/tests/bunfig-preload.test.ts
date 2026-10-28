import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The two bunfig.toml files, held against each other.
 *
 * Bun reads bunfig.toml from the current working directory and nowhere else, so the root one does
 * not cover `bun test` run from inside `server`, and there has to be a second one here. A second
 * file is a second thing to forget: a preload added to one and not the other reintroduces exactly
 * the failure the preload exists to prevent, and reintroduces it silently, because a test file that
 * throws while being imported reports nothing at all.
 *
 * So the drift is asserted away rather than documented away. Both lists are resolved against their
 * own file's directory and compared as absolute paths, which is the comparison that matters: the two
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

  test("the root and server configs preload the same scripts", () => {
    expect(preloadedScripts(serverBunfig)).toEqual(
      preloadedScripts(rootBunfig),
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

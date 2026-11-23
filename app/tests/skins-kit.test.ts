import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { KIT_STORAGE_KEY, kitOf, SKIN_KITS } from "../src/skins/kit";
import { DEFAULT_SKIN, SKIN_STORAGE_KEY } from "../src/skins/store";
import { SKIN_IDS } from "../src/skins/types";

/*
 * The UI Kit a skin is drawn with is one switch, skins/kit.ts. These hold the rest of the app to it,
 * so that moving a skin to the current kit stays a change to that file and its own skin.css.
 */

const SRC = join(import.meta.dir, "../src");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");

function* sources(directory: string): Generator<string> {
  for (const name of readdirSync(directory)) {
    if (["node_modules", "generated"].includes(name)) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(tsx?|css)$/.test(name)) yield path;
  }
}

describe("which kit a skin is drawn with", () => {
  test("every skin says, and OpenBot's own is the current kit", () => {
    for (const id of SKIN_IDS)
      expect(["current", "legacy"]).toContain(kitOf(id));
    expect(Object.keys(SKIN_KITS).sort()).toEqual([...SKIN_IDS].sort());
    expect(kitOf(DEFAULT_SKIN)).toBe("current");
  });

  test("no screen asks which skin it is to choose a look; it asks the kit", () => {
    const asking = [...sources(SRC)]
      .map((path) => relative(SRC, path))
      .filter((path) => !path.startsWith("skins/"))
      .filter((path) => /useSkinId\(\)\s*[!=]==/.test(read(path)));
    expect(asking).toEqual([]);
  });

  test("the app's stylesheet keys its current-kit rules on the kit, not on a skin", () => {
    const styles = read("styles.css");
    expect(styles).not.toContain("data-skin");
    expect(styles).toContain(
      '@custom-variant kit (&:is(:root:not([data-kit="legacy"]) *));',
    );
    // The legacy kit's values, and nothing else, sit under the legacy kit's attribute.
    const legacy = read("skins/legacy-base.css");
    expect(legacy).not.toContain("[data-skin]");
    expect(legacy).toContain(':root[data-kit="legacy"]');
  });
});

describe("pre-paint kit boot", () => {
  const html = readFileSync(join(import.meta.dir, "../index.html"), "utf8");

  /** Runs the inline boot script with what the two keys hold, and returns `<html data-kit>`. */
  function bootWith(skin: string | null, kit: string | null) {
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    if (!script) throw new Error("index.html has no inline boot script");
    const root = {
      classList: { toggle: () => {} },
      style: {} as Record<string, string>,
      dataset: {} as Record<string, string>,
    };
    const stored: Record<string, string | null> = {
      [SKIN_STORAGE_KEY]: skin,
      [KIT_STORAGE_KEY]: kit,
    };
    const window = {
      localStorage: { getItem: (key: string) => stored[key] ?? null },
      matchMedia: () => ({ matches: false }),
    };
    new Function("window", "document", script)(window, {
      documentElement: root,
    });
    return root.dataset.kit;
  }

  test("the boot script reads the key the app writes", () => {
    expect(html).toContain(KIT_STORAGE_KEY);
  });

  test("the kit cached beside the skin marks the page before it paints", () => {
    expect(bootWith("opendots", "legacy")).toBe("legacy");
    // A skin cached before kits were: every alternate skin was drawn with the legacy kit then.
    expect(bootWith("opendots", null)).toBe("legacy");
    // A skin since moved to the current kit, and OpenBot's own, draw the current kit unmarked.
    expect(bootWith("opendots", "current")).toBeUndefined();
    expect(bootWith(DEFAULT_SKIN, null)).toBeUndefined();
    expect(bootWith(null, null)).toBeUndefined();
  });
});

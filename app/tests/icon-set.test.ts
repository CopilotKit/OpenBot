import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/*
 * One icon set in every app (docs/design-system.md, "The rest of the look"): Hugeicons' free set,
 * in the web app, the extension and OpenBot Desktop. A screen takes its icons from
 * app/src/components/icons (Desktop, a package of its own, from desktop/src/icons.tsx) and never
 * names the set, so changing a glyph or the set is a change to those two files. A second set
 * imported beside it, or the set imported around them, is how two looks of icon come back.
 */

const ROOT = new URL("../../", import.meta.url).pathname;
const APP_ICONS = "app/src/components/icons/index.tsx";
const DESKTOP_ICONS = "desktop/src/icons.tsx";

/** Every .ts and .tsx file under the repository's `dir`, relative to the repository. */
function sourceFiles(dir: string): string[] {
  const walk = (path: string): string[] =>
    statSync(path).isDirectory()
      ? readdirSync(path)
          .filter((name) => name !== "node_modules" && name !== "generated")
          .flatMap((name) => walk(join(path, name)))
      : /\.tsx?$/.test(path)
        ? [relative(ROOT, path)]
        : [];
  return walk(join(ROOT, dir));
}

const FILES = [
  "app/src",
  "app/tests",
  "extension/src",
  "extension/tests",
  "desktop/src",
].flatMap(sourceFiles);

/** The modules a file imports, from its `import … from` and `import(…)`. */
function imports(file: string): string[] {
  const source = readFileSync(join(ROOT, file), "utf8");
  return [
    ...source.matchAll(
      /\bfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']/g,
    ),
  ].map((match) => match[1] ?? match[2]);
}

describe("one icon set", () => {
  test("no file imports another icon set", () => {
    const other =
      /^(@tabler\/|lucide-react|react-icons|@heroicons\/|@phosphor-icons\/)/;
    const found = FILES.flatMap((file) =>
      imports(file)
        .filter((name) => other.test(name))
        .map((name) => `${file}: ${name}`),
    );
    expect(found).toEqual([]);
  });

  test("only the two icon modules import the set", () => {
    const found = FILES.filter((file) =>
      imports(file).some((name) => name.startsWith("@hugeicons/")),
    );
    expect(found.sort()).toEqual([APP_ICONS, DESKTOP_ICONS]);
  });

  test("no app depends on another icon set", () => {
    for (const app of ["app", "extension", "desktop"]) {
      const manifest = JSON.parse(
        readFileSync(join(ROOT, app, "package.json"), "utf8"),
      );
      const names = Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
      });
      expect({
        app,
        tabler: names.filter((n) => n.startsWith("@tabler/")),
      }).toEqual({
        app,
        tabler: [],
      });
      expect({
        app,
        set: names.includes("@hugeicons/core-free-icons"),
      }).toEqual({
        app,
        set: true,
      });
    }
  });

  /*
   * Desktop can't import the web app's module, so it keeps its own. An icon both draw is the same
   * glyph in both, so a Bot or a cloud looks the same in the Mac app's setup window and in the app.
   */
  test("an icon Desktop shares with the web app is the same glyph", () => {
    const glyphs = (file: string) =>
      new Map(
        [
          ...readFileSync(join(ROOT, file), "utf8").matchAll(
            /export const (Icon\w+) = defineIcon\(\s*"[^"]+",\s*(\w+)/g,
          ),
        ].map((match) => [match[1], match[2]]),
      );
    const app = glyphs(APP_ICONS);
    const desktop = glyphs(DESKTOP_ICONS);
    expect(desktop.size).toBeGreaterThan(0);
    const differ = [...desktop]
      .filter(([name, glyph]) => app.has(name) && app.get(name) !== glyph)
      .map(
        ([name, glyph]) =>
          `${name}: ${glyph} in Desktop, ${app.get(name)} in the app`,
      );
    expect(differ).toEqual([]);
  });
});

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as storageKeys from "../../shared/app-storage-keys";
import { SKIN_IDS } from "../../shared/user-preferences";

/**
 * The workbench uses the app's own values and never types them out again (see "The rule" in
 * README.md). A copy goes stale without an error when the app changes; an import fails to compile.
 * This test names each workbench file that spells out one of these values instead of importing
 * it. Add a value here when the workbench starts to use another of the app's constants.
 */
const APP_VALUES: readonly string[] = [
  ...Object.values(storageKeys),
  ...SKIN_IDS,
];

const ROOT = join(import.meta.dir, "..", "..");
const DIRS = [
  join(ROOT, "desktop", "workbench"),
  join(ROOT, "app", "workbench"),
];

/** The workbench's own source: TypeScript files, without tests. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) return [];
    return [path];
  });
}

test("the workbench imports the app's values and spells out none of them", () => {
  const copies: string[] = [];
  for (const file of DIRS.flatMap(sources)) {
    const text = readFileSync(file, "utf8");
    for (const value of APP_VALUES) {
      if (text.includes(`"${value}"`) || text.includes(`'${value}'`)) {
        copies.push(`${relative(ROOT, file)}: "${value}"`);
      }
    }
  }
  expect(copies).toEqual([]);
});

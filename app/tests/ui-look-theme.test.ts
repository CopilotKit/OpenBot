import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * The two theme values the web app's look changes (docs/app-guidelines.md, "The look"): corners
 * from an 8px radius, and the default icon line at 1.75. Nothing else in theme.css moves, and the
 * scheme's generated block least of all.
 */

const THEME = new URL("../src/theme.css", import.meta.url);
const theme = readFileSync(THEME, "utf8");
const withoutComments = theme.replace(/\/\*[\s\S]*?\*\//g, "");

/** The text between the scheme's markers, light then dark. */
function schemeBlocks(css: string) {
  return [
    ...css.matchAll(
      /\/\* tokens\/src\/scheme\.ts, [^*]*\*\/([\s\S]*?)\/\* end of tokens\/src\/scheme\.ts \*\//g,
    ),
  ].map((match) => match[1]);
}

describe("the look's theme values", () => {
  test(":root's --radius is 0.5rem", () => {
    const root = withoutComments.match(/(?:^|[};])\s*:root\s*\{([^}]*)\}/);
    expect(root?.[1]).toMatch(/--radius:\s*0\.5rem;/);
  });

  test("the default icon stroke is 1.75, and only the default", () => {
    const rules = [
      ...withoutComments.matchAll(/([^{}]*\.tabler-icon[^{}]*)\{([^}]*)\}/g),
    ].map((match) => ({
      selector: match[1].trim(),
      body: match[2].trim(),
    }));
    expect(rules).toEqual([
      {
        selector: '.tabler-icon[stroke-width="2"]',
        body: "stroke-width: 1.75;",
      },
    ]);
  });

  test("the scheme's generated block is untouched", () => {
    const main = Bun.spawnSync([
      "git",
      "show",
      "origin/main:app/src/theme.css",
    ]).stdout.toString();
    expect(schemeBlocks(main)).toHaveLength(2);
    expect(schemeBlocks(theme)).toEqual(schemeBlocks(main));
  });
});

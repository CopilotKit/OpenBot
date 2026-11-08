import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * OpenBot's own look, the frosted sidebar on the orb's wash (frame.css) and its typeface (typeface.css), is drawn only
 * where no skin is: a skin draws its own frame and keeps its own face. A skin marks the page with `data-skin` on the
 * root (skins/store.ts), so every rule in both files starts at a root without it, and none can reach a skinned page.
 */

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

/** Every selector of every style rule, at-rules' own preludes left out, the rules nested in them kept. */
function selectors(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found: string[] = [];
  let start = 0;
  for (let at = 0; at < text.length; at++) {
    const character = text[at];
    if (character === "{") {
      const prelude = text.slice(start, at).trim();
      if (prelude && !prelude.startsWith("@"))
        found.push(
          ...prelude
            .split(",")
            .map((selector) => selector.trim().replace(/\s+/g, " ")),
        );
      start = at + 1;
    } else if (character === "}" || character === ";") start = at + 1;
  }
  return found;
}

const UNSKINNED = /^:root(\.dark)?:not\(\[data-skin\]\)/;

test("every rule of the frosted frame is for a page no skin draws", () => {
  const rules = selectors(read("../src/frame.css"));
  expect(rules.length).toBeGreaterThan(0);
  for (const selector of rules) expect(selector).toMatch(UNSKINNED);
});

test("every rule naming OpenBot's typeface is for a page no skin draws", () => {
  const rules = selectors(read("../src/typeface.css"));
  expect(rules.length).toBeGreaterThan(0);
  for (const selector of rules) expect(selector).toMatch(UNSKINNED);
});

test("a skin marks the page it draws, which is what both files leave alone", () => {
  const store = read("../src/skins/store.ts");
  expect(store).toContain("document.documentElement.dataset.skin = id");
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SKINS } from "../src/skins/registry";
import {
  applySkin,
  DEFAULT_SKIN,
  parseStoredSkin,
  reconcileSkin,
  SKIN_STORAGE_KEY,
} from "../src/skins/store";
import { SKIN_IDS } from "../src/skins/types";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

const skinned = SKIN_IDS.filter((id) => id !== DEFAULT_SKIN);

describe("skin preference", () => {
  test("a stored skin is used only when OpenBot ships it", () => {
    for (const id of SKIN_IDS) expect(parseStoredSkin(id)).toBe(id);
    expect(parseStoredSkin(null)).toBe(DEFAULT_SKIN);
    expect(parseStoredSkin("")).toBe(DEFAULT_SKIN);
    expect(parseStoredSkin("retired-skin")).toBe(DEFAULT_SKIN);
  });

  test("choosing a skin stores it and names it on the document", () => {
    const writes: Array<[string, string]> = [];
    const roots: Array<string | null> = [];
    const effects = {
      setStoredValue: (key: string, value: string) => writes.push([key, value]),
      setRootSkin: (id: string | null) => roots.push(id),
    };

    applySkin("opendots", effects);
    applySkin(DEFAULT_SKIN, effects);

    expect(writes).toEqual([
      [SKIN_STORAGE_KEY, "opendots"],
      [SKIN_STORAGE_KEY, DEFAULT_SKIN],
    ]);
    // The default clears the attribute, so no skin's rules can match OpenBot's own look.
    expect(roots).toEqual(["opendots", null]);
  });

  test("a skin this build no longer ships is cleared from the document on load", () => {
    const roots: Array<string | null> = [];
    const setRootSkin = (id: string | null) => roots.push(id);

    expect(reconcileSkin("retired-skin", { setRootSkin })).toBe(DEFAULT_SKIN);
    expect(reconcileSkin("openmuse", { setRootSkin })).toBe("openmuse");
    expect(roots).toEqual([null, "openmuse"]);
  });

  test("every skin is registered under its own id", () => {
    for (const id of SKIN_IDS) expect(SKINS[id].id).toBe(id);
  });
});

describe("pre-paint skin boot", () => {
  const html = read("../index.html");

  test("the boot script reads the same storage key the app writes", () => {
    expect(html).toContain(SKIN_STORAGE_KEY);
    expect(html).toContain("dataset.skin");
  });
});

/*
 * Top-level rules of a stylesheet, with the selectors of rules nested in `@media` or `@supports`
 * flattened in, and the at-rules that hold no selectors (`@keyframes`, `@font-face`, `@theme`,
 * `@property`) left out.
 */
function selectors(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) {
        const head = text.slice(start, i).trim();
        const close = matching(text, i);
        if (/^@(media|supports|layer)\b/.test(head)) {
          found.push(...selectors(text.slice(i + 1, close)));
        } else if (!head.startsWith("@")) {
          found.push(head);
        }
        i = close;
        start = close + 1;
        continue;
      }
      depth++;
    } else if (text[i] === ";" && depth === 0) {
      start = i + 1;
    }
  }
  return found;
}

function matching(text: string, open: number) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}" && --depth === 0) return i;
  }
  throw new Error("Unbalanced braces");
}

function declaredTokens(css: string, selector: string) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = new Set<string>();
  for (const block of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const heads = block[1].split(",").map((head) => head.trim());
    if (!heads.includes(selector)) continue;
    for (const token of block[2].matchAll(/(--[\w-]+)\s*:/g)) {
      tokens.add(token[1]);
    }
  }
  return tokens;
}

describe("skin stylesheets", () => {
  const index = read("../src/skins/skins.css");

  test.each(skinned)("%s is loaded", (id) => {
    expect(index).toContain(`./${id}/skin.css`);
  });

  test.each(skinned)("%s styles nothing while another skin is active", (id) => {
    const css = read(`../src/skins/${id}/skin.css`);
    for (const selector of selectors(css)) {
      for (const part of selector.split(",")) {
        expect(part).toContain(`[data-skin="${id}"]`);
      }
    }
  });

  test.each(skinned)("%s sets every light token for dark too", (id) => {
    const css = read(`../src/skins/${id}/skin.css`);
    const light = declaredTokens(css, `:root[data-skin="${id}"]`);
    const dark = declaredTokens(css, `:root[data-skin="${id}"].dark`);
    expect([...light].filter((token) => !dark.has(token))).toEqual([]);
  });
});

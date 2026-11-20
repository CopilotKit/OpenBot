import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * The default look is theme.css's own shadcn tokens, so a customer changes it in one place. Light
 * is `:root` and dark is `.dark`. Nothing else declares a token for the default look.
 */

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

/** Every custom property declared in a block whose selector list includes `selector`. */
function declared(css: string, selector: string) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = new Map<string, string>();
  for (const block of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // The selector is what follows the previous statement, such as an `@import` or `@custom-variant`.
    const prelude = block[1].split(";").at(-1) ?? "";
    const heads = prelude.split(",").map((head) => head.trim());
    if (!heads.includes(selector)) continue;
    for (const token of block[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      tokens.set(token[1], token[2].trim());
    }
  }
  return tokens;
}

/** The perceived lightness of an `oklch(...)` color, its first channel. */
function lightness(color: string | undefined) {
  const match = color?.match(/^oklch\(([\d.]+)\s/);
  if (!match) throw new Error(`not an oklch color: ${color}`);
  return Number(match[1]);
}

/** shadcn's theme tokens: the color pairs, the chart and sidebar sets, and the radius. */
const SHADCN_TOKEN =
  /^--((background|foreground|border|input|ring|radius)|(card|popover|primary|secondary|muted|accent|destructive)(-foreground)?|chart-[1-5]|sidebar(-(foreground|primary|primary-foreground|accent|accent-foreground|border|ring))?)$/;

const theme = read("../src/theme.css");
const THEMES = [
  ["light", declared(theme, ":root")],
  ["dark", declared(theme, ".dark")],
] as const;

describe("default look tokens", () => {
  test("every color dark mode sets, light mode sets too", () => {
    const [, light] = THEMES[0];
    const [, dark] = THEMES[1];
    expect([...dark.keys()].filter((token) => !light.has(token))).toEqual([]);
  });

  /*
   * Three surfaces, darkest to lightest: the frame the sidebar shares with the window's edge, the
   * panel the page sits in, and the cards on it. Equal neighbors would merge into one.
   */
  test.each(THEMES)(
    "%s: the frame is darker than the panel, the panel darker than cards",
    (_, tokens) => {
      const frame = lightness(tokens.get("--sidebar"));
      const panel = lightness(tokens.get("--background"));
      const card = lightness(tokens.get("--card"));
      expect(frame).toBeLessThan(panel);
      expect(panel).toBeLessThan(card);
    },
  );

  /*
   * Menus, pickers and comboboxes mark the highlighted row with `--accent` on `--popover`, and some
   * rows sit straight on `--background`. When the accent equals either surface the highlight
   * vanishes, which is how dark mode's menus first shipped.
   */
  test.each(THEMES)(
    "%s: --accent differs from --popover and --background",
    (_, tokens) => {
      const accent = tokens.get("--accent");
      expect(accent).toBeDefined();
      expect(accent).not.toBe(tokens.get("--popover"));
      expect(accent).not.toBe(tokens.get("--background"));
    },
  );

  // A stock shadcn theme drops in: no token beyond shadcn's own, the success color and the
  // empty-state pattern's.
  test.each(THEMES)("%s: declares only shadcn's tokens", (_, tokens) => {
    const extra = [...tokens.keys()].filter(
      (token) =>
        !SHADCN_TOKEN.test(token) &&
        token !== "--success" &&
        !token.startsWith("--empty-pattern"),
    );
    expect(extra).toEqual([]);
  });

  // A button or badge on a card is lighter than the card, never a hole through to the frame.
  test("dark: secondary and muted fills are lighter than cards", () => {
    const [, dark] = THEMES[1];
    const card = lightness(dark.get("--card"));
    expect(lightness(dark.get("--secondary"))).toBeGreaterThan(card);
    expect(lightness(dark.get("--muted"))).toBeGreaterThan(card);
  });

  test("skins start with the empty-state pattern off", () => {
    expect(
      declared(read("../src/skins/skins.css"), ":root[data-skin]").get(
        "--empty-pattern-opacity",
      ),
    ).toBe("0");
  });
});

describe("fonts", () => {
  const styles = read("../src/styles.css");

  // OpenDuet is set in Inter.
  test("Inter still loads", () => {
    expect(styles).toContain('@import "@fontsource-variable/inter"');
  });
});

describe("the extension", () => {
  test("theme.css, which the extension's pages import, has no default-skin blocks", () => {
    expect(theme).not.toContain(":root:not([data-skin])");
  });
});

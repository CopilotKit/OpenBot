import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * The default look is theme.css's own shadcn tokens, so a customer changes it in one place. Light
 * is `:root` and dark is `.dark`. openbot.css adds only what the default skin needs beyond colors:
 * its typeface and the orb's edge, scoped to `:root:not([data-skin])`.
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

/** Relative luminance of a `#rrggbb` color, as WCAG computes it. */
function luminance(hex: string | undefined) {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex))
    throw new Error(`not a hex color: ${hex}`);
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

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
      const frame = luminance(tokens.get("--sidebar"));
      const panel = luminance(tokens.get("--background"));
      const card = luminance(tokens.get("--card"));
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

  test.each(THEMES)(
    "%s: the card edge, shadow and warning colors are tokens",
    (_, tokens) => {
      for (const token of [
        "--card-border",
        "--card-shadow",
        "--card-shadow-hover",
        "--warning",
        "--warning-foreground",
      ]) {
        expect(tokens.has(token)).toBe(true);
      }
    },
  );

  // A button or badge on a card is lighter than the card, never a hole through to the frame.
  test("dark: secondary and muted fills are lighter than cards", () => {
    const [, dark] = THEMES[1];
    const card = luminance(dark.get("--card"));
    expect(luminance(dark.get("--secondary"))).toBeGreaterThan(card);
    expect(luminance(dark.get("--muted"))).toBeGreaterThan(card);
  });

  test("skins keep their plain card edge and no lift", () => {
    const skins = read("../src/skins/skins.css");
    const light = declared(skins, ":root[data-skin]");
    expect(light.get("--card-border")).toBe("var(--border)");
    expect(light.get("--card-shadow")).toBe("0 0 #0000");
    expect(declared(skins, ":root[data-skin].dark").get("--card-border")).toBe(
      "transparent",
    );
  });

  test("skins start with the empty-state pattern off", () => {
    expect(
      declared(read("../src/skins/skins.css"), ":root[data-skin]").get(
        "--empty-pattern-opacity",
      ),
    ).toBe("0");
  });
});

describe("default skin extras", () => {
  const extras = read("../src/openbot.css");
  const light = declared(extras, ":root:not([data-skin])");
  const dark = declared(extras, ":root:not([data-skin]).dark");

  test("the type is Atkinson Hyperlegible", () => {
    expect(light.get("--font-sans")).toContain("Atkinson Hyperlegible Next");
    expect(light.get("--font-mono")).toContain("Atkinson Hyperlegible Mono");
  });

  test("the orb's edge is set for light and dark", () => {
    expect(light.has("--orb-edge")).toBe(true);
    expect(dark.has("--orb-edge")).toBe(true);
  });

  test("it sets no colors of its own", () => {
    // Its typeface overrides theme.css's on purpose; anything else theme.css sets is a color.
    const colors = [...light.keys(), ...dark.keys()].filter(
      (token) => theme.includes(`${token}:`) && !token.startsWith("--font-"),
    );
    expect(colors).toEqual([]);
  });
});

describe("fonts", () => {
  const styles = read("../src/styles.css");

  test("both Atkinson faces load", () => {
    expect(styles).toContain(
      '@import "@fontsource-variable/atkinson-hyperlegible-next"',
    );
    expect(styles).toContain(
      '@import "@fontsource-variable/atkinson-hyperlegible-mono"',
    );
  });

  // OpenDuet is set in Inter.
  test("Inter still loads", () => {
    expect(styles).toContain('@import "@fontsource-variable/inter"');
  });
});

describe("the extension", () => {
  test("theme.css, which the extension's pages import, has no default-skin blocks", () => {
    expect(theme).not.toContain(":root:not([data-skin])");
  });

  test("only the app's own stylesheet brings in the default skin's extras", () => {
    expect(read("../src/styles.css")).toContain('@import "./openbot.css";');
  });
});

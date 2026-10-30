import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * OpenBot's own look is drawn only while no skin is active, so every token it adds or changes sits
 * under `:root:not([data-skin])`. That selector outranks the plain `.dark`, so each one must be set
 * again under `:root:not([data-skin]).dark`, or dark mode would show the light value. The skins
 * keep the base `:root` and `.dark` they always inherited; `skins.test.ts` pins their side.
 */

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

const LIGHT = ":root:not([data-skin])";
const DARK = ":root:not([data-skin]).dark";

/** Every custom property declared in a block whose selector list includes `selector`. */
function declared(css: string, selector: string) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = new Map<string, string>();
  for (const block of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const heads = block[1].split(",").map((head) => head.trim());
    if (!heads.includes(selector)) continue;
    for (const token of block[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      tokens.set(token[1], token[2].trim());
    }
  }
  return tokens;
}

const ADDED = [
  "--line-strong",
  "--wash",
  "--card-shadow",
  "--card-shadow-hover",
  "--orb-edge",
  "--dot-tile",
  "--accent-dot-opacity",
  "--font-sans",
  "--font-mono",
];

describe("default skin tokens", () => {
  const theme = read("../src/openbot.css");
  const light = declared(theme, LIGHT);
  const dark = declared(theme, DARK);

  test.each(ADDED)("%s is set for light", (token) => {
    expect(light.has(token)).toBe(true);
  });

  test.each(ADDED)("%s is set for dark", (token) => {
    expect(dark.has(token)).toBe(true);
  });

  test("every light token is set for dark too", () => {
    expect([...light.keys()].filter((token) => !dark.has(token))).toEqual([]);
  });

  test("the type is Atkinson Hyperlegible", () => {
    expect(light.get("--font-sans")).toContain("Atkinson Hyperlegible Next");
    expect(light.get("--font-mono")).toContain("Atkinson Hyperlegible Mono");
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

describe("the extension keeps today's palette", () => {
  test("theme.css, which the extension's pages import, has no default-skin blocks", () => {
    expect(read("../src/theme.css")).not.toContain(":root:not([data-skin])");
  });

  test("only the app's own stylesheet brings in OpenBot's look", () => {
    expect(read("../src/styles.css")).toContain('@import "./openbot.css";');
  });
});

/*
 * Menus, pickers and comboboxes mark the highlighted row with `--accent` on `--popover`, and some
 * rows sit straight on `--background`. When the accent equals either surface the highlight vanishes,
 * which is how dark mode's menus first shipped.
 */
describe("a highlighted row can be seen", () => {
  const css = read("../src/openbot.css");
  test.each([
    ["light", LIGHT],
    ["dark", DARK],
  ])("%s: --accent differs from --popover and --background", (_, selector) => {
    const tokens = declared(css, selector);
    const accent = tokens.get("--accent");
    expect(accent).toBeDefined();
    expect(accent).not.toBe(tokens.get("--popover"));
    expect(accent).not.toBe(tokens.get("--background"));
  });
});

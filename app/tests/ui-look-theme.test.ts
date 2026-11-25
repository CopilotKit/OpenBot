import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as icons from "../src/components/icons";

/*
 * The two theme values the web app's look changes (docs/app-guidelines.md, "The look"): corners
 * from an 8px radius, and every icon at the icon set's 1.5 line. The scheme's generated block is held to
 * tokens/src/scheme.ts by tokens/tests/generated.test.ts, not here.
 */

const THEME = new URL("../src/theme.css", import.meta.url);
const theme = readFileSync(THEME, "utf8");
const withoutComments = theme.replace(/\/\*[\s\S]*?\*\//g, "");

describe("the look's theme values", () => {
  test(":root's --radius is 0.5rem", () => {
    const root = withoutComments.match(/(?:^|[};])\s*:root\s*\{([^}]*)\}/);
    expect(root?.[1]).toMatch(/--radius:\s*0\.5rem;/);
  });

  /*
   * Hugeicons' glyphs carry their line on each element, at 1.5 on a 24-unit grid. Every icon draws
   * that line unless it is given its own `stroke`, and no rule in the theme draws it otherwise.
   */
  test("every icon draws the set's 1.5 line, and its own when given one", () => {
    const drawn = Object.entries(icons).filter(([name]) =>
      /^Icon[A-Z]/.test(name),
    ) as [string, icons.Icon][];
    expect(drawn.length).toBeGreaterThan(200);
    const lines = (icon: icons.Icon, stroke?: number) => [
      ...new Set(
        [
          ...renderToStaticMarkup(createElement(icon, { stroke })).matchAll(
            /stroke-width="([^"]+)"/g,
          ),
        ].map((match) => match[1]),
      ),
    ];
    for (const [name, icon] of drawn) {
      expect({ name, lines: lines(icon) }).toEqual({ name, lines: ["1.5"] });
      expect({ name, lines: lines(icon, 2) }).toEqual({ name, lines: ["2"] });
    }
  });

  test("no rule in the theme sets an icon's line", () => {
    expect(withoutComments).not.toContain("stroke-width");
  });

  /*
   * A hairline is the text color, at 20% in light and 16% in dark (Guido, 2026-11-24): about 1.6:1
   * against a card in both themes, where the scheme's old border was 1.37 in light and 1.20 in dark
   * and all but vanished. One value for lines between things, a field's edge and the sidebar's
   * lines, so no line in the app is fainter than another.
   */
  test.each([
    [":root", "20%"],
    [".dark", "16%"],
  ])("%s draws every line in the text color at %s", (selector, strength) => {
    const block =
      new RegExp(
        `(?:^|[};])\\s*${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`,
      ).exec(withoutComments)?.[1] ?? "";
    const value = (name: string) =>
      new RegExp(`--${name}:\\s*([^;]+);`).exec(block)?.[1].trim();
    const foreground = value("foreground")?.replace(/\)$/, "");
    expect(foreground).toBeDefined();
    for (const name of ["border", "input", "sidebar-border"])
      expect({ name, value: value(name) }).toEqual({
        name,
        value: `${foreground} / ${strength})`,
      });
  });
});

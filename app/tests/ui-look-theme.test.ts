import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * The two theme values the web app's look changes (docs/app-guidelines.md, "The look"): corners
 * from an 8px radius, and the default icon line at 1.75. The scheme's generated block is held to
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

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scheme as phone } from "../../mobile/src/scheme";
import { oklchToHex, oklchToRgb } from "../src/color";
import { fillRegions, generate } from "../src/generate";
import { scheme, TOKENS } from "../src/scheme";

/*
 * Every app draws with one color scheme, tokens/src/scheme.ts (docs/app-guidelines.md). The apps
 * that can't import it hold a copy, written by `bun run tokens:generate`. A copy edited by hand, or
 * a scheme changed without running it, fails here. Fix it by changing the scheme and running the
 * generator, never by editing the copy.
 */

const root = join(import.meta.dir, "../..");

describe("the copies of the color scheme", () => {
  test.each([...generate(root)])(
    "%s is what the scheme writes",
    (file, expected) => {
      expect(readFileSync(join(root, file), "utf8")).toBe(expected);
    },
  );
});

describe("the scheme", () => {
  test("every color is an oklch() value, light and dark", () => {
    for (const mode of ["light", "dark"] as const) {
      for (const name of TOKENS) {
        expect(scheme[mode][name]).toMatch(/^oklch\(/);
      }
    }
  });
});

describe("OpenBot Mobile's copy", () => {
  // The web app's own tokens, as its stylesheet declares them.
  const web = (mode: "light" | "dark") => {
    const css = readFileSync(join(root, "app/src/theme.css"), "utf8");
    const block = mode === "light" ? /:root\s*{([^}]*)}/ : /\.dark\s*{([^}]*)}/;
    const body = block.exec(css)?.[1] ?? "";
    return (name: string) =>
      new RegExp(`--${name}:\\s*([^;]+);`).exec(body)?.[1]?.trim();
  };

  test("every color is a hex React Native can draw", () => {
    for (const mode of ["light", "dark"] as const) {
      for (const name of TOKENS) {
        expect(`${mode} ${name}: ${phone[mode][name]}`).toMatch(
          /: #[0-9a-f]{6}([0-9a-f]{2})?$/,
        );
      }
    }
  });

  test("warning is the web app's warning", () => {
    for (const mode of ["light", "dark"] as const) {
      const token = web(mode)("warning");
      expect(token).toMatch(/^oklch\(/);
      const drawn: string = phone[mode].warning;
      expect(drawn).toBe(oklchToHex(token as string));
    }
    expect(phone.light.warning).toBe("#bb4d00");
    expect(phone.dark.warning).toBe("#ffb900");
  });
});

describe("oklch to hex", () => {
  test("white, black and a translucent color", () => {
    expect(oklchToHex("oklch(1 0 0)")).toBe("#ffffff");
    expect(oklchToHex("oklch(0 0 0)")).toBe("#000000");
    expect(oklchToHex("oklch(1 0 0 / 50%)")).toBe("#ffffff80");
  });

  // A channel outside sRGB clips to 0, never NaN: warning's blue was "#bb4dNaN" on the phone.
  // Cross-checked with culori 4.0.2: clampRgb, then formatHex.
  test("clips a channel outside sRGB", () => {
    expect(oklchToHex("oklch(0.555 0.163 49)")).toBe("#bb4d00");
    expect(oklchToHex("oklch(0.828 0.189 84.4)")).toBe("#ffb900");
    expect(oklchToHex("oklch(0.792 0.121 16.4)")).toBe("#ff9aa0");
  });

  // The values OpenBot Desktop's first paint was drawn with before the scheme was generated.
  test("matches the desktop's hand-converted colors", () => {
    expect(oklchToHex("oklch(0.948 0.011 286.2)")).toBe("#ededf5");
    expect(oklchToHex("oklch(0.108 0.015 220.9)")).toBe("#010507");
    expect(oklchToHex("oklch(0.156 0.017 295.8)")).toBe("#0d0b13");
    expect(oklchToHex("oklch(0.69 0.017 285.9)")).toBe("#9a9aa6");
  });
});

describe("an RGB copy of a translucent color", () => {
  /*
   * An RGB copy (the desktop window's first paint) has no opacity. A translucent color, such as a
   * line drawn as the text color at 12%, is written as it shows on a card: blended over `card`,
   * the surface every line in the first paint sits on. Dropping the opacity would draw the line at
   * full strength.
   */
  test.each(["light", "dark"] as const)(
    "%s: the border is written blended over the card",
    (mode) => {
      const region = [
        `    // tokens/src/scheme.ts, ${mode}: edge=border (bun run tokens:generate)`,
        "    // end of tokens/src/scheme.ts",
      ].join("\n");
      const written = fillRegions(region, "example.rs");
      const line = oklchToRgb(scheme[mode].border);
      const card = oklchToRgb(scheme[mode].card);
      expect(line.alpha).toBeLessThan(1);
      const blend = (top: number, under: number) =>
        Math.round(top * line.alpha + under * (1 - line.alpha));
      const hex = (n: number) => `0x${n.toString(16).padStart(2, "0")}`;
      const expected = `edge: (${hex(blend(line.r, card.r))}, ${hex(blend(line.g, card.g))}, ${hex(blend(line.b, card.b))}),`;
      expect(written).toContain(expected);
    },
  );
});

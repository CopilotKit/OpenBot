import { describe, expect, test } from "bun:test";
import { scheme, TOKENS } from "../src/scheme";

/** [lightness, chroma, hue] of an oklch() value. */
function lch(value: string): [number, number, number] {
  const m = value.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)/);
  if (!m) throw new Error(`not oklch: ${value}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * The grays: every color with a faint tint. White has none, and the accents (the ring, the
 * selected sidebar row, the empty pattern) and the status colors are far more saturated. The chart
 * colors are Tailwind's slate already and are left as they are.
 */
function grays(mode: "light" | "dark") {
  return TOKENS.filter((token) => !token.startsWith("chart-"))
    .map((token) => [token, lch(scheme[mode][token])] as const)
    .filter(([, [, c]]) => c > 0 && c < 0.05);
}

describe("the grays are slate", () => {
  test("in light, every gray sits on Tailwind slate's hues, never the old lilac", () => {
    const off = grays("light").filter(([, [, , h]]) => h < 247 || h > 266);
    expect(off).toEqual([]);
  });

  test("in dark, every gray is a quiet blue-gray: slate's hue moved to 252 and under half its tint", () => {
    const off = grays("dark").filter(
      ([, [, c, h]]) => Math.abs(h - 252) > 0.5 || c > 0.02,
    );
    expect(off).toEqual([]);
  });

  test("the lavender accents stay", () => {
    for (const mode of ["light", "dark"] as const) {
      for (const token of [
        "ring",
        "sidebar-ring",
        "sidebar-accent",
        "empty-pattern-color",
      ] as const) {
        const [, c, h] = lch(scheme[mode][token]);
        expect(c).toBeGreaterThan(0.08);
        expect(h).toBeGreaterThan(270);
      }
    }
  });
});

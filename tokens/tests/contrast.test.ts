import { describe, expect, test } from "bun:test";
import { oklchToRgb, type Rgb } from "../src/color";
import { type Mode, scheme, type Token } from "../src/scheme";

/*
 * Every text color can be read on the surfaces it is set on, and the focus ring can be seen, in
 * light and in dark (docs/design-system.md, "Check contrast before you choose a color"): 4.5:1 for
 * text, 3:1 for the ring. A color that fails here is changed in the scheme, never answered with a
 * second token for "the same color, as text".
 *
 * WCAG 2's relative luminance and contrast ratio, on the scheme's sRGB values. A translucent color
 * (the selected sidebar row's tint) is laid over the surface it sits on first.
 */

const TEXT = 4.5;
const NON_TEXT = 3;

/** [what is read, the surfaces it is read on (a translucent one over the one after it), minimum] */
const PAIRS: [Token, Token[], number][] = [
  ["foreground", ["background"], TEXT],
  ["card-foreground", ["card"], TEXT],
  ["popover-foreground", ["popover"], TEXT],
  ["primary-foreground", ["primary"], TEXT],
  ["secondary-foreground", ["secondary"], TEXT],
  ["accent-foreground", ["accent"], TEXT],
  ["muted-foreground", ["background"], TEXT],
  ["muted-foreground", ["card"], TEXT],
  ["muted-foreground", ["muted"], TEXT],
  ["destructive", ["background"], TEXT],
  ["destructive", ["card"], TEXT],
  ["success", ["background"], TEXT],
  ["success", ["card"], TEXT],
  ["warning", ["background"], TEXT],
  ["warning", ["card"], TEXT],
  ["sidebar-foreground", ["sidebar"], TEXT],
  ["sidebar-primary-foreground", ["sidebar-primary"], TEXT],
  ["sidebar-accent-foreground", ["sidebar-accent", "sidebar"], TEXT],
  ["ring", ["background"], NON_TEXT],
  ["ring", ["card"], NON_TEXT],
  ["sidebar-ring", ["sidebar"], NON_TEXT],
];

/** `top` laid over `under`, both 0–255. */
function over(top: Rgb, under: Rgb): Rgb {
  const mix = (a: number, b: number) => a * top.alpha + b * (1 - top.alpha);
  return {
    r: mix(top.r, under.r),
    g: mix(top.g, under.g),
    b: mix(top.b, under.b),
    alpha: 1,
  };
}

function luminance({ r, g, b }: Rgb) {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: Rgb, b: Rgb) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

function surface(mode: Mode, layers: Token[]): Rgb {
  const colors = layers.map((token) => oklchToRgb(scheme[mode][token]));
  return colors.reduceRight((under, top) => over(top, under));
}

describe("the scheme's contrast", () => {
  test("the measure agrees with WCAG's own examples", () => {
    const rgb = (hex: string): Rgb => ({
      r: Number.parseInt(hex.slice(1, 3), 16),
      g: Number.parseInt(hex.slice(3, 5), 16),
      b: Number.parseInt(hex.slice(5, 7), 16),
      alpha: 1,
    });
    expect(contrast(rgb("#000000"), rgb("#ffffff"))).toBeCloseTo(21, 5);
    expect(contrast(rgb("#767676"), rgb("#ffffff"))).toBeCloseTo(4.54, 2);
  });

  for (const mode of ["light", "dark"] as const) {
    test.each(PAIRS)(
      `${mode}: %s on %p reaches %d:1`,
      (text, layers, minimum) => {
        const ground = surface(mode, layers);
        const ink = over(oklchToRgb(scheme[mode][text]), ground);
        expect(contrast(ink, ground)).toBeGreaterThanOrEqual(minimum);
      },
    );
  }
});

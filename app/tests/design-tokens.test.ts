import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cn, TYPE_SCALE_CLASSES } from "../src/lib/utils";

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

type Lab = readonly [number, number, number];

/** An `oklch(...)` color in Oklab, ignoring any alpha. */
function oklab(color: string | undefined): Lab {
  const match = color?.match(/^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (!match) throw new Error(`not an oklch color: ${color}`);
  const [l, c, h] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const angle = (h * Math.PI) / 180;
  return [l, c * Math.cos(angle), c * Math.sin(angle)];
}

/** `share` of `a` mixed into `b` in Oklab, as `color-mix(in oklab, a share%, b)` draws it. */
function mix(a: Lab, share: number, b: Lab): Lab {
  return [0, 1, 2].map((i) => a[i] * share + b[i] * (1 - share)) as never;
}

/** WCAG's relative luminance, from Oklab through linear sRGB, clipped to the sRGB gamut. */
function luminance([l, a, b]: Lab) {
  const lms = [
    l + 0.3963377774 * a + 0.2158037573 * b,
    l - 0.1055613458 * a - 0.0638541728 * b,
    l - 0.0894841775 * a - 1.291485548 * b,
  ].map((value) => value ** 3);
  const clip = (value: number) => Math.min(1, Math.max(0, value));
  const r = clip(
    4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
  );
  const g = clip(
    -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
  );
  const bl = clip(
    -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2],
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

function contrast(a: Lab, b: Lab) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/** shadcn's theme tokens: the color pairs, the chart and sidebar sets, and the radius. */
const SHADCN_TOKEN =
  /^--((background|foreground|border|input|ring|radius)|(card|popover|primary|secondary|muted|accent|destructive)(-foreground)?|chart-[1-5]|sidebar(-(foreground|primary|primary-foreground|accent|accent-foreground|border|ring))?)$/;

/*
 * The roles shadcn has no name for: the brand for links and selection, the two status colours
 * beside `--success` and `--destructive`, the finger-sized target, and the glass and shadows.
 */
const OPENBOT_TOKEN =
  /^--(brand|status-(needs|working)|target|glass(-edge)?|shadow-(float|card|raised|glass))$/;

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

  // A stock shadcn theme drops in: no token beyond shadcn's own, the success color, the
  // empty-state pattern's and the few roles shadcn has no name for.
  test.each(THEMES)("%s: declares only shadcn's tokens", (_, tokens) => {
    const extra = [...tokens.keys()].filter(
      (token) =>
        !SHADCN_TOKEN.test(token) &&
        !OPENBOT_TOKEN.test(token) &&
        token !== "--success" &&
        !token.startsWith("--empty-pattern"),
    );
    expect(extra).toEqual([]);
  });

  // Shape is the same in both themes; every colour, glass and shadow has a dark value.
  test("every role shadcn has no name for has a dark value", () => {
    const [, light] = THEMES[0];
    const [, dark] = THEMES[1];
    const missing = [...light.keys()].filter(
      (token) =>
        OPENBOT_TOKEN.test(token) && token !== "--target" && !dark.has(token),
    );
    expect(missing).toEqual([]);
    expect(light.get("--target")).toBe("44px");
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

/*
 * The colours that carry words clear 4.5:1 on every surface they sit on, and each status word on
 * its own soft fill, which theme.css mixes as 10% of the colour into the card.
 */
describe("contrast", () => {
  const SURFACES = [
    "--background",
    "--card",
    "--popover",
    "--secondary",
    "--muted",
    "--accent",
    "--sidebar",
  ];
  const STATUS = {
    done: "--success",
    needs: "--status-needs",
    working: "--status-working",
    problem: "--destructive",
  };

  test.each(THEMES)(
    "%s: the brand and every status colour clear 4.5:1 on every surface",
    (_, tokens) => {
      for (const ink of ["--brand", ...Object.values(STATUS)])
        for (const surface of SURFACES) {
          const ratio = contrast(
            oklab(tokens.get(ink)),
            oklab(tokens.get(surface)),
          );
          expect({ ink, surface, clears: ratio >= 4.5 }).toEqual({
            ink,
            surface,
            clears: true,
          });
        }
    },
  );

  /** Each soft fill as theme.css mixes it: the colour it is drawn from, and its share of the card. */
  const SOFT = new Map(
    [
      ...theme.matchAll(
        /--color-status-(\w+)-soft:\s*color-mix\(\s*in oklab,\s*var\((--[\w-]+)\)\s+(\d+)%,\s*var\(--card\)\s*\)/g,
      ),
    ].map((match) => [
      match[1],
      { ink: match[2], share: Number(match[3]) / 100 },
    ]),
  );

  test.each(THEMES)(
    "%s: each status word clears 4.5:1 on its own soft fill",
    (_, tokens) => {
      const card = oklab(tokens.get("--card"));
      for (const [status, ink] of Object.entries(STATUS)) {
        const soft = SOFT.get(status);
        expect({ status, ink: soft?.ink }).toEqual({ status, ink });
        const color = oklab(tokens.get(ink));
        const ratio = contrast(color, mix(color, soft?.share ?? 1, card));
        expect({ status, clears: ratio >= 4.5 }).toEqual({
          status,
          clears: true,
        });
      }
    },
  );
});

describe("the type roles", () => {
  test("three sizes, in rem, each at least 2px from the next", () => {
    const sizes = new Map<string, string>();
    for (const match of theme.matchAll(
      /@utility (type-[\w-]+)\s*\{\s*font-size:\s*([^;]+);/g,
    ))
      sizes.set(match[1], match[2]);
    expect(Object.fromEntries(sizes)).toEqual({
      "type-body": "1.0625rem",
      "type-sub": "0.9375rem",
      "type-caption": "0.8125rem",
    });
    const px = [...sizes.values()]
      .map((size) => Number.parseFloat(size) * 16)
      .sort((a, b) => b - a);
    for (let i = 1; i < px.length; i++)
      expect(px[i - 1] - px[i]).toBeGreaterThanOrEqual(2);
  });

  test("a type role given later replaces a primitive's text size and leading", () => {
    for (const size of TYPE_SCALE_CLASSES)
      expect(cn("px-3 text-sm leading-relaxed", size)).toBe(`px-3 ${size}`);
  });

  test("a colour does not knock out a type role", () => {
    expect(cn("type-sub text-muted-foreground", "text-foreground")).toBe(
      "type-sub text-foreground",
    );
  });

  test("every type utility in the stylesheet is known to the merge", () => {
    const declared = [...theme.matchAll(/@utility (type-[\w-]+)/g)].map(
      (match) => match[1],
    );
    expect(new Set(declared)).toEqual(new Set(TYPE_SCALE_CLASSES));
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

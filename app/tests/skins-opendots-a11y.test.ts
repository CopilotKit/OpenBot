import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { oklchToRgb, type Rgb } from "../../tokens/src/color";
import { scheme, type Token } from "../../tokens/src/scheme";

/**
 * The OpenDots skin's colours, as it draws them, and its motion, read from its own stylesheet.
 *
 * Every text colour the skin draws must meet WCAG AA (4.5:1) on the surface it sits on, and every
 * icon 3:1 (WCAG 1.4.11), in light and in dark. OpenDots' own greys did not: its "YOUR WORKSPACE"
 * label measured 2.7:1 and its page description 3.0:1. The skin now wears OpenBot's colours: each of
 * its roles reads a token of the scheme (`--opendots-label: var(--muted-foreground)`), so the pairs
 * below, the ones the frame and its screens actually draw, are measured on the scheme's values. A
 * role pointed at another token later is measured where it is used.
 */

const css = readFileSync(
  new URL("../src/skins/opendots/skin.css", import.meta.url),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** Each `--opendots-*` role and the scheme's token it reads, from the block light and dark share. */
const roles: Record<string, string> = (() => {
  const head =
    ':root[data-skin="opendots"],\n:root[data-skin="opendots"].dark {';
  const start = css.indexOf(head);
  if (start < 0) throw new Error("No block of OpenDots' roles");
  const body = css.slice(start + head.length, css.indexOf("}", start));
  const found: Record<string, string> = {};
  for (const match of body.matchAll(/(--opendots-[\w-]+):\s*([^;]+);/g)) {
    found[match[1]] = match[2].trim();
  }
  return found;
})();

type Mode = keyof typeof scheme;

/** The scheme's token a name reads: itself, or the one an OpenDots role points at. */
function token(name: string): Token {
  if (!name.startsWith("--opendots-")) return name.slice(2) as Token;
  const read = /^var\(--([\w-]+)\)$/.exec(roles[name] ?? "");
  if (!read)
    throw new Error(
      `${name} reads no single token of the scheme: ${roles[name]}`,
    );
  return read[1] as Token;
}

/** `top` laid over `under`. */
function over(top: Rgb, under: Rgb): Rgb {
  const mix = (a: number, b: number) => a * top.alpha + b * (1 - top.alpha);
  return {
    r: mix(top.r, under.r),
    g: mix(top.g, under.g),
    b: mix(top.b, under.b),
    alpha: 1,
  };
}

/** A surface as it is drawn: a translucent one (the selected row's tint) over the sidebar. */
function surface(mode: Mode, name: string): Rgb {
  const color = oklchToRgb(scheme[mode][token(name)]);
  return color.alpha === 1
    ? color
    : over(color, oklchToRgb(scheme[mode].sidebar));
}

function luminance({ r, g, b }: Rgb) {
  const [R, G, B] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/** The WCAG 2 contrast ratio of two opaque sRGB colours. */
export function contrast(a: Rgb, b: Rgb) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const hex = (value: string): Rgb => ({
  r: Number.parseInt(value.slice(1, 3), 16),
  g: Number.parseInt(value.slice(3, 5), 16),
  b: Number.parseInt(value.slice(5, 7), 16),
  alpha: 1,
});

const TEXT = 4.5;
const ICON = 3;

/** [foreground token, the surface it sits on, minimum, where it is drawn] */
const PAIRS: Array<[string, string, number, string]> = [
  ["--foreground", "--background", TEXT, "page text"],
  ["--foreground", "--opendots-sidebar", TEXT, "product name"],
  ["--foreground", "--opendots-tab", TEXT, "computer pane tab"],
  ["--muted-foreground", "--background", TEXT, "muted text"],
  ["--muted-foreground", "--card", TEXT, "muted text on a card"],
  ["--muted-foreground", "--muted", TEXT, "muted text on muted"],
  ["--card-foreground", "--card", TEXT, "cards"],
  ["--popover-foreground", "--popover", TEXT, "menus"],
  ["--primary-foreground", "--primary", TEXT, "primary buttons"],
  ["--secondary-foreground", "--secondary", TEXT, "secondary buttons"],
  ["--accent-foreground", "--accent", TEXT, "hovered rows"],
  ["--destructive", "--background", TEXT, "errors"],
  ["--destructive", "--card", TEXT, "errors on a card"],
  ["--success", "--background", TEXT, "success text"],
  ["--sidebar-foreground", "--sidebar", TEXT, "Settings and Admin sidebars"],
  [
    "--sidebar-accent-foreground",
    "--sidebar-accent",
    TEXT,
    "their current row",
  ],
  ["--opendots-nav-ink", "--opendots-sidebar", TEXT, "conversation rows"],
  [
    "--opendots-nav-ink",
    "--opendots-hover",
    TEXT,
    "a hovered conversation row",
  ],
  ["--opendots-active-ink", "--opendots-active", TEXT, "the open conversation"],
  ["--opendots-dot-ink", "--opendots-sidebar", TEXT, "Bot and workspace rows"],
  [
    "--opendots-dot-ink",
    "--opendots-active",
    TEXT,
    "the current workspace row",
  ],
  ["--opendots-new-chat-ink", "--opendots-sidebar", TEXT, "New chat"],
  ["--opendots-label", "--opendots-sidebar", TEXT, "BOTS and RECENT CHATS"],
  ["--opendots-muted", "--opendots-sidebar", TEXT, "the signed-in name"],
  ["--opendots-muted", "--opendots-pane", TEXT, "Computer for"],
  ["--opendots-faint", "--opendots-sidebar", TEXT, "empty sidebar sections"],
  [
    "--opendots-tag-ink",
    "--opendots-sidebar",
    TEXT,
    "Bot name under a conversation",
  ],
  ["--opendots-crumb", "--opendots-topbar", TEXT, "breadcrumb"],
  ["--opendots-crumb-ink", "--opendots-topbar", TEXT, "current breadcrumb"],
  ["--opendots-pause-ink", "--opendots-topbar", TEXT, "Pause"],
  ["--opendots-eyebrow", "--background", TEXT, "YOUR WORKSPACE"],
  ["--opendots-note", "--background", TEXT, "page description"],
  ["--opendots-persona-ink", "--background", TEXT, "a Bot's role on its home"],
  ["--opendots-text-button", "--background", TEXT, "Edit Bot"],
  ["--opendots-avatar-ink", "--opendots-avatar", TEXT, "your initials"],
  ["--opendots-error-ink", "--opendots-sidebar", TEXT, "sidebar errors"],
  [
    "--opendots-user-bubble-ink",
    "--opendots-user-bubble",
    TEXT,
    "your messages",
  ],
  ["--opendots-assistant-ink", "--background", TEXT, "a Bot's messages"],
  ["--opendots-icon", "--opendots-sidebar", ICON, "sidebar icon buttons"],
  ["--opendots-icon", "--opendots-topbar", ICON, "the computer toggle"],
  ["--opendots-icon", "--opendots-pane", ICON, "closing the computer"],
  ["--opendots-rail-icon", "--opendots-rail", ICON, "rail icons"],
  ["--opendots-toggle-ink", "--opendots-topbar", ICON, "the sidebar toggle"],
  ["--opendots-menu-ink", "--opendots-topbar", ICON, "the phone menu button"],
  ["--opendots-teal", "--opendots-sidebar", ICON, "the unread dot"],
];

describe("OpenDots colours meet WCAG AA", () => {
  test("the measure agrees with WCAG's own examples", () => {
    expect(contrast(hex("#000000"), hex("#ffffff"))).toBeCloseTo(21, 5);
    expect(contrast(hex("#767676"), hex("#ffffff"))).toBeCloseTo(4.54, 2);
  });

  for (const mode of ["light", "dark"] as const) {
    test.each(PAIRS)(
      `${mode}: %s on %s reaches %d:1 (%s)`,
      (foreground, ground, minimum) => {
        const under = surface(mode, ground);
        const ink = over(oklchToRgb(scheme[mode][token(foreground)]), under);
        expect(contrast(ink, under)).toBeGreaterThanOrEqual(minimum);
      },
    );
  }
});

describe("OpenDots respects reduced motion", () => {
  const block = css.match(
    /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?\{[\s\S]*?\})\s*\}/,
  )?.[1];

  test("the frame's chrome and every popup it opens stop moving", () => {
    expect(block).toBeDefined();
    for (const target of [
      "[data-opendots-chrome]",
      "[data-opendots-chrome] *",
      '[data-slot="tooltip-content"]',
      '[data-slot="dropdown-menu-content"]',
      '[data-slot="context-menu-content"]',
      '[data-slot="select-content"]',
      '[data-slot="sheet-content"]',
      '[data-slot="sheet-overlay"]',
      '[data-slot="dialog-content"]',
      '[data-slot="dialog-overlay"]',
    ]) {
      expect(block).toContain(`:root[data-skin="opendots"] ${target}`);
    }
    expect(block).toMatch(/animation:\s*none;/);
    expect(block).toMatch(/transition:\s*none;/);
  });
});

describe("OpenDots reaches OpenBot's pages only through their hooks", () => {
  /*
   * A selector that names one of OpenBot's Tailwind classes (`form.rounded-2xl`, `.sticky.top-0`)
   * breaks without a test failing the day that page is restyled. Pages publish `data-slot` hooks
   * for skins instead; the only class a selector here may name is the theme's own `.dark`.
   */
  test("no selector names a class other than .dark", () => {
    const classes = [...css.matchAll(/[^{}]+\{/g)]
      .map((match) => match[0].slice(0, -1).trim())
      .filter((head) => !head.startsWith("@") && !head.startsWith("--"))
      .flatMap((head) => head.match(/\.[a-zA-Z_][\w-]*/g) ?? [])
      .filter((name) => name !== ".dark");
    expect(classes).toEqual([]);
  });
});

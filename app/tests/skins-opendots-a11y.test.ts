import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The OpenDots skin's colours and motion, read from its own stylesheet.
 *
 * Every text colour the skin draws must meet WCAG AA (4.5:1) on the surface it sits on, and every
 * icon 3:1 (WCAG 1.4.11), in light and in dark. OpenDots' own greys did not: its "YOUR WORKSPACE"
 * label measured 2.7:1 and its page description 3.0:1. The pairs below are the ones the frame and
 * its screens actually draw, so a token changed later is measured where it is used.
 */

const css = readFileSync(
  new URL("../src/skins/opendots/skin.css", import.meta.url),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`No ${selector} block`);
  const body = css.slice(start, css.indexOf("}", start));
  const found: Record<string, string> = {};
  for (const match of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    found[match[1]] = match[2].trim();
  }
  return found;
}

const themes = {
  light: tokens(':root[data-skin="opendots"]'),
  dark: tokens(':root[data-skin="opendots"].dark'),
};

function channels(hex: string) {
  const value = hex.slice(1);
  return [0, 2, 4].map(
    (at) => Number.parseInt(value.slice(at, at + 2), 16) / 255,
  );
}

function luminance(hex: string) {
  const [r, g, b] = channels(hex).map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG 2 contrast ratio of two opaque sRGB colours. */
export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

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
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });

  for (const [theme, values] of Object.entries(themes)) {
    test.each(PAIRS)(
      `${theme}: %s on %s reaches %d:1 (%s)`,
      (foreground, surface, minimum) => {
        const color = values[foreground];
        const ground = values[surface];
        expect(color).toMatch(/^#[0-9a-f]{6}$/i);
        expect(ground).toMatch(/^#[0-9a-f]{6}$/i);
        expect(contrast(color, ground)).toBeGreaterThanOrEqual(minimum);
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

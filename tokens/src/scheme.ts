/**
 * OpenBot's color scheme: every color every app draws with, light and dark, in one place.
 *
 * This is the source. `bun run tokens:generate` writes it into each app's copy (the list is in
 * `targets.ts`), and `tokens/tests/generated.test.ts` fails when a copy differs. Change a color
 * here, never in a copy. A new color is a change to the scheme: agree it first, then add it here
 * with a light and a dark value (docs/app-guidelines.md).
 *
 * The names are shadcn's, so a stock shadcn theme drops in, plus `success`, `warning` and the
 * empty-state pattern's color.
 *
 * A color is never renamed or removed. A customer's theme (brand.yaml's `skin.stylesheet`) sets
 * these names, and a theme that sets one the scheme no longer has would quietly stop working. Change
 * a value; add a color; never take a name away.
 */

/** What each color is for. A color that doesn't mean one of these is no color. */
export const MEANING = {
  background: "The panel a page sits in.",
  foreground: "Text on the background.",
  card: "A card on the panel: the lightest surface.",
  "card-foreground": "Text on a card.",
  popover: "Menus, pickers and popovers.",
  "popover-foreground": "Text in a popover.",
  primary: "The main action.",
  "primary-foreground": "Text on the main action.",
  secondary: "A quieter action, or a badge.",
  "secondary-foreground": "Text on a secondary fill.",
  muted: "A quiet fill.",
  "muted-foreground": "Quieter text: descriptions, hints, times.",
  accent: "The highlighted row in a menu or a list.",
  "accent-foreground": "Text on the highlighted row.",
  destructive: "What deletes, or what failed.",
  success: "What worked, or is working.",
  warning:
    "What needs the person: something waits on them, or may not go as they expect. Never decoration.",
  border: "Lines between things.",
  input: "A field's border.",
  ring: "Focus.",
  "chart-1": "A chart's first series.",
  "chart-2": "A chart's second series.",
  "chart-3": "A chart's third series.",
  "chart-4": "A chart's fourth series.",
  "chart-5": "A chart's fifth series.",
  "empty-pattern-color": "The pattern behind an empty state.",
  sidebar: "The frame: the sidebar, and the window edge it shares a tint with.",
  "sidebar-foreground": "Text in the sidebar.",
  "sidebar-primary": "The main action in the sidebar.",
  "sidebar-primary-foreground": "Text on the sidebar's main action.",
  "sidebar-accent": "The selected sidebar row.",
  "sidebar-accent-foreground": "Text on the selected sidebar row.",
  "sidebar-border": "Lines in the sidebar.",
  "sidebar-ring": "Focus in the sidebar.",
} as const;

export type Token = keyof typeof MEANING;

export type Palette = Record<Token, string>;

/*
 * OpenBot's own look, the November 2026 redesign (Figma "Master screens"). Three surfaces, darkest
 * to lightest: the frame (the sidebar's cool gray, Figma's `--sidebar/bg`, which also backs a row's
 * icon tile), the pale page (`--bg-secondary`), and the white cards on it. Text and the primary
 * button are Figma's near-black ink (`--text-primary`); secondary text and borders are that ink at
 * 60% and 8%, so they read the same on the page, a card and a tile. The pale fills are the
 * secondary button (`#f1f2f7`) and the chips (`#eff2f6`); `input` is the pale blue-gray Figma gives
 * a switch that is off. The ring stays CopilotKit's periwinkle.
 *
 * The status colors are Figma's (variable collection "OpenBot", group "colors"): success #12c89c,
 * warning #f26900 and error #e21f32. Success and warning are drawn for dots, badges and tints, and
 * are too light to read as words on white; the web app draws its words in their ink, the same color
 * pulled toward `foreground` (app/src/theme.css, `--color-*-ink`).
 */
const light: Palette = {
  background: "oklch(0.985 0 0)",
  foreground: "oklch(0.172 0.007 258.4)",
  card: "oklch(1 0 0)",
  "card-foreground": "oklch(0.172 0.007 258.4)",
  popover: "oklch(1 0 0)",
  "popover-foreground": "oklch(0.172 0.007 258.4)",
  primary: "oklch(0.172 0.007 258.4)",
  "primary-foreground": "oklch(1 0 0)",
  secondary: "oklch(0.962 0.007 277.2)",
  "secondary-foreground": "oklch(0.172 0.007 258.4)",
  muted: "oklch(0.96 0.006 255.5)",
  "muted-foreground": "oklch(0.172 0.007 258.4 / 60%)",
  accent: "oklch(0.962 0.007 277.2)",
  "accent-foreground": "oklch(0.172 0.007 258.4)",
  destructive: "oklch(0.585 0.223 24)",
  success: "oklch(0.741 0.145 169.4)",
  warning: "oklch(0.68 0.19 46.5)",
  border: "oklch(0.172 0.007 258.4 / 8%)",
  input: "oklch(0.878 0.022 263.2)",
  ring: "oklch(0.644 0.167 276.1)",
  "chart-1": "oklch(0.869 0.022 252.894)",
  "chart-2": "oklch(0.554 0.046 257.417)",
  "chart-3": "oklch(0.446 0.043 257.281)",
  "chart-4": "oklch(0.372 0.044 257.287)",
  "chart-5": "oklch(0.279 0.041 260.031)",
  "empty-pattern-color": "oklch(0.746 0.117 279.9)",
  sidebar: "oklch(0.936 0.009 264.5)",
  "sidebar-foreground": "oklch(0.172 0.007 258.4)",
  "sidebar-primary": "oklch(0.172 0.007 258.4)",
  "sidebar-primary-foreground": "oklch(1 0 0)",
  "sidebar-accent": "oklch(1 0 0 / 60%)",
  "sidebar-accent-foreground": "oklch(0.172 0.007 258.4)",
  "sidebar-border": "oklch(0.172 0.007 258.4 / 8%)",
  "sidebar-ring": "oklch(0.644 0.167 276.1)",
};

/*
 * The same three surfaces on a near-black plum ground: the frame darkest, the cards lightest.
 * Secondary and muted fills are lighter than the cards, as shadcn's dark fills are, so a button or
 * badge never reads as a hole. Not yet redrawn for the redesign, whose dark theme is still to come.
 */
const dark: Palette = {
  background: "oklch(0.182 0.023 296.6)",
  foreground: "oklch(0.956 0.005 286.3)",
  card: "oklch(0.212 0.028 297.1)",
  "card-foreground": "oklch(0.956 0.005 286.3)",
  popover: "oklch(0.212 0.028 297.1)",
  "popover-foreground": "oklch(0.956 0.005 286.3)",
  primary: "oklch(0.956 0.005 286.3)",
  "primary-foreground": "oklch(0.108 0.015 220.9)",
  secondary: "oklch(0.253 0.032 297.6)",
  "secondary-foreground": "oklch(0.956 0.005 286.3)",
  muted: "oklch(0.253 0.032 297.6)",
  "muted-foreground": "oklch(0.69 0.017 285.9)",
  accent: "oklch(0.28 0.037 297.7)",
  "accent-foreground": "oklch(0.956 0.005 286.3)",
  destructive: "oklch(0.792 0.121 16.4)",
  success: "oklch(0.832 0.13 170.1)",
  warning: "oklch(0.828 0.189 84.4)",
  border: "oklch(0.28 0.035 298.6)",
  input: "oklch(0.28 0.035 298.6)",
  ring: "oklch(0.713 0.151 277.7)",
  "chart-1": "oklch(0.869 0.022 252.894)",
  "chart-2": "oklch(0.554 0.046 257.417)",
  "chart-3": "oklch(0.446 0.043 257.281)",
  "chart-4": "oklch(0.372 0.044 257.287)",
  "chart-5": "oklch(0.279 0.041 260.031)",
  "empty-pattern-color": "oklch(0.832 0.085 281.4)",
  sidebar: "oklch(0.156 0.017 295.8)",
  "sidebar-foreground": "oklch(0.956 0.005 286.3)",
  "sidebar-primary": "oklch(0.956 0.005 286.3)",
  "sidebar-primary-foreground": "oklch(0.108 0.015 220.9)",
  "sidebar-accent": "oklch(0.832 0.085 281.4 / 12%)",
  "sidebar-accent-foreground": "oklch(0.956 0.005 286.3)",
  "sidebar-border": "oklch(0.28 0.035 298.6)",
  "sidebar-ring": "oklch(0.713 0.151 277.7)",
};

export const scheme = { light, dark } as const;

export type Mode = keyof typeof scheme;

export const TOKENS = Object.keys(MEANING) as Token[];

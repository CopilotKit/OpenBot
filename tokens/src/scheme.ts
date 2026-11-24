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
 * Three surfaces, darkest to lightest, the way Linear draws them: the frame (the sidebar's tint,
 * which the window edge shares), the panel the page sits in, and the white cards on it. The frame
 * is CopilotKit's pale lavender, the grays lean towards its lilac, the ring is its periwinkle, and
 * the selected sidebar row is a lilac tint.
 */
const light: Palette = {
  background: "oklch(0.983 0.003 286.4)",
  foreground: "oklch(0.108 0.015 220.9)",
  card: "oklch(1 0 0)",
  "card-foreground": "oklch(0.108 0.015 220.9)",
  popover: "oklch(1 0 0)",
  "popover-foreground": "oklch(0.108 0.015 220.9)",
  primary: "oklch(0.108 0.015 220.9)",
  "primary-foreground": "oklch(1 0 0)",
  secondary: "oklch(0.956 0.005 286.3)",
  "secondary-foreground": "oklch(0.108 0.015 220.9)",
  muted: "oklch(0.956 0.005 286.3)",
  "muted-foreground": "oklch(0.506 0.013 285.9)",
  accent: "oklch(0.956 0.005 286.3)",
  "accent-foreground": "oklch(0.108 0.015 220.9)",
  destructive: "oklch(0.504 0.178 22.9)",
  success: "oklch(0.514 0.1 167.2)",
  warning: "oklch(0.555 0.163 49)",
  border: "oklch(0.894 0.014 286.1)",
  input: "oklch(0.894 0.014 286.1)",
  ring: "oklch(0.644 0.167 276.1)",
  "chart-1": "oklch(0.869 0.022 252.894)",
  "chart-2": "oklch(0.554 0.046 257.417)",
  "chart-3": "oklch(0.446 0.043 257.281)",
  "chart-4": "oklch(0.372 0.044 257.287)",
  "chart-5": "oklch(0.279 0.041 260.031)",
  "empty-pattern-color": "oklch(0.746 0.117 279.9)",
  sidebar: "oklch(0.948 0.011 286.2)",
  "sidebar-foreground": "oklch(0.108 0.015 220.9)",
  "sidebar-primary": "oklch(0.108 0.015 220.9)",
  "sidebar-primary-foreground": "oklch(1 0 0)",
  "sidebar-accent": "oklch(0.832 0.085 281.4 / 30%)",
  "sidebar-accent-foreground": "oklch(0.108 0.015 220.9)",
  "sidebar-border": "oklch(0.894 0.014 286.1)",
  "sidebar-ring": "oklch(0.644 0.167 276.1)",
};

/*
 * The same three surfaces on a near-black plum ground: the frame darkest, the cards lightest.
 * Secondary and muted fills are lighter than the cards, as shadcn's dark fills are, so a button or
 * badge never reads as a hole.
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

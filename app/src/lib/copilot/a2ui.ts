import type { CopilotKitProviderProps } from "@copilotkit/react-core/v2";
import {
  createGenerativeUI,
  type GenerativeUITheme,
  standardUI,
} from "@copilotkit/react-core/v2/generative-ui";

/**
 * The A2UI 1.0 basic components: the same set the A2UI 0.9 basic catalog drew before. These are
 * declarative primitives, not the separately granted OpenBot gallery components.
 */
export const A2UI_BASIC_COMPONENTS = [
  "Text",
  "Image",
  "Icon",
  "Video",
  "AudioPlayer",
  "Row",
  "Column",
  "List",
  "Card",
  "Tabs",
  "Divider",
  "Modal",
  "Button",
  "CheckBox",
  "TextField",
  "DateTimeInput",
  "ChoicePicker",
  "Slider",
] as const;

const basic: ReadonlySet<string> = new Set(A2UI_BASIC_COMPONENTS);

/**
 * The components a Bot can draw an interface from: CopilotKit's standard catalog, cut down to the
 * A2UI 1.0 basic components, which it carries under their A2UI names. The rest of the standard
 * catalog stays out until an admin can see and govern it.
 */
export const OPENBOT_UI = createGenerativeUI({
  id: "openbot/ui@1",
  extends: [
    standardUI.omit(
      Object.keys(standardUI.manifestComponents).filter(
        (name) => !basic.has(name),
      ) as Parameters<typeof standardUI.omit>[0],
    ),
  ],
  components: {},
});

const radius = (scale: number) => `calc(var(--radius) * ${scale})`;

/**
 * OpenBot's tokens, by reference. They switch under `.dark` themselves, so one set covers both
 * schemes, and set at the top level they outrank the SDK's built-in dark values. Status tints,
 * highlights and shadows have no OpenBot token and keep the SDK's light and dark values.
 *
 * The font is spelled out rather than `var(--font-sans)`: that one lives in `@theme inline`, which
 * Tailwind inlines into utilities instead of emitting as a variable.
 */
export const OPENBOT_UI_THEME: GenerativeUITheme = {
  "--a2ui-font-family":
    '"Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif',
  "--a2ui-color-text-default": "var(--foreground)",
  "--a2ui-color-text-prose": "var(--foreground)",
  "--a2ui-color-text-primary": "var(--foreground)",
  "--a2ui-color-text-emphasis": "var(--foreground)",
  "--a2ui-color-text-secondary": "var(--muted-foreground)",
  "--a2ui-color-text-tertiary": "var(--muted-foreground)",
  "--a2ui-color-text-success": "var(--success)",
  "--a2ui-color-text-danger": "var(--destructive)",
  "--a2ui-color-surface": "var(--card)",
  "--a2ui-color-surface-secondary": "var(--muted)",
  "--a2ui-color-surface-tertiary": "var(--accent)",
  "--a2ui-color-surface-elevated": "var(--popover)",
  "--a2ui-color-surface-elevated-secondary": "var(--muted)",
  "--a2ui-color-surface-inverted": "var(--foreground)",
  "--a2ui-color-surface-soft": "var(--muted)",
  "--a2ui-color-success-solid": "var(--success)",
  "--a2ui-color-danger-solid": "var(--destructive)",
  "--a2ui-color-border-default": "var(--border)",
  "--a2ui-color-border-subtle": "var(--border)",
  "--a2ui-color-border-strong": "var(--input)",
  "--a2ui-color-border-control": "var(--input)",
  "--a2ui-color-border-success": "var(--success)",
  "--a2ui-color-border-danger": "var(--destructive)",
  "--a2ui-color-accent": "var(--primary)",
  "--a2ui-color-on-accent": "var(--primary-foreground)",
  "--a2ui-color-panel": "var(--popover)",
  "--a2ui-color-control": "var(--background)",
  "--a2ui-color-focus": "var(--ring)",
  "--a2ui-color-badge-secondary": "var(--secondary)",
  "--a2ui-radius-sm": radius(0.6),
  "--a2ui-radius-md": radius(0.8),
  "--a2ui-radius-lg": radius(1),
  "--a2ui-radius-xl": radius(1.4),
  "--a2ui-radius-2xl": radius(1.8),
  "--a2ui-radius-3xl": radius(2.2),
  "--a2ui-radius-4xl": radius(2.6),
};

const GENERATIVE_UI = {
  ui: OPENBOT_UI,
  theme: OPENBOT_UI_THEME,
} satisfies NonNullable<CopilotKitProviderProps["generativeUI"]>;

/**
 * Prop presence is what makes the browser send the catalog, so an unresolved or disabled capability
 * must omit it. The server refuses the tool on its own as well; see server/src/copilot.ts.
 */
export function generativeUiProviderOptions(enabled: boolean | undefined) {
  return enabled ? { generativeUI: GENERATIVE_UI } : {};
}

/**
 * The 50-action notice, drawn in the page. A page cannot load the extension's stylesheet into its own document, so the
 * colours are copied from app/src/theme.css (`:root` and `.dark`) and a test keeps them equal. The recording mark
 * (indicator.ts) draws with the same ones. The shadow root is open
 * so the end-to-end test can drive it, which means a page script can reach the buttons too: every handler acts only on
 * trusted events.
 */

export const NOTICE_TAG = "openbot-recorder-notice";

export const NOTICE_TOKENS = {
  light: {
    "--background": "#f6f6f8",
    "--foreground": "#18181b",
    "--card": "#ffffff",
    "--card-foreground": "#18181b",
    "--border": "rgb(24 24 27 / 9%)",
    "--primary": "#111114",
    "--primary-foreground": "#ffffff",
    "--secondary": "#f1f1f4",
    "--muted-foreground": "#6b6b75",
    "--destructive": "#b91c1c",
    "--ring": "#6430ab",
  },
  dark: {
    "--background": "#111113",
    "--foreground": "#f4f4f5",
    "--card": "#1c1c1f",
    "--card-foreground": "#f4f4f5",
    "--border": "rgb(255 255 255 / 10%)",
    "--primary": "#f4f4f5",
    "--primary-foreground": "#111114",
    "--secondary": "#26262b",
    "--muted-foreground": "#8e8e98",
    "--destructive": "#f87171",
    "--ring": "#b49ae8",
  },
} as const;

export const RADIUS = "0.55rem";

type Choice = "stop" | "restart" | "continue";

export function declarations(tokens: Record<string, string>): string {
  return Object.entries(tokens)
    .map(([name, value]) => `${name}: ${value};`)
    .join(" ");
}

const STYLE = `
:host {
  all: initial;
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483647;
  --radius: ${RADIUS};
  ${declarations(NOTICE_TOKENS.light)}
}
@media (prefers-color-scheme: dark) {
  :host { ${declarations(NOTICE_TOKENS.dark)} }
}
.card {
  box-sizing: border-box;
  width: 320px;
  max-width: calc(100vw - 32px);
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) * 1.4);
  background: var(--card);
  color: var(--card-foreground);
  box-shadow: 0 8px 24px oklch(0 0 0 / 14%), 0 2px 6px oklch(0 0 0 / 8%);
  font-family: "Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.45;
}
h2 { margin: 0 0 4px; font-size: 14px; font-weight: 600; color: var(--card-foreground); }
p { margin: 0 0 14px; color: var(--muted-foreground); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
button {
  box-sizing: border-box;
  height: 28px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: calc(var(--radius) * 0.8);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  outline: none;
}
button:focus-visible { border-color: var(--ring); box-shadow: 0 0 0 3px color-mix(in oklch, var(--ring) 50%, transparent); }
button.primary { background: var(--primary); color: var(--primary-foreground); }
button.primary:hover { background: color-mix(in oklch, var(--primary) 80%, transparent); }
button.ghost { background: transparent; color: var(--foreground); }
button.ghost:hover { background: var(--border); }
`;

export function showNotice(options: {
  actions: number;
  choose(choice: Choice): void;
  isTrusted?: (event: Event) => boolean;
}): { remove(): void; host: HTMLElement } {
  const trusted = options.isTrusted ?? ((event: Event) => event.isTrusted);
  const host = document.createElement(NOTICE_TAG);
  host.setAttribute("data-copilotkit-ignore", "");
  const root = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = STYLE;

  const card = document.createElement("div");
  card.className = "card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-live", "polite");
  card.setAttribute(
    "aria-label",
    `You have recorded ${options.actions} or more actions`,
  );

  const title = document.createElement("h2");
  // It shows once, at the threshold, while the count goes on: "or more" keeps it true, in the same words as the popup.
  title.textContent = `You have recorded ${options.actions} or more actions`;
  const body = document.createElement("p");
  body.textContent =
    "Click Stop if the task is done, start over if it went wrong, or keep going if it needs more.";
  const actions = document.createElement("div");
  actions.className = "actions";

  const add = (label: string, className: string, choice: Choice) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", (event) => {
      if (!trusted(event)) return;
      options.choose(choice);
    });
    actions.append(button);
  };
  add("Stop", "primary", "stop");
  add("Start over", "ghost", "restart");
  add("Keep going", "ghost", "continue");

  root.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key !== "Escape" || !trusted(event)) return;
    options.choose("continue");
  });

  card.append(title, body, actions);
  root.append(style, card);
  document.documentElement.append(host);

  return { host, remove: () => host.remove() };
}

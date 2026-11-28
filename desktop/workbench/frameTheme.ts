/*
 * The frame forces its theme by rewriting the window's own dark media rules at run time. The
 * iframe's `color-scheme` alone does not set `prefers-color-scheme` inside it, and the window's
 * only dark/light switch is the `@media (prefers-color-scheme: dark)` block in styles.css, so
 * styles.css does not change: a dark frame turns that media query into `all`, a light frame
 * into `not all`.
 */
export type Theme = "light" | "dark";

declare global {
  var __workbenchSetTheme: ((theme: Theme) => void) | undefined;
}

/** The media text each rewritten rule had before the first rewrite. */
const original = new WeakMap<object, string>();

/** The theme forced on each document, so later sheets get it too. */
const forced = new WeakMap<Document, Theme>();

function isDarkQuery(text: string): boolean {
  return text.replace(/\s+/g, " ").includes("prefers-color-scheme: dark");
}

function rewriteRules(rules: CSSRuleList | undefined, theme: Theme): void {
  if (!rules) return;
  for (const rule of Array.from(rules)) {
    const media = (rule as CSSMediaRule).media;
    if (media) {
      const text = original.get(rule) ?? media.mediaText;
      if (isDarkQuery(text)) {
        if (!original.has(rule)) original.set(rule, text);
        media.mediaText = theme === "dark" ? "all" : "not all";
      }
    }
    // @media, @supports and @layer all nest rules.
    const nested = (rule as CSSGroupingRule).cssRules;
    if (nested?.length) rewriteRules(nested, theme);
  }
}

function rewriteSheet(sheet: CSSStyleSheet, theme: Theme): void {
  let rules: CSSRuleList;
  try {
    rules = sheet.cssRules;
  } catch {
    return; // a cross-origin sheet hides its rules
  }
  rewriteRules(rules, theme);
}

/** Force the document's theme. With no theme, do nothing: the frame follows the system. */
export function forceTheme(doc: Document, theme?: Theme): void {
  if (!theme) return;
  forced.set(doc, theme);
  for (const sheet of Array.from(doc.styleSheets)) rewriteSheet(sheet, theme);
}

/**
 * Keep the forced theme on sheets added later. Vite in dev injects CSS as <style> tags added to
 * the head, so a <style> is handled at once and a <link rel=stylesheet> on its load event.
 * Returns a stop function.
 */
export function watchTheme(doc: Document): () => void {
  const apply = () => forceTheme(doc, forced.get(doc));
  const isStyle = (node: Node | null) => node?.nodeName === "STYLE";
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (isStyle(record.target) || isStyle(record.target.parentNode)) apply();
      for (const node of Array.from(record.addedNodes)) {
        const element = node as Element;
        if (element.nodeName === "STYLE") {
          apply();
        } else if (
          element.nodeName === "LINK" &&
          element.getAttribute("rel") === "stylesheet"
        ) {
          element.addEventListener("load", apply, { once: true });
        }
      }
    }
  });
  observer.observe(doc.head, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  globalThis.__workbenchSetTheme = (theme: Theme) => forceTheme(doc, theme);
  return () => {
    observer.disconnect();
    delete globalThis.__workbenchSetTheme;
  };
}

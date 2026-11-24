import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Kbd } from "../src/components/ui/kbd";

/*
 * A shortcut's keys (Settings, Keyboard shortcuts) as the UI Kit's "Keyboard shortcuts" draws them:
 * a modifier as Figma's drawing in the current kit, its own character for a screen reader and for
 * the legacy kit, and a letter as itself.
 */

test("a modifier carries Figma's drawing, and keeps its character for a screen reader", () => {
  for (const symbol of ["⇧", "⌘", "⌥"]) {
    const html = renderToStaticMarkup(<Kbd>{symbol}</Kbd>);
    expect(html).toContain(`<span class="kit:sr-only">${symbol}</span>`);
    expect(html).toMatch(
      /<svg aria-hidden="true" class="hidden size-4 kit:block"[^>]*><path d="M/,
    );
  }
});

test("a letter, and a key named in words away from a Mac, is its own text", () => {
  for (const key of ["N", "K", "Shift", "Ctrl"]) {
    const html = renderToStaticMarkup(<Kbd>{key}</Kbd>);
    expect(html).not.toContain("<svg");
    expect(html).toContain(`>${key}</kbd>`);
  }
});

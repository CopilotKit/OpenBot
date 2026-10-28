import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * Found live: in OpenDuet's 430px column a conversation's composer ran flush to the screen's edges,
 * its focus ring on the edge, where OpenDuet floats it inset. The skin insets the column OpenBot
 * marks with the `composer-column` hook; this holds the two sides of that hook together, so a
 * change to either one fails here rather than silently putting the composer back on the edge.
 */

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

test("OpenBot marks a conversation's composer column with its hook", () => {
  const view = read("../src/components/channels/conversation-view.tsx");
  expect(view).toMatch(
    /<div\s+className="[^"]*"\s+data-slot="composer-column"\s*>\s*\{notice\}\s*<Composer/,
  );
});

test("the OpenDuet skin insets that column, by the hook and only inside its frame", () => {
  const css = read("../src/skins/openduet/skin.css").replace(/\s+/g, " ");
  const rule = css.match(
    /\[data-skin="openduet"\] \[data-openduet-frame\] \[data-slot="composer-column"\] \{([^}]*)\}/,
  );
  expect(rule?.[1]).toContain("padding-inline: 12px");
  // No selector in the skin reaches OpenBot's markup by its classes or its words.
  expect(css).not.toMatch(/\.px-0|aria-label=/);
});

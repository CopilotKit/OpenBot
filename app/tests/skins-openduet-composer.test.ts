import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * Found live: in OpenDuet's 430px column a conversation's composer ran flush to the screen's edges,
 * its focus ring on the edge, where OpenDuet floats it inset. The skin insets it by matching the
 * wrapper OpenBot draws it in; this holds the two sides of that match together, so a change to
 * either one fails here rather than silently putting the composer back on the edge.
 */

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

test("OpenBot draws a conversation's composer in a wrapper with no side padding", () => {
  const view = read("../src/components/channels/conversation-view.tsx");
  expect(view).toMatch(
    /<div\s+className="[^"]*\bpx-0\b[^"]*"[^>]*>\s*\{notice\}\s*<Composer/,
  );
});

test("the OpenDuet skin insets that wrapper, and only inside its frame", () => {
  const css = read("../src/skins/openduet/skin.css").replace(/\s+/g, " ");
  const rule = css.match(
    /\[data-skin="openduet"\] \[data-openduet-frame\] \.px-0:has\(> div > form \[aria-label="Message"\]\) \{([^}]*)\}/,
  );
  expect(rule?.[1]).toContain("padding-inline: 12px");
});

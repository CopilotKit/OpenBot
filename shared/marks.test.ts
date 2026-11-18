import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

/*
 * Mastra rebranded in November 2025 (mastra.ai/blog/rebrand). The orb the icon sets still carry is
 * the old mark, and the New Bot sheet showed it beside Mastra's name.
 * The current mark is the glyph inside Mastra's own favicon, so the vendored file holds that glyph's
 * path exactly as published and this pins it: anyone can re-fetch the source and compare the hash.
 *
 *   curl -s https://mastra.ai/favicon/new-brand/icon.svg
 *   (the white path; its `d` attribute hashes to the value below)
 */
const OFFICIAL_GLYPH_SHA256 =
  "ef16163e97a2014cc732ed66437a27c7ba955662d28923f231a5428ede499d5a";

/** The start of the old orb's outline, as @lobehub/icons-static-svg@1.103.0 still ships it. */
const OLD_ORB = "M11.99.083c6.575 0 11.905 5.332 11.905 11.907";

const svg = await Bun.file(`${import.meta.dir}/marks/mastra.svg`).text();

test("Mastra's mark is the current one from Mastra's own site, not the old orb", () => {
  expect(svg).not.toContain(OLD_ORB);
  const paths = [...svg.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]);
  expect(paths).toHaveLength(1);
  const hash = createHash("sha256")
    .update(paths[0] ?? "")
    .digest("hex");
  expect(hash).toBe(OFFICIAL_GLYPH_SHA256);
});

test("Mastra's mark is drawn like the other single-colour marks", () => {
  expect(svg).toContain('viewBox="0 0 24 24"');
  expect(svg).toContain('fill="currentColor"');
  expect(svg).toContain('width="1em"');
  expect(svg).toContain("<title>Mastra</title>");
});

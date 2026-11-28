import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { classes } from "./ui-look-rules";

/*
 * A conversation row's second voice (its time, the "Working" label and the preview line) stays at
 * the 12px it has always had. text-xs (11.25px) would make it smaller, which the look rules out,
 * and text-sm (13.1px) made it the title's size, so the row lost its hierarchy.
 */

const source = readFileSync(
  new URL(
    "../src/components/app-sidebar/channel-item-content.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("the time, the Working label and the preview line are 12px", () => {
  const secondary = source
    .split("\n")
    .filter(
      (line) =>
        /text-(success|muted-foreground)/.test(line) && /leading-4/.test(line),
    );
  expect(secondary).toHaveLength(3);
  for (const line of secondary) {
    const names = classes(line);
    expect(names).toContain("text-[12px]");
    expect(names).not.toContain("text-sm");
  }
});

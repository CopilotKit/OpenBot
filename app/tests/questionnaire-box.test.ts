import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { classes } from "./ui-look-rules";

/*
 * An unticked choice box is nothing but its edge. `border-input` is about 1.3:1 on the app's
 * surfaces, so in dark the box all but disappears. The tickbox's own edge, `border-muted-foreground`,
 * meets WCAG 1.4.11's 3:1 (checkbox-contrast.test.tsx checks it in a browser); the questionnaire's
 * box draws the same thing and takes the same edge.
 */

const source = readFileSync(
  new URL("../src/components/ui/questionnaire.tsx", import.meta.url),
  "utf8",
);

test("a questionnaire's choice box has the tickbox's edge", () => {
  const box = source
    .split("\n")
    .find((line) =>
      line.includes(
        "group-data-[type=radio]/questionnaire-choice:rounded-full",
      ),
    );
  expect(box).toBeDefined();
  const names = classes(box ?? "");
  expect(names).toContain("border-muted-foreground");
  expect(names).not.toContain("border-input");
});

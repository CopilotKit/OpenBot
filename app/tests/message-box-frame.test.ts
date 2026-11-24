import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MESSAGE_BOX_FRAME } from "@/components/channels/composer/frame";

/*
 * The message box (docs/app-guidelines.md, "The look"): a flat card at rest, glowing in the focus
 * color only while someone types in it. It is the one thing in the app that glows.
 */

const classes = MESSAGE_BOX_FRAME.split(/\s+/).filter(Boolean);

describe("the message box's frame", () => {
  test("at rest it is a flat hairline card", () => {
    expect(classes).toEqual(
      expect.arrayContaining([
        "rounded-xl",
        "border",
        "border-border",
        "bg-card",
      ]),
    );
    const atRest = classes.filter((name) => !name.startsWith("focus-within:"));
    expect(atRest.filter((name) => /^(shadow|ring)-/.test(name))).toEqual([]);
  });

  test("it glows only while it has focus", () => {
    expect(classes).toEqual(
      expect.arrayContaining([
        "focus-within:border-ring/60",
        "focus-within:ring-4",
        "focus-within:ring-ring/15",
        "focus-within:shadow-lg",
        "focus-within:shadow-ring/20",
      ]),
    );
  });

  test("the glow eases in, and not at all with reduced motion", () => {
    expect(classes).toEqual(
      expect.arrayContaining([
        "transition-[border-color,box-shadow]",
        "duration-150",
        "motion-reduce:transition-none",
      ]),
    );
  });

  test("both of the composer's frames use it", () => {
    const composer = readFileSync(
      new URL(
        "../src/components/channels/composer/composer.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(
      composer.match(/MESSAGE_BOX_FRAME/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(3);
    expect(composer).not.toContain("rounded-2xl");
  });
});

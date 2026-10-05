import { describe, expect, test } from "bun:test";
import { oneLine } from "../src/channels/text";

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemesOf = (value: string): string[] =>
  Array.from(SEGMENTER.segment(value), (each) => each.segment);

/** South Korea: two regional indicators. Cut between them and one letter is left in a box. */
const FLAG = "\u{1F1F0}\u{1F1F7}";
/** Man, woman, girl, joined. Cut anywhere and a zero-width joiner dangles off the end. */
const FAMILY = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
/** A thumbs-up plus a skin-tone modifier. Cut and the modifier is dropped. */
const THUMB = "\u{1F44D}\u{1F3FD}";
/** Digit, variation selector, enclosing keycap. Cut and it is a bare 1. */
const KEYCAP = "1\u{FE0F}\u{20E3}";

describe("oneLine", () => {
  /*
   * The guard against over-correcting. Every one of these passes on the previous implementation
   * too: the cut lands in the same place, the ellipsis replaces the same last unit, and control
   * characters and runs of whitespace are still flattened. Only the definition of "one unit" moved.
   */
  test("leaves a short line alone", () => {
    expect(oneLine("Deploy the staging build", 200)).toBe(
      "Deploy the staging build",
    );
  });

  test("flattens control characters and collapses whitespace", () => {
    expect(oneLine("one\ttwo  three\nfour", 200)).toBe("one two three four");
  });

  test("cuts plain text to the cap, ellipsis included", () => {
    expect(oneLine("abcdefghij", 5)).toBe("abcd…");
    expect(graphemesOf(oneLine("abcdefghij", 5))).toHaveLength(5);
  });

  test("keeps a single-code-point emoji whole", () => {
    expect(oneLine(`aaaa\u{1F600}bbbb`, 5)).toBe("aaaa…");
  });

  /*
   * The bug. `Array.from` walks code points, and every emoji below is made of more than one, so the
   * cut landed inside the emoji the docstring promised never to split.
   */
  test.each([
    ["a flag", FLAG],
    ["a joined family", FAMILY],
    ["a skin-tone thumb", THUMB],
    ["a keycap", KEYCAP],
  ])("never cuts %s in half", (_name, emoji) => {
    const line = `${emoji} report`;
    const whole = graphemesOf(line);

    // Every cap from 1 up past the whole line, so no single lucky boundary can carry the test.
    for (let cap = 1; cap <= whole.length + 2; cap += 1) {
      const cut = oneLine(line, cap);
      const kept = cut.endsWith("…") ? cut.slice(0, -1) : cut;

      expect(graphemesOf(cut).length).toBeLessThanOrEqual(cap);
      // What survives is a whole number of the line's own clusters, taken from the front. Anything
      // split in half fails here, because its pieces are not clusters of the original.
      expect(graphemesOf(kept)).toEqual(
        whole.slice(0, graphemesOf(kept).length),
      );
    }
  });

  test("cuts between emoji rather than inside one", () => {
    // Three clusters, sixteen UTF-16 units, five code points' worth of joiners and modifiers
    // between them. A cap of three is the whole line; a cap of two keeps one emoji and the ellipsis.
    expect(oneLine(`${FLAG}${FAMILY}${THUMB}`, 3)).toBe(
      `${FLAG}${FAMILY}${THUMB}`,
    );
    expect(oneLine(`${FLAG}${FAMILY}${THUMB}`, 2)).toBe(`${FLAG}…`);
  });
});

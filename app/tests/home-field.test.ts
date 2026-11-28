import { describe, expect, test } from "bun:test";
import {
  createHomeIntro,
  fieldEnergy,
  HOME_FIELD_COLORS,
} from "@/lib/home-field";
import { ORB_PALETTES } from "@/lib/orb-palette";

/*
 * The orb's field behind Home's message box (docs/superpowers/specs, home orb field): its colours,
 * how strongly typing lights it, and the intro that plays on the first Home of a visit only.
 */

const hex = (value: string) =>
  [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16) / 255);

describe("the field's colours", () => {
  test("are the orb's own: periwinkle, sky, violet, pink and the Bot green", () => {
    const periwinkle = ORB_PALETTES[2];
    expect(HOME_FIELD_COLORS.map((c) => c.map((v) => v.toFixed(3)))).toEqual(
      [
        hex(periwinkle.c2),
        hex(periwinkle.c1),
        hex(periwinkle.c3),
        hex("#f153aa"),
        hex(ORB_PALETTES[0].c1),
      ].map((c) => c.map((v) => v.toFixed(3))),
    );
  });
});

describe("typing lights the field", () => {
  test("not at all while the box is not focused, even with words in it", () => {
    expect(fieldEnergy({ focused: false, hasText: true })).toBe(0);
  });
  test("a little while the box is focused and empty", () => {
    expect(fieldEnergy({ focused: true, hasText: false })).toBe(0.3);
  });
  test("fully while the person is writing in it", () => {
    expect(fieldEnergy({ focused: true, hasText: true })).toBe(1);
  });
});

/** A session's storage, as the browser's sessionStorage behaves. */
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("the first-view intro", () => {
  test("plays on the first Home of a visit", () => {
    expect(createHomeIntro(memoryStorage()).plays()).toBe(true);
  });

  test("does not play again once it has played, in this tab or after a reload", () => {
    const storage = memoryStorage();
    const first = createHomeIntro(storage);
    first.played();
    expect(first.plays()).toBe(false);
    // A reload starts the module again with the same session.
    expect(createHomeIntro(storage).plays()).toBe(false);
  });

  test("asking twice before it has played gives the same answer, as a re-render asks twice", () => {
    const intro = createHomeIntro(memoryStorage());
    expect([intro.plays(), intro.plays()]).toEqual([true, true]);
  });

  test("with no session storage (a privacy mode that throws) it still plays once per load", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const intro = createHomeIntro(throwing);
    expect(intro.plays()).toBe(true);
    intro.played();
    expect(intro.plays()).toBe(false);
  });
});

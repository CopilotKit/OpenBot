import { describe, expect, test } from "bun:test";
import { frameFiring, readFiring } from "./routine-firing";

const INSTRUCTION =
  "Visit https://hackernews.com, identify the top-ranked result on the page, and post its title and link.";

describe("frameFiring", () => {
  test("puts the three frame sentences above the instruction", () => {
    expect(frameFiring(INSTRUCTION)).toBe(
      [
        "One of your routines is firing right now, on its schedule, and this is that firing.",
        "Carry out the instruction below in this turn: do the work now, then say what happened.",
        "Do not create, list or change any routine unless the instruction itself asks you to.",
        "",
        INSTRUCTION,
      ].join("\n"),
    );
  });
});

describe("readFiring", () => {
  test("gives back exactly the instruction that was framed", () => {
    expect(readFiring(frameFiring(INSTRUCTION))).toBe(INSTRUCTION);
  });

  test("keeps an instruction that runs over several lines whole", () => {
    const multi = "Check the board.\n\nThen post what changed.";
    expect(readFiring(frameFiring(multi))).toBe(multi);
  });

  test("says no to a message a person wrote themselves", () => {
    expect(readFiring("Check hackernews every 30 minutes")).toBeNull();
  });

  test("says no to a message that only quotes one frame sentence", () => {
    expect(
      readFiring(
        "One of your routines is firing right now, on its schedule, and this is that firing.",
      ),
    ).toBeNull();
  });
});

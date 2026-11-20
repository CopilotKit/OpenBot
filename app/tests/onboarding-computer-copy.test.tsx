import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Onboarding's introduction promised "Each Bot has its own computer". Bots now share one computer
 * per person, each with its own browser and folder there, and only an Isolated Bot gets a computer
 * of its own, so the scene says what every Bot does get.
 *
 * Read from the reel's source rather than rendered: the introduction is an `AnimatePresence` loop,
 * and under happy-dom an exiting scene never reports finished (see `collapse.tsx`), so a render
 * never reaches the second scene. What regressed was the words, and this pins the words.
 */
const reel = readFileSync(
  new URL("../src/components/onboarding/demos/intro-reel.tsx", import.meta.url),
  "utf8",
);

test("onboarding says what every Bot gets, not a computer of its own", () => {
  expect(reel).toContain(
    "Bots use a browser and files of their own, apart from yours.",
  );
  expect(reel).not.toMatch(/its own computer/);
});

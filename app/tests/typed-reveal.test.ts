import { expect, test } from "bun:test";
import {
  isNaming,
  TYPING_MAX_SECONDS,
  typingSeconds,
} from "../src/lib/typed-reveal";

test("a line that gains a name is a naming", () => {
  expect(isNaming(undefined, "Travel receipt rules")).toBe(true);
});

test("a row that arrives already named is not", () => {
  // Every row on every load takes this path. Treating it as an arrival is what would set the whole
  // roster typing at once when somebody opens the app.
  expect(isNaming("Travel receipt rules", "Travel receipt rules")).toBe(false);
});

test("a name replaced by another name is not an arrival either", () => {
  // Nothing does this today. If something ever does, replaying the arrival would misdescribe it.
  expect(isNaming("An older subject", "A newer subject")).toBe(false);
});

test("losing a name is not an arrival", () => {
  expect(isNaming("Travel receipt rules", undefined)).toBe(false);
});

test("longer names type for longer, at the same speed", () => {
  // Constant motion: twice the characters, twice the time, until the ceiling.
  expect(typingSeconds(20)).toBeCloseTo(typingSeconds(10) * 2, 5);
});

test("a very long name is capped rather than outstaying the moment", () => {
  expect(typingSeconds(500)).toBe(TYPING_MAX_SECONDS);
});

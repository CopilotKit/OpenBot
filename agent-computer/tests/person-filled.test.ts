import { expect, test } from "bun:test";
import {
  inputFills,
  keyFills,
  MASKED_VALUE,
  maskSensitiveValues,
  PERSON_FILLED_VALUE,
} from "../src/secret-masking";

/**
 * Which of a person's inputs on a Bot's screen fill the field in focus, so the field is marked as theirs and the Bot
 * reads only that it was filled (secret-masking.ts). The inputs are the live screen's own, as the app sends them. A key
 * that only moves the focus or submits must not mark the field it lands in: the Bot would then read its own value as
 * the person's.
 */
test("characters, deletions, pastes and text fill the field; Tab, Enter and Escape do not; arrows choose", () => {
  const down = (key: string, text?: string) =>
    inputFills({
      type: "key",
      event: "down",
      key,
      code: key,
      ...(text === undefined ? {} : { text }),
    });
  expect(down("5", "5")).toBe("typed");
  expect(down("Backspace")).toBe("typed");
  expect(down("Delete")).toBe("typed");
  // A paste: the person's shortcut arrives as its letter with a modifier held.
  expect(down("v")).toBe("typed");
  expect(inputFills({ type: "text", text: "555-0100" })).toBe("typed");
  for (const key of ["Tab", "Enter", "Escape", "Shift", "F5"])
    expect(down(key)).toBeNull();
  // Enter carries a carriage return as its text, which submits rather than fills.
  expect(down("Enter", "\r")).toBeNull();
  expect(down("ArrowDown")).toBe("chose");
  expect(
    inputFills({ type: "key", event: "up", key: "5", code: "Digit5" }),
  ).toBeNull();
  expect(inputFills({ type: "mouse", event: "released", x: 1, y: 1 })).toBe(
    "chose",
  );
  expect(inputFills({ type: "mouse", event: "moved", x: 1, y: 1 })).toBeNull();
  // The person's input route names a shortcut as Playwright does.
  expect(keyFills("Control+V")).toBe("typed");
  expect(keyFills("Shift+Tab")).toBeNull();
});

test("a field a person filled reads as filled, a secret as sensitive, and the Bot's own value as it is", () => {
  const elements = [
    { ref: "e1", role: "textbox", name: "Name", value: "Ada Lovelace" },
    { ref: "e2", role: "textbox", name: "Telephone", value: "555-0100" },
    { ref: "e3", role: "textbox", name: "Password", value: "hunter2" },
    { ref: "e4", role: "textbox", name: "Notes" },
  ];
  const hidden = new Map([
    ["e2", PERSON_FILLED_VALUE],
    ["e3", MASKED_VALUE],
    ["e4", PERSON_FILLED_VALUE],
  ]);
  expect(
    maskSensitiveValues(elements, hidden).map((element) => element.value),
  ).toEqual([
    "Ada Lovelace",
    "[hidden: filled in by the person]",
    "[hidden: sensitive field]",
    undefined,
  ]);
});

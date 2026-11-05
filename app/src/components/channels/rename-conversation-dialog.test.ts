import { expect, test } from "bun:test";
import { renameableTitle } from "./rename-conversation-dialog";

test("a real name stays as it was typed, whitespace collapsed", () => {
  expect(renameableTitle("Fix the login flow")).toBe("Fix the login flow");
  expect(renameableTitle("  Fix   the   login   flow  ")).toBe(
    "Fix the login flow",
  );
});

test("control characters and line breaks are flattened to spaces", () => {
  expect(renameableTitle("Fix\nthe\tlogin\nflow")).toBe("Fix the login flow");
});

test("an empty or whitespace-only name is refused", () => {
  expect(renameableTitle("")).toBeNull();
  expect(renameableTitle("   ")).toBeNull();
  expect(renameableTitle("\n\n")).toBeNull();
});

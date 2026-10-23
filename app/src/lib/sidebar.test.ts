import { expect, test } from "bun:test";
import {
  clampSidebarWidth,
  parseStoredSidebarWidth,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "./sidebar";

test("a stored width is used only when it is a number of pixels within bounds", () => {
  expect(parseStoredSidebarWidth("312", "340px")).toBe("312px");
  expect(parseStoredSidebarWidth(null, "340px")).toBe("340px");
  expect(parseStoredSidebarWidth("wide", "340px")).toBe("340px");
  expect(parseStoredSidebarWidth("", "340px")).toBe("340px");
  expect(parseStoredSidebarWidth(String(SIDEBAR_MIN_WIDTH - 1), "340px")).toBe(
    "340px",
  );
  expect(parseStoredSidebarWidth(String(SIDEBAR_MAX_WIDTH + 1), "340px")).toBe(
    "340px",
  );
});

test("a dragged width stays between what the footer needs and the maximum", () => {
  expect(clampSidebarWidth(100, 260)).toBe(260);
  expect(clampSidebarWidth(100, 0)).toBe(SIDEBAR_MIN_WIDTH);
  expect(clampSidebarWidth(9999, 260)).toBe(SIDEBAR_MAX_WIDTH);
  expect(clampSidebarWidth(301.6, 260)).toBe(302);
});

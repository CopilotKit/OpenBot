import { describe, expect, test } from "bun:test";
import {
  applyDarkTheme,
  parseStoredDarkTheme,
  THEME_STORAGE_KEY,
} from "../src/lib/theme";

describe("theme preference", () => {
  test("only the stored dark value enables dark theme", () => {
    expect(parseStoredDarkTheme("dark")).toBe(true);
    expect(parseStoredDarkTheme("light")).toBe(false);
    expect(parseStoredDarkTheme(null)).toBe(false);
  });

  test("persists and applies the selected theme", () => {
    const writes: Array<[string, string]> = [];
    const toggles: Array<[string, boolean]> = [];

    applyDarkTheme(true, {
      setStoredValue: (key, value) => writes.push([key, value]),
      toggleRootClass: (name, force) => toggles.push([name, force]),
    });

    expect(writes).toEqual([[THEME_STORAGE_KEY, "dark"]]);
    expect(toggles).toEqual([["dark", true]]);
  });
});

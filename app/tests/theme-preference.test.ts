import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
    const schemes: Array<string> = [];

    applyDarkTheme(true, {
      setStoredValue: (key, value) => writes.push([key, value]),
      toggleRootClass: (name, force) => toggles.push([name, force]),
      setRootColorScheme: (scheme) => schemes.push(scheme),
    });

    expect(writes).toEqual([[THEME_STORAGE_KEY, "dark"]]);
    expect(toggles).toEqual([["dark", true]]);
    expect(schemes).toEqual(["dark"]);
  });
});

describe("color scheme", () => {
  const styles = readFileSync(
    new URL("../src/theme.css", import.meta.url),
    "utf8",
  );

  test("both themes tell the browser which one they are", () => {
    expect(styles).toMatch(/:root\s*\{[\s\S]*?color-scheme:\s*light/);
    expect(styles).toMatch(/\.dark\s*\{[\s\S]*?color-scheme:\s*dark/);
  });

  // The Recorder's pages import theme.css too, so the chat's own rules live in styles.css.
  test("the shared theme carries no chat-only rule", () => {
    expect(styles).not.toContain("tool-line");
    expect(styles).not.toContain("websandbox");
    const app = readFileSync(
      new URL("../src/styles.css", import.meta.url),
      "utf8",
    );
    expect(app).toContain(".tool-line-running");
    expect(app).toContain("iframe.websandbox__frame");
  });
});

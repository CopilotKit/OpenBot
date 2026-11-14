import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  applyTheme,
  parseStoredTheme,
  resolveDarkTheme,
  THEME_STORAGE_KEY,
} from "../src/lib/theme";

function recorded() {
  const calls: Array<[string, ...Array<string | boolean>]> = [];
  return {
    calls,
    effects: {
      setStoredValue: (key: string, value: string) =>
        calls.push(["set", key, value]),
      removeStoredValue: (key: string) => calls.push(["remove", key]),
      toggleRootClass: (name: string, force: boolean) =>
        calls.push(["class", name, force]),
      setRootColorScheme: (scheme: string) => calls.push(["scheme", scheme]),
    },
  };
}

describe("theme preference", () => {
  test("nothing saved follows the system; a saved light or dark is the person's own", () => {
    expect(parseStoredTheme(null)).toBe("system");
    expect(parseStoredTheme("system")).toBe("system");
    expect(parseStoredTheme("something else")).toBe("system");
    // What every release before this one saved.
    expect(parseStoredTheme("dark")).toBe("dark");
    expect(parseStoredTheme("light")).toBe("light");
  });

  test("the system decides only for somebody who follows it", () => {
    expect(resolveDarkTheme("system", true)).toBe(true);
    expect(resolveDarkTheme("system", false)).toBe(false);
    expect(resolveDarkTheme("light", true)).toBe(false);
    expect(resolveDarkTheme("dark", false)).toBe(true);
  });

  test("an explicit choice is saved and applied over the system's", () => {
    const { calls, effects } = recorded();
    applyTheme("dark", false, effects);
    expect(calls).toEqual([
      ["set", THEME_STORAGE_KEY, "dark"],
      ["class", "dark", true],
      ["scheme", "dark"],
    ]);
  });

  test("following the system saves nothing and applies the system's", () => {
    const { calls, effects } = recorded();
    applyTheme("system", true, effects);
    expect(calls).toEqual([
      ["remove", THEME_STORAGE_KEY],
      ["class", "dark", true],
      ["scheme", "dark"],
    ]);
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

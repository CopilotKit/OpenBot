import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  applyTheme,
  LEGACY_THEME_STORAGE_KEY,
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
      setRootChoice: (choice: string) => calls.push(["choice", choice]),
    },
  };
}

describe("theme preference", () => {
  test("nothing saved follows the system; a saved light or dark is the person's own", () => {
    expect(parseStoredTheme(null)).toBe("system");
    expect(parseStoredTheme("system")).toBe("system");
    expect(parseStoredTheme("something else")).toBe("system");
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
      ["remove", LEGACY_THEME_STORAGE_KEY],
      ["set", THEME_STORAGE_KEY, "dark"],
      ["class", "dark", true],
      ["scheme", "dark"],
      ["choice", "dark"],
    ]);
  });

  test("following the system saves nothing and applies the system's", () => {
    const { calls, effects } = recorded();
    applyTheme("system", true, effects);
    expect(calls).toEqual([
      ["remove", LEGACY_THEME_STORAGE_KEY],
      ["remove", THEME_STORAGE_KEY],
      ["class", "dark", true],
      ["scheme", "dark"],
      ["choice", "system"],
    ]);
  });
});

describe("what earlier releases saved", () => {
  // They saved a light or dark on every visit, so the app must not read it as a choice.
  test("the choice is kept under a key of its own, which the page reads before paint", () => {
    expect(THEME_STORAGE_KEY).not.toBe(LEGACY_THEME_STORAGE_KEY);
    const html = readFileSync(
      new URL("../index.html", import.meta.url),
      "utf8",
    );
    expect(html).toContain(`getItem("${THEME_STORAGE_KEY}")`);
    expect(html).not.toContain(`getItem("${LEGACY_THEME_STORAGE_KEY}")`);
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

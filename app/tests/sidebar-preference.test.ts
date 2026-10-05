import { describe, expect, test } from "bun:test";
import {
  applySidebarOpen,
  parseStoredSidebarOpen,
  SIDEBAR_STORAGE_KEY,
} from "../src/lib/sidebar";

describe("sidebar preference", () => {
  test("only the stored collapsed value starts the sidebar closed", () => {
    expect(parseStoredSidebarOpen("collapsed")).toBe(false);
    expect(parseStoredSidebarOpen("expanded")).toBe(true);
    expect(parseStoredSidebarOpen(null)).toBe(true);
  });

  /*
   * The roster is this app's navigation, so an unreadable value opens the sidebar rather than
   * guessing it shut. A shell that hides its own navigation on a stale key is a shell with no way
   * back.
   */
  test("an unrecognised stored value leaves the sidebar open", () => {
    expect(parseStoredSidebarOpen("")).toBe(true);
    expect(parseStoredSidebarOpen("false")).toBe(true);
    expect(parseStoredSidebarOpen("Collapsed")).toBe(true);
  });

  test("persists both states under the key the reader parses", () => {
    const writes: Array<[string, string]> = [];
    const effects = {
      setStoredValue: (key: string, value: string) => writes.push([key, value]),
    };

    applySidebarOpen(false, effects);
    applySidebarOpen(true, effects);

    expect(writes).toEqual([
      [SIDEBAR_STORAGE_KEY, "collapsed"],
      [SIDEBAR_STORAGE_KEY, "expanded"],
    ]);
  });

  /*
   * The test that matters: the writer and the reader are two functions and nothing but this holds
   * their vocabulary together. Drift here does not throw, it silently stops restoring the state.
   */
  test("a round trip through storage preserves the state", () => {
    for (const open of [true, false]) {
      let stored: string | null = null;
      applySidebarOpen(open, {
        setStoredValue: (_key, value) => {
          stored = value;
        },
      });
      expect(parseStoredSidebarOpen(stored)).toBe(open);
    }
  });
});

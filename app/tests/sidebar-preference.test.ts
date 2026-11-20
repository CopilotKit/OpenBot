import { describe, expect, test } from "bun:test";
import {
  applySidebarOpen,
  LEGACY_APP_SIDEBAR_WIDTH_KEY,
  parseStoredSidebarOpen,
  SIDEBAR_STORAGE_KEY,
  SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  storedSidebarWidth,
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

describe("sidebar width", () => {
  const storage = (entries: Record<string, string>) => (key: string) =>
    entries[key] ?? null;

  test("every shell starts at the app's width until somebody drags one", () => {
    expect(SIDEBAR_WIDTH).toBe("340px");
    expect(storedSidebarWidth(storage({}))).toBe("340px");
  });

  test("a dragged width is shared, ahead of the app's old one", () => {
    expect(
      storedSidebarWidth(
        storage({
          [SIDEBAR_WIDTH_STORAGE_KEY]: "280",
          [LEGACY_APP_SIDEBAR_WIDTH_KEY]: "400",
        }),
      ),
    ).toBe("280px");
  });

  test("the app's old width carries over, and admin's and settings' do not", () => {
    expect(
      storedSidebarWidth(storage({ [LEGACY_APP_SIDEBAR_WIDTH_KEY]: "400" })),
    ).toBe("400px");
    expect(
      storedSidebarWidth(
        storage({
          "openbot-sidebar-width:settings": "250",
          "openbot-sidebar-width:admin": "260",
        }),
      ),
    ).toBe("340px");
  });

  test("a width out of bounds falls back to the default", () => {
    expect(
      storedSidebarWidth(storage({ [SIDEBAR_WIDTH_STORAGE_KEY]: "9000" })),
    ).toBe("340px");
  });
});

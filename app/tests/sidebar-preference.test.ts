import { describe, expect, test } from "bun:test";
import {
  applySidebarOpen,
  clampSidebarWidth,
  LEGACY_APP_SIDEBAR_WIDTH_KEY,
  parseStoredSidebarOpen,
  SIDEBAR_STORAGE_KEY,
  SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  sidebarCeiling,
  sidebarFloor,
  sidebarToggleShown,
  sidebarWidthStyle,
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

/*
 * Beside a strip, the sidebar's width is the strip and the panel together, so the floor a drag
 * stops at is the panel's own floor plus the strip: the panel never gets narrower than it was
 * allowed to be on its own.
 */
describe("the floor a drag stops at", () => {
  test("is the panel's floor with no strip", () => {
    expect(sidebarFloor(0)).toBe(180);
  });

  test("adds the strip's width to the panel's floor", () => {
    expect(sidebarFloor(48)).toBe(228);
  });

  test("holds a drag narrower than the panel's floor at it", () => {
    expect(clampSidebarWidth(100, sidebarFloor(48))).toBe(228);
  });
});

/*
 * The page's "Show sidebar" button is the way back to a hidden panel. On a section with no panel
 * there is nothing to show, and the strip beside the page is the way to Conversations.
 */
describe("the page's Show sidebar button", () => {
  test("shows when the panel is hidden and its section has one", () => {
    expect(
      sidebarToggleShown({
        isMobile: false,
        open: false,
        panelAvailable: true,
      }),
    ).toBe(true);
  });

  test("does not show while the panel is showing", () => {
    expect(
      sidebarToggleShown({ isMobile: false, open: true, panelAvailable: true }),
    ).toBe(false);
  });

  test("does not show on a section with no panel", () => {
    expect(
      sidebarToggleShown({
        isMobile: false,
        open: false,
        panelAvailable: false,
      }),
    ).toBe(false);
  });

  test("always shows in a narrow window, where the sheet starts closed", () => {
    expect(
      sidebarToggleShown({ isMobile: true, open: true, panelAvailable: false }),
    ).toBe(true);
  });
});

/*
 * Admin and Settings share the width and may be dragged to 180px, which beside the strip would
 * leave the panel narrower than it may ever be dragged. And however wide it was left, the sidebar
 * takes no more than two-fifths of the window: zoomed in, the window is fewer of the page's pixels
 * wide and the sidebar would otherwise keep its count of them.
 */
test("the shared width is drawn between the floor and two-fifths of the window", () => {
  expect(sidebarWidthStyle("180px", { besideStrip: true })).toBe(
    "clamp(calc(180px + var(--sidebar-width-icon)), 180px, 40vw)",
  );
  expect(sidebarWidthStyle("480px", { besideStrip: false })).toBe(
    "clamp(180px, 480px, 40vw)",
  );
});

/*
 * "Cannot drag sidebar to make it smaller ... zooming in zooms the entire screen": a window zoomed
 * to 175% is about 820 of the page's pixels wide, so the edge may not be dragged out past two-fifths
 * of that, and a window too narrow for even the floor keeps the floor.
 */
describe("the widest a drag goes", () => {
  test("is the fixed maximum in a wide window", () => {
    expect(sidebarCeiling(1440, 228)).toBe(480);
  });

  test("is two-fifths of a zoomed-in window", () => {
    expect(sidebarCeiling(820, 228)).toBe(328);
    expect(clampSidebarWidth(600, 228, sidebarCeiling(820, 228))).toBe(328);
  });

  test("is never under the floor", () => {
    expect(sidebarCeiling(400, 228)).toBe(228);
    expect(clampSidebarWidth(100, 228, sidebarCeiling(400, 228))).toBe(228);
  });
});

import { describe, expect, test } from "bun:test";
import {
  SETTINGS_GROUPS,
  SETTINGS_SIDEBAR_ITEMS,
} from "../src/components/settings/settings-sidebar";

describe("settings sidebar", () => {
  test("Computer links to /settings/computer, first of Every Bot and before Approvals, and Browsers is part of it", () => {
    const titles = SETTINGS_SIDEBAR_ITEMS.map((item) => item.title);
    const computer = SETTINGS_SIDEBAR_ITEMS[titles.indexOf("Computer")];

    expect(computer?.linkOptions).toEqual({ to: "/settings/computer" });
    expect(
      SETTINGS_SIDEBAR_ITEMS.find((item) => item.group === "every-bot")?.title,
    ).toBe("Computer");
    expect(titles.indexOf("Approvals")).toBe(titles.indexOf("Computer") + 1);
    expect(titles).not.toContain("Browsers");
    expect(titles).not.toContain("This computer");
  });

  test("groups the entries as You, Every Bot and OpenBot, in that order", () => {
    expect(SETTINGS_GROUPS.map((group) => group.label)).toEqual([
      "You",
      "Every Bot",
      "OpenBot",
    ]);
    const order = SETTINGS_GROUPS.map((group) => group.id);
    const groups = SETTINGS_SIDEBAR_ITEMS.map((item) =>
      order.indexOf(item.group),
    );
    expect(groups).toEqual([...groups].sort((a, b) => a - b));
  });

  test("Routines, Memory, Skills and Learning are not in Settings: the first three are in the main menu", () => {
    const titles = SETTINGS_SIDEBAR_ITEMS.map((item) => item.title);
    for (const moved of ["Routines", "Memory", "Skills", "Learning"])
      expect(titles).not.toContain(moved);
  });
});

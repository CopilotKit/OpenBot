import { describe, expect, test } from "bun:test";
import {
  SETTINGS_GROUPS,
  SETTINGS_SIDEBAR_ITEMS,
} from "../src/components/settings/settings-sidebar";

describe("settings sidebar", () => {
  test("Computer links to /settings/computer, between Skills and Approvals, and Browsers is part of it", () => {
    const titles = SETTINGS_SIDEBAR_ITEMS.map((item) => item.title);
    const computer = SETTINGS_SIDEBAR_ITEMS[titles.indexOf("Computer")];

    expect(computer?.linkOptions).toEqual({ to: "/settings/computer" });
    expect(titles.indexOf("Computer")).toBe(titles.indexOf("Skills") + 1);
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

  test("Routines, Memory and Skills follow one another, and Learning is part of Skills", () => {
    const titles = SETTINGS_SIDEBAR_ITEMS.map((item) => item.title);
    const at = (title: string) => titles.indexOf(title);

    expect(at("Memory")).toBe(at("Routines") + 1);
    expect(at("Skills")).toBe(at("Memory") + 1);
    expect(SETTINGS_SIDEBAR_ITEMS[at("Memory")]?.linkOptions).toEqual({
      to: "/settings/memory",
    });
    expect(SETTINGS_SIDEBAR_ITEMS[at("Skills")]?.linkOptions).toEqual({
      to: "/settings/skills",
    });
    expect(titles).not.toContain("Learning");
  });
});

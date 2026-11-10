import { describe, expect, test } from "bun:test";
import { SETTINGS_SIDEBAR_ITEMS } from "../src/components/settings/settings-sidebar";

describe("settings sidebar", () => {
  test("Browsers links to /settings/browsers, right after Approvals", () => {
    const titles = SETTINGS_SIDEBAR_ITEMS.map((item) => item.title);
    const browsers = SETTINGS_SIDEBAR_ITEMS[titles.indexOf("Browsers")];

    expect(browsers?.linkOptions).toEqual({ to: "/settings/browsers" });
    expect(titles.indexOf("Browsers")).toBe(titles.indexOf("Approvals") + 1);
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

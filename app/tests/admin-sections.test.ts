import { describe, expect, test } from "bun:test";
import { ADMIN_SECTIONS } from "@/components/admin/admin-sections";

const to = (linkOptions: unknown) => (linkOptions as { to?: string }).to;

describe("Admin's groups", () => {
  test("follow the eight, then Vault, then the team", () => {
    expect(ADMIN_SECTIONS.map((section) => section.title)).toEqual([
      "Routines",
      "Skills",
      "Apps",
      "Computer",
      "Approvals",
      "Activity",
      "Vault",
      "Team",
    ]);
  });

  test("rename Plugins, Audit, Credentials and Check-ins, and keep their addresses", () => {
    const entries = ADMIN_SECTIONS.flatMap((section) => section.items);
    const titled = (title: string) =>
      to(entries.find((entry) => entry.title === title)?.linkOptions);

    expect(titled("Apps")).toBe("/admin/plugins");
    expect(titled("Activity")).toBe("/admin/audit");
    expect(titled("Vault")).toBe("/admin/credentials");
    expect(titled("Routines")).toBe("/admin/proactive");
    const titles = entries.map((entry) => entry.title);
    for (const retired of ["Plugins", "Audit", "Credentials", "Check-ins"])
      expect(titles).not.toContain(retired);
  });

  test("list every Admin page once", () => {
    const addresses = ADMIN_SECTIONS.flatMap((section) =>
      section.items.map((entry) => to(entry.linkOptions)),
    );
    expect(new Set(addresses).size).toBe(addresses.length);
    expect(addresses.sort()).toEqual(
      [
        "/admin/approvals",
        "/admin/audit",
        "/admin/boundaries",
        "/admin/components",
        "/admin/computers",
        "/admin/credentials",
        "/admin/identity-providers",
        "/admin/learning",
        "/admin/people",
        "/admin/permissions",
        "/admin/playground",
        "/admin/plugins",
        "/admin/proactive",
        "/admin/providers",
        "/admin/skills",
        "/admin/what-if",
      ].sort(),
    );
  });
});

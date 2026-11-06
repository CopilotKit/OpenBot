import { describe, expect, test } from "bun:test";
import { managePaths } from "@/lib/manage-paths";

/** The address a link goes to: its route with the params put in. */
function href(link: { to: string; params?: Record<string, string> }): string {
  return Object.entries(link.params ?? {}).reduce(
    (path, [name, value]) => path.replace(`$${name}`, value),
    link.to,
  );
}

describe("where the pages a person manages live", () => {
  test("in the team edition, under Admin", () => {
    const paths = managePaths("team");
    expect(href(paths.plugins())).toBe("/admin/plugins");
    expect(href(paths.plugin("notion"))).toBe("/admin/plugins/notion");
    expect(href(paths.pluginTool("notion", "search"))).toBe(
      "/admin/plugins/notion/tools/search",
    );
    expect(href(paths.pluginBot("notion", "bot-1"))).toBe(
      "/admin/plugins/notion/bots/bot-1",
    );
    expect(href(paths.brokerDirectory("composio"))).toBe(
      "/admin/plugins/composio",
    );
    expect(href(paths.brokerDirectory("arcade"))).toBe("/admin/plugins/arcade");
    expect(href(paths.skills())).toBe("/admin/skills");
    expect(href(paths.newSkill())).toBe("/admin/skills/new");
    expect(href(paths.skill("triage"))).toBe("/admin/skills/triage");
    expect(href(paths.credentials())).toBe("/admin/credentials");
    expect(href(paths.newCredential())).toBe("/admin/credentials/new");
    expect(href(paths.computers())).toBe("/admin/computers");
    expect(href(paths.audit())).toBe("/admin/audit");
  });

  test("in the personal edition, apps under Connections and the rest under Settings", () => {
    const paths = managePaths("personal");
    expect(href(paths.plugins())).toBe("/connections");
    expect(href(paths.plugin("notion"))).toBe("/connections/notion");
    // Every Bot has every tool here, so one tool or one Bot opens the app's own page.
    expect(href(paths.pluginTool("notion", "search"))).toBe(
      "/connections/notion",
    );
    expect(href(paths.pluginBot("notion", "bot-1"))).toBe(
      "/connections/notion",
    );
    expect(href(paths.brokerDirectory("composio"))).toBe(
      "/connections/browse/composio",
    );
    expect(href(paths.brokerDirectory("arcade"))).toBe(
      "/connections/browse/arcade",
    );
    expect(paths.pluginsLabel).toBe("Connections");
    expect(managePaths("team").pluginsLabel).toBe("Plugins");
    expect(href(paths.skills())).toBe("/settings/skills");
    expect(href(paths.newSkill())).toBe("/settings/skills/new");
    expect(href(paths.skill("triage"))).toBe("/settings/skills/triage");
    expect(href(paths.credentials())).toBe("/settings/credentials");
    expect(href(paths.newCredential())).toBe("/settings/credentials/new");
    expect(href(paths.computers())).toBe("/settings/computer");
    expect(href(paths.audit())).toBe("/settings/activity");
  });
});

import { useQuery } from "@tanstack/react-query";
import { linkOptions } from "@tanstack/react-router";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

export type BrokerDirectory = "composio" | "arcade";

/**
 * Where the pages that set up what Bots can reach live: under Admin in the team edition. In the
 * personal one, where there is no Admin, apps are part of Connections and the rest is under
 * Settings. Both render the same page components, so every link between those pages goes through
 * here rather than naming `/admin`.
 */
export function managePaths(edition: "team" | "personal") {
  if (edition === "personal") {
    return {
      /** What the list of apps is called where a back button names it. */
      pluginsLabel: "Connections",
      plugins: () => linkOptions({ to: "/connections" }),
      plugin: (key: string) =>
        linkOptions({ to: "/connections/$key", params: { key } }),
      /*
       * The app's own page for both: every Bot has every tool of a connected app here, so there is
       * no page for one tool or one Bot. See `personal-defaults.ts` on the server.
       */
      pluginTool: (key: string, _tool: string) =>
        linkOptions({ to: "/connections/$key", params: { key } }),
      pluginBot: (key: string, _agentId: string) =>
        linkOptions({ to: "/connections/$key", params: { key } }),
      brokerDirectory: (directory: BrokerDirectory) =>
        directory === "composio"
          ? linkOptions({ to: "/connections/browse/composio" })
          : linkOptions({ to: "/connections/browse/arcade" }),
      skills: () => linkOptions({ to: "/settings/skills" }),
      newSkill: () => linkOptions({ to: "/settings/skills/new" }),
      skill: (slug: string) =>
        linkOptions({ to: "/settings/skills/$slug", params: { slug } }),
      // Under Settings, and linked from Connections beside the apps that use them.
      credentialsLabel: "Keys",
      credentials: () => linkOptions({ to: "/settings/credentials" }),
      newCredential: () => linkOptions({ to: "/settings/credentials/new" }),
      computers: () => linkOptions({ to: "/settings/computer" }),
      /*
       * What the trail is called, on its page, in the sidebar and wherever another page sends a
       * person to it. Activity here, where one person reads what their own Bots did; Audit under
       * Admin, where an admin reviews everybody's Bots for policy. Two names, each kept the same
       * everywhere in its edition, so a page never reads "Audit" under a sidebar entry "Activity".
       */
      auditLabel: "Activity",
      audit: () => linkOptions({ to: "/settings/activity" }),
      /*
       * What a sentence calls the product itself. The person running OpenBot alone reads its name;
       * an admin reads "this deployment", the exact word Admin is allowed (see `openbot-copy`).
       * Mid-sentence; `atStart` capitalises it where it opens one.
       */
      deploymentName: "OpenBot",
      /** Which edition these paths are for, for the sentences that differ beyond a name. */
      edition: "personal" as const,
    };
  }
  return {
    pluginsLabel: "Plugins",
    plugins: () => linkOptions({ to: "/admin/plugins" }),
    plugin: (key: string) =>
      linkOptions({ to: "/admin/plugins/$key", params: { key } }),
    pluginTool: (key: string, tool: string) =>
      linkOptions({
        to: "/admin/plugins/$key/tools/$tool",
        params: { key, tool },
      }),
    pluginBot: (key: string, agentId: string) =>
      linkOptions({
        to: "/admin/plugins/$key/bots/$agentId",
        params: { key, agentId },
      }),
    brokerDirectory: (directory: BrokerDirectory) =>
      directory === "composio"
        ? linkOptions({ to: "/admin/plugins/composio" })
        : linkOptions({ to: "/admin/plugins/arcade" }),
    skills: () => linkOptions({ to: "/admin/skills" }),
    newSkill: () => linkOptions({ to: "/admin/skills/new" }),
    skill: (slug: string) =>
      linkOptions({ to: "/admin/skills/$slug", params: { slug } }),
    credentialsLabel: "Credentials",
    credentials: () => linkOptions({ to: "/admin/credentials" }),
    newCredential: () => linkOptions({ to: "/admin/credentials/new" }),
    computers: () => linkOptions({ to: "/admin/computers" }),
    auditLabel: "Audit",
    audit: () => linkOptions({ to: "/admin/audit" }),
    deploymentName: "this deployment",
    edition: "team" as const,
  };
}

/** A name from these paths at the start of a sentence: "This deployment", and "OpenBot" as it is. */
export function atStart(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export type ManagePaths = ReturnType<typeof managePaths>;

/**
 * Where an app's address goes in the personal edition, given what followed `/plugins` in its old
 * address: the same page under Connections, with the directories under `/connections/browse`.
 */
export function personalAppsAddress(rest: string): string {
  const path = rest.replace(/^\/+|\/+$/g, "");
  if (path === "composio" || path === "arcade")
    return `/connections/browse/${path}`;
  return path ? `/connections/${path}` : "/connections";
}

/** Each other Admin page the personal edition keeps, and where it is now. */
const MOVED: readonly (readonly [admin: string, settings: string])[] = [
  ["/admin/skills", "/settings/skills"],
  ["/admin/credentials", "/settings/credentials"],
  ["/admin/computers", "/settings/computer"],
  ["/admin/audit", "/settings/activity"],
];

/**
 * Where an old Admin address goes in the personal edition: an app's page under Connections, the
 * same page under Settings with whatever followed it (`/admin/credentials/new` keeps `/new`), or
 * Settings itself for a page the personal edition does not have.
 */
export function personalAdminRedirect(pathname: string): string {
  if (pathname === "/admin/plugins" || pathname.startsWith("/admin/plugins/"))
    return personalAppsAddress(pathname.slice("/admin/plugins".length));
  for (const [admin, settings] of MOVED) {
    if (pathname === admin || pathname.startsWith(`${admin}/`)) {
      return `${settings}${pathname.slice(admin.length)}`.replace(/\/$/, "");
    }
  }
  return "/settings";
}

/**
 * The paths for this deployment. The edition is read once per page load and cached for good, so
 * this is a lookup, not a request; until it answers, the team edition's paths, which are what every
 * deployment from before the switch has.
 */
export function useManagePaths(): ManagePaths {
  const { data } = useQuery(deploymentCapabilitiesQueryOptions());
  return managePaths(data?.edition ?? "team");
}

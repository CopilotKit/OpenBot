import { useQuery } from "@tanstack/react-query";
import { linkOptions } from "@tanstack/react-router";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

export type BrokerDirectory = "composio" | "arcade";

/**
 * Where the pages that set up what Bots can reach live: under Admin in the team edition, and under
 * Settings in the personal one, where there is no Admin. Both render the same page components, so
 * every link between those pages goes through here rather than naming `/admin`.
 */
export function managePaths(edition: "team" | "personal") {
  if (edition === "personal") {
    return {
      plugins: () => linkOptions({ to: "/settings/plugins" }),
      plugin: (key: string) =>
        linkOptions({ to: "/settings/plugins/$key", params: { key } }),
      pluginTool: (key: string, tool: string) =>
        linkOptions({
          to: "/settings/plugins/$key/tools/$tool",
          params: { key, tool },
        }),
      pluginBot: (key: string, agentId: string) =>
        linkOptions({
          to: "/settings/plugins/$key/bots/$agentId",
          params: { key, agentId },
        }),
      brokerDirectory: (directory: BrokerDirectory) =>
        directory === "composio"
          ? linkOptions({ to: "/settings/plugins/composio" })
          : linkOptions({ to: "/settings/plugins/arcade" }),
      skills: () => linkOptions({ to: "/settings/skills" }),
      credentials: () => linkOptions({ to: "/settings/credentials" }),
      newCredential: () => linkOptions({ to: "/settings/credentials/new" }),
      computers: () => linkOptions({ to: "/settings/computer" }),
      audit: () => linkOptions({ to: "/settings/activity" }),
    };
  }
  return {
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
    credentials: () => linkOptions({ to: "/admin/credentials" }),
    newCredential: () => linkOptions({ to: "/admin/credentials/new" }),
    computers: () => linkOptions({ to: "/admin/computers" }),
    audit: () => linkOptions({ to: "/admin/audit" }),
  };
}

export type ManagePaths = ReturnType<typeof managePaths>;

/** Each Admin page the personal edition keeps, and where it is under Settings. */
const MOVED: readonly (readonly [admin: string, settings: string])[] = [
  ["/admin/plugins", "/settings/plugins"],
  ["/admin/skills", "/settings/skills"],
  ["/admin/credentials", "/settings/credentials"],
  ["/admin/computers", "/settings/computer"],
  ["/admin/audit", "/settings/activity"],
];

/**
 * Where an old Admin address goes in the personal edition: the same page under Settings, with
 * whatever followed it (`/admin/plugins/notion/tools/search` keeps `/notion/tools/search`), or
 * Settings itself for a page the personal edition does not have.
 */
export function personalAdminRedirect(pathname: string): string {
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

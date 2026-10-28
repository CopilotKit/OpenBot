import type { PluginServer } from "./queries";

/*
 * Which apps the Connections page lists, and in which group. Here and not in the route file, so
 * anything else that lists a person's apps (a skin's own screen) reads the same rules without
 * importing a route, which works against TanStack Router's automatic code splitting.
 */

/**
 * Whether a row came through a broker. A deployment only ever holds rows from one provider, so the
 * page needs to recognise "brokered", not to know which broker.
 */
const isBrokered = (server: PluginServer): boolean =>
  server.provenance === "composio" || server.provenance === "arcade";

/**
 * The brokered apps this page lists, which is not every brokered row.
 *
 * Exported as a function rather than left inline in the render, for the reason `matchingApps` on the
 * Composio picker is: the rule is the thing worth pinning and pinning it needs no DOM, no router and
 * no query client. See its one clause below.
 */
export function brokeredAccountsListedOn(
  servers: PluginServer[],
): PluginServer[] {
  return servers.filter(
    (server) =>
      isBrokered(server) &&
      server.authScheme !== "NO_AUTH" &&
      server.accountMode !== "shared",
  );
}

/**
 * The servers this page may list at all: none reached through Composio when the deployment has no
 * Composio key.
 *
 * An app an administrator enabled while a key was set keeps its row after the key is removed, and
 * listing it offered a person an account they cannot connect, under a sentence about an environment
 * variable only an administrator can set. Without the broker there is nothing for them to decide.
 */
export function serversListedFor(page: {
  servers: PluginServer[];
  composioConfigured: boolean;
}): PluginServer[] {
  return page.composioConfigured
    ? page.servers
    : page.servers.filter((server) => server.provenance !== "composio");
}

/** Apps whose account is the organisation's, shown so a person knows a Bot does not act as them there. */
export function sharedAccountsListedOn(
  servers: PluginServer[],
): PluginServer[] {
  return servers.filter(
    (server) => isBrokered(server) && server.accountMode === "shared",
  );
}

import type { PluginsProvider } from "./provider-vocabulary";
import type { PluginServer } from "./queries";

/*
 * Which apps the Connections page lists, and in which group. Here and not in the route file, so
 * anything else that lists a person's apps (a skin's own screen) reads the same rules without
 * importing a route, which works against TanStack Router's automatic code splitting.
 */

/**
 * Whether an app came from the directory. The page needs to recognise that, not to know which
 * service the directory comes from.
 */
const isBrokered = (server: PluginServer): boolean =>
  server.source === "directory";

/**
 * The brokered apps this page lists, which is not every brokered row.
 *
 * Exported as a function rather than left inline in the render, for the reason `matchingApps` on the
 * Composio picker is: the rule is the thing worth pinning and pinning it needs no DOM, no router and
 * no query client. See its clauses below.
 */
export function brokeredAccountsListedOn(
  servers: PluginServer[],
): PluginServer[] {
  return servers.filter(
    (server) =>
      isBrokered(server) &&
      server.connectsWith !== "nothing" &&
      server.accountMode !== "shared" &&
      /* One that can only hold a shared account has nothing here for a person to connect. */
      !server.sharedOnly,
  );
}

/**
 * The servers this page may list at all: none from a Composio directory when that directory isn't
 * set up here (getAppSetup's `directoryAvailable` and `directoryProvider`).
 *
 * An app an administrator enabled while the directory was set up keeps its row after its key is
 * removed, and listing it offered a person an account they cannot connect, under a sentence about an
 * environment variable only an administrator can set. Without the directory there is nothing for
 * them to decide. An Arcade directory's apps stay listed, each saying on its own row that an admin
 * has to set connecting apps up.
 */
export function serversListedFor(page: {
  servers: PluginServer[];
  directoryAvailable: boolean;
  directoryProvider: PluginsProvider;
}): PluginServer[] {
  return page.directoryAvailable || page.directoryProvider !== "composio"
    ? page.servers
    : page.servers.filter((server) => !isBrokered(server));
}

/** Apps whose account is the organisation's, shown so a person knows a Bot does not act as them there. */
export function sharedAccountsListedOn(
  servers: PluginServer[],
): PluginServer[] {
  return servers.filter(
    (server) => isBrokered(server) && server.accountMode === "shared",
  );
}

/**
 * Servers somebody added by their address, from Connections or an admin's API call. Each is its own
 * tile on Connections: one that signs each person in reads like any app you connect, and one that
 * needs no account reads On.
 */
export function addedByUrlListedOn(servers: PluginServer[]): PluginServer[] {
  return servers.filter((server) => server.source === "address");
}

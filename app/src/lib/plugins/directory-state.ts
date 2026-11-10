import type { PluginsProvider } from "@/lib/plugins/provider-vocabulary";
import {
  type ComposioApp,
  type PluginConnection,
  type PluginServer,
  personalConnections,
} from "@/lib/plugins/queries";

/**
 * Where one app in Browse apps stands for the person looking at it.
 *
 * ADDED IS NOT CONNECTED. Adding an app records it for OpenBot; a Bot still reaches the app as
 * whoever is asking, so an app that signs in is usable only once that person has signed in. The row
 * used to read "Added" the moment the app was recorded, and a person read that as done, then met a
 * Bot telling them the app wasn't connected. So the row says "Not connected" until it is, which is
 * what the Bot says about the same app.
 *
 * - `addable` — nobody has added it yet.
 * - `added` — added, and there is no account of this person's to make: an app that needs none, or
 *   one whose account is the team's.
 * - `connected` — added, and this person's own account is connected.
 * - `not_connected` — added, and this person's own account isn't connected yet.
 * - `loading` — added, but the app list or the connections haven't arrived, so nothing is claimed.
 */
export type DirectoryAppState =
  | { kind: "addable" }
  | { kind: "added" }
  | { kind: "connected"; serverId: string }
  | { kind: "not_connected"; serverId: string }
  | { kind: "loading" };

/** How a person connects an app: a sign-in page, a key typed in, or nothing at all. */
export function directoryConnect(
  app: Pick<ComposioApp, "connection">,
): "sign-in" | "key" | "none" {
  switch (app.connection.kind) {
    case "fields":
      return "key";
    case "no-auth":
      return "none";
    default:
      return "sign-in";
  }
}

/**
 * The row this deployment recorded for a directory app, if it has one: the broker's own row at the
 * app's address. Several rows may share an address; the first one listed answers for the app, as it
 * does on the server.
 */
export function directoryServer(
  servers: PluginServer[],
  provider: PluginsProvider,
  slug: string,
): PluginServer | undefined {
  return servers.find(
    (server) =>
      server.provenance === provider && server.url === `${provider}://${slug}`,
  );
}

export function directoryAppState(
  app: Pick<ComposioApp, "slug" | "enabled" | "connection">,
  input: {
    provider: PluginsProvider;
    servers: PluginServer[] | undefined;
    connections: PluginConnection[] | undefined;
  },
): DirectoryAppState {
  if (!app.enabled) return { kind: "addable" };
  if (directoryConnect(app) === "none") return { kind: "added" };
  if (!input.servers || !input.connections) return { kind: "loading" };
  const server = directoryServer(input.servers, input.provider, app.slug);
  // Listed as added by the directory and not yet in the app list: the refetch is on its way.
  if (!server) return { kind: "loading" };
  if (server.accountMode === "shared") return { kind: "added" };
  const connected = personalConnections(input.connections).some(
    (row) => row.serverId === server.id && row.revoked !== true,
  );
  return connected
    ? { kind: "connected", serverId: server.id }
    : { kind: "not_connected", serverId: server.id };
}

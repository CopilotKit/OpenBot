import type { DirectoryApp } from "@/lib/apps/queries";
import {
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
  app: Pick<DirectoryApp, "connectsWith">,
): "sign-in" | "key" | "none" {
  switch (app.connectsWith) {
    case "key":
      return "key";
    case "nothing":
      return "none";
    default:
      return "sign-in";
  }
}

/**
 * The directory entry that offers this app's key version, while it isn't added: for an app added as
 * the sign-in an entry lists in place of its key. Undefined for any other app, and from a server that
 * doesn't say (no `keyVersion`).
 */
export function keyVersionOffer(
  entries: readonly DirectoryApp[] | undefined,
  appId: string,
): DirectoryApp | undefined {
  return entries?.find(
    (entry) => entry.appId === appId && entry.keyVersion?.appId === null,
  );
}

/**
 * Whether an added app could be the sign-in a directory app is listed as in place of its key: the
 * directory's own sign-in app, or a server added by its address that signs each person in (the
 * vendor's own server). Only these can have a key version to offer; which of them do is the
 * directory's answer (`keyVersionOffer`).
 */
export function signsInForDirectory(
  server: Pick<PluginServer, "connectsWith" | "source" | "signIn">,
): boolean {
  return (
    server.connectsWith === "sign-in" ||
    (server.source === "address" && server.signIn === true)
  );
}

export function directoryAppState(
  app: Pick<DirectoryApp, "appId" | "connectsWith">,
  input: {
    servers: PluginServer[] | undefined;
    connections: PluginConnection[] | undefined;
  },
): DirectoryAppState {
  if (app.appId === null) return { kind: "addable" };
  if (directoryConnect(app) === "none") return { kind: "added" };
  if (!input.servers || !input.connections) return { kind: "loading" };
  // The app the directory says this entry was added as, which answers for it on the server too.
  const server = input.servers.find((row) => row.id === app.appId);
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

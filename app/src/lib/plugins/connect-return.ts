import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { connectionsQueryOptions, personalConnections } from "./queries";

/**
 * BACK TO WHERE CONNECT WAS PRESSED, once the sign-in a new tab opened is done.
 *
 * A Bot's card in a conversation, and an app's row on a Bot's page, start a sign-in in a new tab
 * (`useConnectInNewTab`), so the person never leaves what they were in the middle of. The sign-in
 * comes back to the app's page under Connections, because that is where the connect route returns
 * a browser to. Reported: after connecting Gmail from a conversation, the person was left on
 * Gmail's page in the new tab, when what they expected was the Bot they had been talking to, which
 * by then was already carrying on in the first tab.
 *
 * So the tab is told, before it leaves, where the press was made: written into the new tab's own
 * session storage while it is still OpenBot's blank page, which the vendor's pages cannot touch and
 * which is still there when the tab comes back to OpenBot. On the app's page, once the account is
 * listed as connected, the tab closes, which puts the person back on the tab they pressed Connect
 * in. Where the browser will not let it close, it goes to that page instead.
 *
 * ONLY THE PAGE THE SIGN-IN LANDS ON acts on it, and only once: the note is read and dropped on
 * arrival, so somebody who stays in that tab and moves on is never taken anywhere later. A sign-in
 * that failed comes back saying so (`?status=failed`), and then the person stays where the failure
 * is said. Storage refused (a private window, a policy) means no note: the page works as before.
 */

const KEY = "openbot:connect-return";

type Note = { app: string; path: string };

/**
 * Tell the tab a sign-in is about to open in where to come back to. `tab` is the blank tab claimed
 * on the click, still OpenBot's origin, so its session storage is this site's, in that tab.
 */
export function markConnectReturn(
  tab: Window | null,
  app: string,
  path: string,
): void {
  if (!tab) return;
  try {
    tab.sessionStorage.setItem(KEY, JSON.stringify({ app, path }));
  } catch {
    // No storage: the tab stays where the sign-in lands, as it did before. See above.
  }
}

/** The note this tab was given, dropped as it is read so it can be acted on once. */
function takeNote(): Note | null {
  try {
    const text = sessionStorage.getItem(KEY);
    if (text === null) return null;
    sessionStorage.removeItem(KEY);
    const note = JSON.parse(text) as Partial<Note>;
    return typeof note.app === "string" &&
      typeof note.path === "string" &&
      // Only a path in OpenBot itself, never an address somewhere else.
      note.path.startsWith("/") &&
      !note.path.startsWith("//")
      ? { app: note.app, path: note.path }
      : null;
  } catch {
    return null;
  }
}

/** Whether the address the sign-in came back to says it failed. */
function cameBackFailed(): boolean {
  const search = new URLSearchParams(window.location.search);
  return (
    search.get("status") === "failed" || search.get("connected") === "failed"
  );
}

/**
 * On an app's page under Connections: when this tab was opened for this app's sign-in, close it
 * once the account is connected, or go back to where Connect was pressed. See above.
 */
export function useBackAfterConnect(app: string): void {
  const [note] = useState(() => {
    const taken = takeNote();
    return taken && !cameBackFailed() ? taken : null;
  });
  const waiting = note !== null && note.app === app;
  const connections = useQuery({
    ...connectionsQueryOptions(),
    enabled: waiting,
    // The page confirms the account on arrival; until it is listed, ask again.
    refetchInterval: waiting ? 2_000 : false,
  });
  // A withdrawn credential leaves its row behind, so a row alone is not connected.
  const connected =
    waiting &&
    personalConnections(connections.data?.connections ?? []).some(
      (row) => row.serverId === app && row.revoked !== true,
    );
  const router = useRouter();
  const path = note?.path;
  useEffect(() => {
    if (!connected || !path) return;
    window.close();
    if (!window.closed) router.history.replace(path);
  }, [connected, path, router]);
}

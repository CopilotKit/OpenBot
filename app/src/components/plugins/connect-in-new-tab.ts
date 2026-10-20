import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { connectAccountMutationOptions } from "@/lib/plugins/mutations";

/**
 * Start this person's own connection to one app in a new tab, the way Settings starts it.
 *
 * THE SAME WRITE AS SETTINGS, A DIFFERENT TAB. `connectAccountMutationOptions` is the connect route
 * the connected-accounts page presses, returning to that page when the vendor is done, so the
 * confirm that writes the connection down is the one that page already runs. What differs is where
 * the consent screen opens: Settings navigates its own tab, because the person went there to
 * connect; a card in a conversation or a row on a Bot's page opens a new one, because the person is
 * in the middle of something and a full navigation several redirects long would take them out of
 * it. This tab stays where it was, and whoever drew the button watches the server for the
 * connection to appear — the return trip proves nothing, being an ordinary redirect in a tab this
 * one cannot read.
 *
 * Lifted out of `ConnectAppCard`, which had it inline, so the Bot page and the app-access card start
 * a connection with the same code rather than a second copy of the popup rules below.
 */
export function useConnectInNewTab() {
  const [waiting, setWaiting] = useState(false);
  /** This app takes a key somebody types, so there is no page to send them to. */
  const [needsKey, setNeedsKey] = useState(false);
  /** The authorization url, when the browser refused to open the tab holding it. */
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);
  const connect = useMutation(connectAccountMutationOptions());
  // Stable, so a caller can list it in an effect's dependencies without re-running it every render.
  const stopWaiting = useCallback(() => setWaiting(false), []);

  /**
   * The tab, opened on the click itself rather than on the answer to it.
   *
   * A BROWSER ONLY LETS A PAGE OPEN A TAB WHILE A CLICK IS STILL RECENT. Chrome's transient
   * activation lasts about five seconds, and the request that mints the authorization url has to
   * finish first — so on a slow deployment `window.open` was called with the activation already
   * expired, the tab was blocked, and the card cheerfully said to finish in a tab that did not
   * exist. The blank tab is claimed first and navigated once the url arrives.
   *
   * `noopener` CANNOT BE PASSED HERE: it makes `window.open` answer null, and null is a handle
   * nothing can navigate later. The opener is severed on the handle instead, which is the same
   * guarantee by a different route.
   */
  const claimTab = (): Window | null => {
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    return tab;
  };

  const open = (serverId: string) => {
    const tab = claimTab();
    connect.mutate(serverId, {
      onSuccess: (authorizationUrl) => {
        /*
         * No url means this app is connected by typing a key rather than by visiting a page — the
         * route answers `{ fields }` and the mutation unwraps nothing. Saying so, with the page
         * that has the form, beats a button that silently does nothing.
         */
        if (!authorizationUrl) {
          tab?.close();
          setNeedsKey(true);
          return;
        }
        setWaiting(true);
        if (tab) tab.location.replace(authorizationUrl);
        // The tab was blocked. The url is still good, so offer it as something to click.
        else setBlockedUrl(authorizationUrl);
      },
      onError: () => tab?.close(),
    });
  };

  return {
    open,
    /** A consent is open in the other tab; whoever drew the button should be watching. */
    waiting,
    /** Called once the server lists the connection, so the button stops saying it is waiting. */
    stopWaiting,
    needsKey,
    blockedUrl,
    pending: connect.isPending,
    /** The connect route's own sentence, when it refused. */
    error: connect.isError
      ? connect.error instanceof Error
        ? connect.error.message
        : "That account could not be connected."
      : null,
  };
}

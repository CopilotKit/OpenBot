import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { connectAccountMutationOptions } from "@/lib/plugins/mutations";
import { pluginKeys } from "@/lib/plugins/queries";

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
  /*
   * The provider's client, which is the one whoever drew the button reads from. In the app it is
   * the module's own singleton; a screen mounted under another provider is refetched through its
   * own, so an account recorded on the press is drawn where the press was made.
   */
  const queryClient = useQueryClient();
  const [waiting, setWaiting] = useState(false);
  /** This app takes a key somebody types, so there is no page to send them to. */
  const [needsKey, setNeedsKey] = useState(false);
  /** The authorization url, when the browser refused to open the tab holding it. */
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);
  const connect = useMutation(connectAccountMutationOptions());
  // Stable, so a caller can list it in an effect's dependencies without re-running it every render.
  const stopWaiting = useCallback(() => setWaiting(false), []);
  /** The tab the consent is open in, while there is one to watch. */
  const handle = useRef<Window | null>(null);

  /*
   * A CLOSED TAB ENDS THE WAIT ONCE THIS TAB HAS THE FOCUS BACK. Somebody who closes the sign-in
   * tab without finishing has given up, and a button still saying "Waiting for Gmail…" a minute
   * later is waiting for nothing — so the handle is checked every second, and once it reads closed
   * the wait ends and the plugin screens are asked once more, in case the consent did finish before
   * the tab went.
   *
   * CLOSED MAY ALSO MEAN SEVERED, WHICH IS WHY THE FOCUS DECIDES. A vendor's sign-in page that sends
   * a strict Cross-Origin-Opener-Policy — Google's does — moves the tab into a browsing context of
   * its own, and the handle this tab holds then reads closed while the person is still on the
   * consent screen. The handle cannot tell the two apart; the focus can. Closing a tab hands the
   * focus straight back here, so the wait ends at once; a severed tab keeps it, so the button goes
   * on waiting until the person comes back to this one, which is when there is an answer to show.
   */
  const onReturn = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!waiting) return;
    const finish = () => {
      onReturn.current = null;
      setWaiting(false);
      void queryClient.invalidateQueries({ queryKey: pluginKeys.all });
    };
    const timer = setInterval(() => {
      if (!handle.current?.closed || onReturn.current) return;
      handle.current = null;
      if (document.hasFocus()) {
        finish();
        return;
      }
      onReturn.current = finish;
      window.addEventListener("focus", finish, { once: true });
    }, 1_000);
    return () => clearInterval(timer);
  }, [waiting, queryClient]);
  // Goes with whoever drew the button, and with a wait that ended some other way first.
  useEffect(() => {
    if (waiting || !onReturn.current) return;
    window.removeEventListener("focus", onReturn.current);
    onReturn.current = null;
  }, [waiting]);
  useEffect(
    () => () => {
      if (onReturn.current)
        window.removeEventListener("focus", onReturn.current);
    },
    [],
  );

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
    handle.current = tab;
    connect.mutate(serverId, {
      onSuccess: (start) => {
        /*
         * ALREADY CONNECTED: the account was held at the vendor with no row here, and the route
         * recorded it on this press. There is no page to visit, so the claimed tab goes, and every
         * query is refetched once, as the card does on its own connected edge. Whoever drew the
         * button reads the new row there, and the Bot's next turn is asked against it.
         */
        if (start !== null && "connected" in start) {
          tab?.close();
          handle.current = null;
          void queryClient.invalidateQueries();
          return;
        }
        /*
         * No url means this app is connected by typing a key rather than by visiting a page — the
         * route answers `{ fields }` and the mutation unwraps nothing. Saying so, with the page
         * that has the form, beats a button that silently does nothing.
         */
        if (start === null) {
          tab?.close();
          handle.current = null;
          setNeedsKey(true);
          return;
        }
        const { authorizationUrl } = start;
        setWaiting(true);
        if (tab) tab.location.replace(authorizationUrl);
        // The tab was blocked. The url is still good, so offer it as something to click.
        else setBlockedUrl(authorizationUrl);
      },
      onError: () => {
        tab?.close();
        handle.current = null;
      },
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
        : "Couldn't connect that account."
      : null,
  };
}

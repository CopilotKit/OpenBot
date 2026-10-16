import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { connectAccountMutationOptions } from "@/lib/plugins/mutations";
import {
  connectionsQueryOptions,
  personalConnections,
} from "@/lib/plugins/queries";
import { queryClient } from "@/query-client";

/**
 * The app a Bot needed, offered where the person is reading, instead of the name of a screen.
 *
 * A NEW TAB RATHER THAN THIS ONE, and that is the whole shape of this card. A consent screen is the
 * vendor's own page and the trip to it is a full navigation, so sending this tab would take the
 * person out of the conversation they are in the middle of and land them, several redirects later,
 * on the connected-accounts page with their question somewhere behind them. The flow finishes over
 * there; this tab stays where it was and watches for the connection to appear.
 *
 * WATCHING, NOT TRUSTING. The return trip proves nothing — it is an ordinary redirect in a tab this
 * one cannot read — so nothing here treats "they came back" as "it worked". The card polls this
 * person's own connections while it waits and only says connected when the server lists one.
 */
export function ConnectAppCard({
  serverId,
  title,
  message,
}: {
  serverId: string;
  title: string;
  message: string;
}) {
  const [waiting, setWaiting] = useState(false);
  /** This app takes a key somebody types, so there is no page to send them to. */
  const [needsKey, setNeedsKey] = useState(false);
  /** The authorization url, when the browser refused to open the tab holding it. */
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);
  const connect = useMutation(connectAccountMutationOptions());
  const connections = useQuery({
    ...connectionsQueryOptions(),
    // Only while a consent is open in the other tab; otherwise this is an ordinary cached read.
    refetchInterval: waiting ? 2_000 : false,
  });
  /*
   * A ROW IS NOT ACCESS, which is the whole reason `revoked` is read here. Withdrawing somebody's
   * access leaves their row in place pointing at a revoked credential, so a card drawn over the
   * "your access was withdrawn" refusal would have said the app was connected and taken away the
   * button that is the only way to get it back.
   */
  const connected = personalConnections(
    connections.data?.connections ?? [],
  ).some((row) => row.serverId === serverId && row.revoked !== true);

  /*
   * The grants a Bot holds are read per conversation, so the turn that follows has to be asked
   * against a store that knows about the new account. Invalidated once, on the edge.
   */
  const was = useRef(connected);
  useEffect(() => {
    if (connected && !was.current) {
      setWaiting(false);
      void queryClient.invalidateQueries();
    }
    was.current = connected;
  }, [connected]);

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

  const open = () => {
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

  return (
    <div
      className="my-2 flex w-full max-w-2xl flex-col gap-3 rounded-xl border border-border p-4"
      data-connect-app={serverId}
    >
      <div className="flex flex-col gap-1">
        <p className="font-medium text-sm">Connect {title}</p>
        <p className="text-muted-foreground text-sm">{message}</p>
      </div>
      {connected ? (
        <p className="text-sm" role="status">
          {title} is connected. Ask again and the Bot can use it.
        </p>
      ) : needsKey ? (
        <p className="text-sm" role="status">
          {title} is connected with a key you hold rather than by visiting a
          page.{" "}
          <Link
            className="underline underline-offset-2"
            params={{ key: serverId }}
            to="/settings/connected-accounts/$key"
          >
            Enter it on {title}'s page
          </Link>
          , then ask again.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {/* The heading above already names the app; the button says what pressing it does. */}
          <Button disabled={connect.isPending} onClick={open} size="sm">
            {waiting ? `Waiting for ${title}…` : "Connect"}
          </Button>
          {waiting ? (
            <p className="text-muted-foreground text-sm" role="status">
              Finish in the tab that opened, then come back here.
            </p>
          ) : null}
          {blockedUrl ? (
            <p className="text-sm" role="status">
              This browser blocked the tab.{" "}
              <a
                className="underline underline-offset-2"
                href={blockedUrl}
                rel="noreferrer"
                target="_blank"
              >
                Open {title}'s sign-in
              </a>
              .
            </p>
          ) : null}
          {connect.isError ? (
            <p className="text-destructive text-sm" role="status">
              {connect.error instanceof Error
                ? connect.error.message
                : `${title} could not be connected.`}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

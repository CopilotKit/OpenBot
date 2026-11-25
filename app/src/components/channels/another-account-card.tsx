import type { AnotherAccountPrompt } from "@openbot/shared/connect-prompt";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { useConnectInNewTab } from "@/components/plugins/connect-in-new-tab";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { Button } from "@/components/ui/button";
import { botAppQueryOptions } from "@/lib/app-access/queries";
import { useDeclaredBotId } from "@/lib/copilot/active-bot";
import { failureSaid } from "@/lib/load-failure";
import { setDefaultBrokeredAccountMutationOptions } from "@/lib/plugins/mutations";
import {
  type BrokeredAccountRecord,
  brokeredAccountsQueryOptions,
  pluginKeys,
} from "@/lib/plugins/queries";

/**
 * One more account at an app the person already connected, started where they asked for it.
 *
 * FOUND IN DOGFOODING. Asked "Can I connect you to my personal email as well?" by somebody whose
 * work Gmail was connected, a Bot could only show Gmail's card, which read "Gmail is ready now", and
 * three how-to guides, two of them about something else. Connections had Connect another account
 * all along; this card is that press, in the conversation.
 *
 * THE SAME CARD AND THE SAME PRESS. Drawn as the app-access card is drawn, and the button starts the
 * sign-in in a new tab with `useConnectInNewTab`, asking for another account the way Connections'
 * Connect another account asks (`connectAnotherAccountMutationOptions`). The person's accounts at
 * the app are read live, as the app's page reads them.
 *
 * AND THEN WHICH ACCOUNT BOTS USE. Once the app lists more accounts than the person held when the
 * Bot asked (`held`), the newest is the one just connected (the server lists oldest first). The card
 * says which account Bots use and, where that isn't the new one, offers Make default, the same press
 * as on the app's page. A card scrolled back to, or drawn after a reload, says the same.
 */
export function AnotherAccountCard({
  prompt,
}: {
  prompt: AnotherAccountPrompt;
}) {
  const declared = useDeclaredBotId();
  const agentId = prompt.agentId ?? declared ?? "";
  const queryClient = useQueryClient();
  const app = useQuery({
    ...botAppQueryOptions(agentId, prompt.serverId),
    enabled: agentId !== "",
  });
  const listing = useQuery({
    ...brokeredAccountsQueryOptions(prompt.serverId),
    refetchOnWindowFocus: true,
  });
  const tab = useConnectInNewTab({ another: true });
  const makeDefault = useMutation(
    setDefaultBrokeredAccountMutationOptions(queryClient),
  );

  const name = app.data?.displayName ?? prompt.title;
  const accounts = listing.data?.accounts ?? [];
  const connectedSince = accounts.length > Math.max(prompt.held ?? 1, 1);
  const newest = connectedSince ? accounts.at(-1) : undefined;
  const usedByDefault = accounts.find((account) => account.isDefault);

  /*
   * WATCHING THE SERVER WHILE THE SIGN-IN IS OPEN in the other tab, as `ConnectAction` does: the
   * accounts are read every two seconds until the new one is listed, and then the wait ends.
   */
  const { waiting, stopWaiting } = tab;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      void queryClient.invalidateQueries({
        queryKey: pluginKeys.accounts(prompt.serverId),
      });
    }, 2_000);
    return () => clearInterval(timer);
  }, [waiting, queryClient, prompt.serverId]);
  useEffect(() => {
    if (connectedSince && waiting) stopWaiting();
  }, [connectedSince, waiting, stopWaiting]);

  return (
    <div
      className="my-2 flex w-full max-w-2xl flex-col gap-3 rounded-xl border border-border p-4"
      data-another-account={prompt.serverId}
      data-state={
        listing.isPending
          ? undefined
          : newest
            ? "connected"
            : listing.data?.canAddAnother
              ? "ready-to-connect"
              : "only-one"
      }
    >
      <div className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border">
          <PluginLogo logo={app.data?.logo} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="font-medium text-sm">{name}</p>
          {listing.isPending ? null : listing.error ? (
            <p className="text-muted-foreground text-sm" role="alert">
              {name}'s accounts couldn't be loaded. Try again in a moment.
            </p>
          ) : (
            <p className="text-muted-foreground text-sm">
              {sentence(
                name,
                newest,
                usedByDefault,
                listing.data.canAddAnother,
              )}
            </p>
          )}
        </div>
      </div>
      {listing.data && !listing.error ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {newest ? (
            newest.isDefault ? null : (
              <>
                {makeDefault.error ? (
                  <p className="text-destructive text-xs" role="alert">
                    {failureSaid(makeDefault.error)}
                  </p>
                ) : null}
                <Button
                  aria-label={`Make ${newest.label} the default`}
                  disabled={makeDefault.isPending}
                  onClick={() =>
                    makeDefault.mutate({
                      serverId: prompt.serverId,
                      accountId: newest.id,
                    })
                  }
                  size="sm"
                  variant="outline"
                >
                  Make default
                </Button>
              </>
            )
          ) : listing.data.canAddAnother ? (
            <ConnectAnother
              keyApp={app.data?.connect === "key"}
              name={name}
              serverId={prompt.serverId}
              tab={tab}
            />
          ) : null}
        </div>
      ) : null}
      {tab.consentStep}
    </div>
  );
}

/** Which account Bots use, in the person's words. */
function sentence(
  name: string,
  newest: BrokeredAccountRecord | undefined,
  usedByDefault: BrokeredAccountRecord | undefined,
  canAddAnother: boolean,
): string {
  /*
   * An account the app names by no address is "account 2", which starts the sentence with a capital.
   * FOUND IN THE LIVE JOURNEY: "account 2 is connected." An address is left as the app writes it.
   */
  const first =
    newest && newest.identity === null
      ? newest.label.charAt(0).toUpperCase() + newest.label.slice(1)
      : newest?.label;
  if (newest)
    return newest.isDefault || !usedByDefault
      ? `${first} is connected. Bots use it by default.`
      : `${first} is connected. Bots use ${usedByDefault.label} unless you ask for ${newest.label}.`;
  if (!canAddAnother) return `You can't connect a second ${name} account.`;
  return usedByDefault
    ? `Connect another ${name} account. Bots keep using ${usedByDefault.label} until you make another the default.`
    : `Connect another ${name} account.`;
}

/** The press itself, and what it says while the sign-in is open in the other tab. */
function ConnectAnother({
  keyApp,
  name,
  serverId,
  tab,
}: {
  keyApp: boolean;
  name: string;
  serverId: string;
  tab: ReturnType<typeof useConnectInNewTab>;
}) {
  const label = "Connect another account";
  // A key is typed on the app's own page, where Connect another account opens its form.
  if (keyApp || tab.needsKey)
    return (
      <Button
        aria-label={`Connect another ${name} account`}
        render={<Link params={{ key: serverId }} to="/connections/$key" />}
        size="sm"
        variant="outline"
      >
        {label}
      </Button>
    );
  return (
    <>
      {tab.error ? (
        <p className="text-destructive text-xs" role="alert">
          {failureSaid(tab.error)}
        </p>
      ) : null}
      {tab.blockedUrl ? (
        <p className="text-xs" role="status">
          This browser blocked the tab.{" "}
          <a
            className="underline underline-offset-2"
            href={tab.blockedUrl}
            rel="noreferrer"
            target="_blank"
          >
            Open {name}'s sign-in
          </a>
          .
        </p>
      ) : tab.waiting ? (
        <p className="text-muted-foreground text-xs" role="status">
          Finish in the tab that opened.
        </p>
      ) : null}
      <Button
        aria-label={
          tab.waiting || tab.pending
            ? undefined
            : `Connect another ${name} account`
        }
        disabled={tab.pending}
        onClick={() => {
          tab.stopWaiting();
          tab.open(serverId);
        }}
        size="sm"
        variant="outline"
      >
        {tab.waiting
          ? `Waiting for ${name}…`
          : tab.pending
            ? "Opening sign-in…"
            : label}
      </Button>
    </>
  );
}

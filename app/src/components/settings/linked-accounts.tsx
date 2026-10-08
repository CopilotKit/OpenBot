import { IconBrandGithub, IconBrandSlack, IconLink } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { unlinkMutationOptions } from "@/lib/identity/mutations";
import {
  type LinkedAccount,
  linkedAccountsQueryOptions,
} from "@/lib/identity/queries";
import { queryClient } from "@/query-client";

export function linkedAccountDescription(account: LinkedAccount): string {
  if (account.status === "needs_reconnect") {
    return account.handle
      ? `Needs reconnecting · @${account.handle}`
      : "Needs reconnecting";
  }
  return account.handle ? `@${account.handle}` : "Linked";
}

const providerIcons = {
  slack: IconBrandSlack,
  github: IconBrandGithub,
} as const;

/** A provider this build has no mark for gets a neutral link icon rather than someone else's logo. */
export function providerIcon(provider: string) {
  return (
    (providerIcons as Record<string, typeof IconLink | undefined>)[provider] ??
    IconLink
  );
}

/**
 * What the section draws: nothing, rows, an error, or rows with an error under them.
 *
 * Hidden while loading and when nothing is linked (or the deployment has no identity store). A
 * failed refetch keeps the rows already on screen — stale but visible — and says the list could not
 * be refreshed, so a removed account that is still drawn is never shown without that warning. An
 * error with no rows to keep, including over a cached empty list, shows on its own.
 */
export function linkedAccountsSectionState({
  data,
  error,
}: {
  data: LinkedAccount[] | undefined;
  error: Error | null;
}): { rows: LinkedAccount[]; error: string | null } | null {
  const rows = data ?? [];
  if (error) return { rows, error: error.message };
  return rows.length > 0 ? { rows, error: null } : null;
}

/**
 * Who you are in the chat apps and code hosts this deployment talks to.
 *
 * Separate from the connector rows above it: those are services a Bot reads as you, these are how
 * this deployment recognises you when a message or an event arrives from somewhere else.
 */
export function LinkedAccountsSection() {
  const links = useQuery(linkedAccountsQueryOptions());
  const state = linkedAccountsSectionState({
    data: links.data,
    error: links.error,
  });
  if (!state) return null;
  return (
    <PageSection title="Linked accounts">
      {state.rows.length > 0 ? (
        <PageRows>
          {state.rows.map((account, index) => (
            <div key={account.id}>
              {index > 0 ? <Separator /> : null}
              <LinkedAccountRow account={account} />
            </div>
          ))}
        </PageRows>
      ) : null}
      {state.error ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          Your linked accounts could not be loaded: {state.error}
        </p>
      ) : null}
    </PageSection>
  );
}

/**
 * One linked account with its own disconnect, so a second click elsewhere neither re-enables this
 * row mid-request nor overwrites its error.
 */
function LinkedAccountRow({ account }: { account: LinkedAccount }) {
  const unlink = useMutation(unlinkMutationOptions(queryClient));
  const Icon = providerIcon(account.provider);
  return (
    <>
      <Item size="sm">
        <ItemMedia variant="icon">
          <Icon />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{account.title}</ItemTitle>
          <ItemDescription>{linkedAccountDescription(account)}</ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button
            aria-label={`Disconnect ${account.title}`}
            size="sm"
            variant="outline"
            disabled={unlink.isPending}
            onClick={() => unlink.mutate(account.id)}
          >
            Disconnect
          </Button>
        </ItemActions>
      </Item>
      {unlink.error ? (
        <p className="px-3 pb-2 text-destructive text-sm" role="alert">
          Could not disconnect {account.title}: {unlink.error.message}
        </p>
      ) : null}
    </>
  );
}

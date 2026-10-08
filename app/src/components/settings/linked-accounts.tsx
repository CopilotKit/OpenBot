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
 * Who you are in the chat apps and code hosts this deployment talks to.
 *
 * Separate from the connector rows above it: those are services a Bot reads as you, these are how
 * this deployment recognises you when a message or an event arrives from somewhere else.
 */
export function LinkedAccountsSection() {
  const links = useQuery(linkedAccountsQueryOptions());
  // Rows win over the error: a failed background refetch must not replace a list already on screen.
  if (links.data) {
    // Deliberately hidden when nothing is linked, or when this deployment has no identity store.
    if (links.data.length === 0) return null;
    return (
      <PageSection title="Linked accounts">
        <PageRows>
          {links.data.map((account, index) => (
            <div key={account.id}>
              {index > 0 ? <Separator /> : null}
              <LinkedAccountRow account={account} />
            </div>
          ))}
        </PageRows>
      </PageSection>
    );
  }
  if (links.error) {
    return (
      <PageSection title="Linked accounts">
        <p className="text-destructive text-sm" role="alert">
          Your linked accounts could not be loaded: {links.error.message}
        </p>
      </PageSection>
    );
  }
  return null;
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

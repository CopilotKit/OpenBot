import { IconBrandGithub, IconBrandSlack } from "@tabler/icons-react";
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
  const who = account.handle ? `@${account.handle}` : "Linked";
  return account.status === "needs_reconnect"
    ? `Needs reconnecting · ${who}`
    : who;
}

/**
 * Who you are in the chat apps and code hosts this deployment talks to.
 *
 * Separate from the connector rows above it: those are services a Bot reads as you, these are how
 * this deployment recognises you when a message or an event arrives from somewhere else.
 */
export function LinkedAccountsSection() {
  const links = useQuery(linkedAccountsQueryOptions());
  const unlink = useMutation(unlinkMutationOptions(queryClient));
  if (links.isPending) return null;
  if (links.error) {
    return (
      <PageSection title="Linked accounts">
        <p className="text-destructive text-sm" role="alert">
          Your linked accounts could not be loaded.
        </p>
      </PageSection>
    );
  }
  // Deliberately hidden when nothing is linked.
  if (links.data.length === 0) return null;
  return (
    <PageSection title="Linked accounts">
      <PageRows>
        {links.data.map((account, index) => (
          <div key={account.id}>
            {index > 0 ? <Separator /> : null}
            <Item size="sm">
              <ItemMedia variant="icon">
                {account.provider === "slack" ? (
                  <IconBrandSlack />
                ) : (
                  <IconBrandGithub />
                )}
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{account.title}</ItemTitle>
                <ItemDescription>
                  {linkedAccountDescription(account)}
                </ItemDescription>
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
          </div>
        ))}
      </PageRows>
      {unlink.error ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          {unlink.error.message}
        </p>
      ) : null}
    </PageSection>
  );
}

import { IconBrandGithub, IconBrandSlack, IconLink } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  connectGithubMutationOptions,
  issueSlackCodeMutationOptions,
  type SlackLinkCode,
  unlinkMutationOptions,
} from "@/lib/identity/mutations";
import {
  type IdentityProviders,
  identityKeys,
  identityProvidersQueryOptions,
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
  // Own keys only: "constructor" or "toString" would otherwise find an Object prototype member.
  return Object.hasOwn(providerIcons, provider)
    ? providerIcons[provider as keyof typeof providerIcons]
    : IconLink;
}

/**
 * What the section draws: nothing, rows, an error, or rows with an error under them.
 *
 * Hidden until the list has loaded, and when nothing is linked and nothing can be (no identity
 * store, or no provider available to link); shown empty when a provider is available. A
 * failed refetch keeps the rows already on screen — stale but visible — and says the list could not
 * be refreshed, so a removed account that is still drawn is never shown without that warning. An
 * error with no rows to keep, including over a cached empty list, shows on its own.
 */
export function linkedAccountsSectionState({
  data,
  error,
  providers,
}: {
  data: LinkedAccount[] | undefined;
  error: Error | null;
  providers?: IdentityProviders;
}): { rows: LinkedAccount[]; error: string | null } | null {
  const rows = data ?? [];
  if (error) return { rows, error: error.message };
  if (rows.length > 0 || providers?.slack || providers?.github) {
    return { rows, error: null };
  }
  return null;
}

/**
 * Who you are in the chat apps and code hosts this deployment talks to.
 *
 * Separate from the connector rows above it: those are services a Bot reads as you, these are how
 * this deployment recognises you when a message or an event arrives from somewhere else.
 */
export function LinkedAccountsSection() {
  const links = useQuery(linkedAccountsQueryOptions());
  const providers = useQuery(identityProvidersQueryOptions());
  const issueCode = useMutation(issueSlackCodeMutationOptions());
  const connectGithub = useMutation(connectGithubMutationOptions());
  const [issued, setIssued] = useState<SlackLinkCode | null>(null);
  const [copied, setCopied] = useState(false);
  const closeDialog = () => {
    setIssued(null);
    setCopied(false);
    // A link may have completed while the dialog was open.
    queryClient.invalidateQueries({ queryKey: identityKeys.links() });
  };
  // Wait for the list so people with links never see the empty state while /providers answers first.
  if (links.isPending) return null;
  const state = linkedAccountsSectionState({
    data: links.data,
    error: links.error,
    providers: providers.data,
  });
  if (!state) return null;
  return (
    <PageSection
      title="Linked accounts"
      action={
        <div className="flex gap-2">
          {providers.data?.slack ? (
            <Button
              size="sm"
              variant="outline"
              disabled={issueCode.isPending}
              onClick={() =>
                issueCode.mutate(undefined, {
                  onSuccess: (code) => setIssued(code),
                })
              }
            >
              Link Slack
            </Button>
          ) : null}
          {providers.data?.github ? (
            <Button
              size="sm"
              variant="outline"
              disabled={connectGithub.isPending}
              onClick={() =>
                connectGithub.mutate(undefined, {
                  onSuccess: (url) => window.location.assign(url),
                })
              }
            >
              Connect GitHub
            </Button>
          ) : null}
        </div>
      }
    >
      {state.rows.length === 0 && !state.error ? (
        <PageEmpty>No linked accounts yet.</PageEmpty>
      ) : null}
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
      {issueCode.error ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          Could not create a Slack link code: {issueCode.error.message}
        </p>
      ) : null}
      {connectGithub.error ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          Could not connect GitHub: {connectGithub.error.message}
        </p>
      ) : null}
      <Dialog
        open={issued !== null}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Link your Slack account</DialogTitle>
          </DialogHeader>
          <DialogBody className="mt-4">
            {issued ? (
              <div className="grid gap-3 text-sm">
                <p>{issued.instruction}</p>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1">
                    link {issued.code}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      await navigator.clipboard.writeText(
                        `link ${issued.code}`,
                      );
                      setCopied(true);
                    }}
                  >
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
                <p className="text-muted-foreground">
                  The code works once and expires in 10 minutes.
                </p>
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button size="sm" onClick={closeDialog}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

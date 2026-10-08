import { IconBrandGithub, IconBrandSlack, IconLink } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
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

/** The account types a person can link from here, in the order their cards are drawn. */
const linkableProviders = [
  { provider: "slack", title: "Slack" },
  { provider: "github", title: "GitHub" },
] as const;

export type LinkedAccountsEntry =
  | { kind: "linked"; account: LinkedAccount }
  | {
      kind: "available";
      provider: (typeof linkableProviders)[number]["provider"];
      title: string;
    };

/**
 * What the section draws: one card per account type, then an error if the list failed.
 *
 * Each account type is either the account linked there, with its disconnect, or — when this
 * deployment can link it — an unlinked card to connect from. Links stay listed even when their type
 * can no longer be linked, so they can still be disconnected; links of a type this build does not
 * know come last. Connect cards need the list: with no list loaded there is no knowing whether the
 * account is already linked. Hidden when there is nothing to list, nothing to connect and nothing
 * to report. A failed refetch keeps the stale entries on screen with the error under them. A failed
 * providers check is reported too, so a missing Connect card is never unexplained.
 */
export function linkedAccountsSectionState({
  data,
  error,
  providers,
  providersError = null,
}: {
  data: LinkedAccount[] | undefined;
  error: Error | null;
  providers?: IdentityProviders;
  providersError?: Error | null;
}): {
  entries: LinkedAccountsEntry[];
  error: string | null;
  providersError: string | null;
} | null {
  const links = data ?? [];
  const entries: LinkedAccountsEntry[] = [];
  for (const { provider, title } of linkableProviders) {
    const linked = links.filter((account) => account.provider === provider);
    for (const account of linked) entries.push({ kind: "linked", account });
    if (linked.length === 0 && data !== undefined && providers?.[provider]) {
      entries.push({ kind: "available", provider, title });
    }
  }
  for (const account of links) {
    if (
      !linkableProviders.some(({ provider }) => provider === account.provider)
    )
      entries.push({ kind: "linked", account });
  }
  if (entries.length === 0 && !error && !providersError) return null;
  return {
    entries,
    error: error ? error.message : null,
    providersError: providersError ? providersError.message : null,
  };
}

/**
 * Whether the GitHub Connect button is disabled.
 *
 * The mutation settles before the browser has left for GitHub, so a success keeps the button
 * disabled too: the page is about to navigate away and a second click would start a second sign-in.
 */
export function connectGithubPending(mutation: {
  isPending: boolean;
  isSuccess: boolean;
}): boolean {
  return mutation.isPending || mutation.isSuccess;
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
  const [copyFailed, setCopyFailed] = useState(false);
  const closeDialog = () => {
    setIssued(null);
    setCopied(false);
    setCopyFailed(false);
    // A link may have completed while the dialog was open.
    queryClient.invalidateQueries({ queryKey: identityKeys.links() });
  };
  // Wait for the list so people with links never see the empty state while /providers answers first.
  if (links.isPending) return null;
  const state = linkedAccountsSectionState({
    data: links.data,
    error: links.error,
    providers: providers.data,
    providersError: providers.error,
  });
  if (!state) return null;
  const connect = {
    slack: {
      pending: issueCode.isPending,
      start: () =>
        issueCode.mutate(undefined, { onSuccess: (code) => setIssued(code) }),
    },
    github: {
      pending: connectGithubPending(connectGithub),
      start: () =>
        connectGithub.mutate(undefined, {
          onSuccess: (url) => window.location.assign(url),
        }),
    },
  };
  return (
    <PageSection title="Linked accounts">
      {state.entries.length > 0 ? (
        <PageRows>
          {state.entries.map((entry, index) => (
            <div
              key={entry.kind === "linked" ? entry.account.id : entry.provider}
            >
              {index > 0 ? <Separator /> : null}
              {entry.kind === "linked" ? (
                <LinkedAccountRow account={entry.account} />
              ) : (
                <AvailableAccountRow
                  provider={entry.provider}
                  title={entry.title}
                  pending={connect[entry.provider].pending}
                  onConnect={connect[entry.provider].start}
                />
              )}
            </div>
          ))}
        </PageRows>
      ) : null}
      {state.error ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          Your linked accounts could not be loaded: {state.error}
        </p>
      ) : null}
      {state.providersError ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          Could not check which accounts can be linked: {state.providersError}
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
                      const ok = await copyText(
                        `link ${issued.code}`,
                        navigator.clipboard,
                      );
                      setCopied(ok);
                      setCopyFailed(!ok);
                    }}
                  >
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
                {copyFailed ? (
                  <p className="text-destructive" role="alert">
                    Couldn't copy. Select the code and copy it yourself.
                  </p>
                ) : null}
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

/** An account type this deployment can link and the person has not linked yet. */
function AvailableAccountRow({
  provider,
  title,
  pending,
  onConnect,
}: {
  provider: string;
  title: string;
  pending: boolean;
  onConnect: () => void;
}) {
  const Icon = providerIcon(provider);
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        <ItemDescription>Not linked</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button
          aria-label={`Connect ${title}`}
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={onConnect}
        >
          Connect
        </Button>
      </ItemActions>
    </Item>
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

/**
 * Write text to the clipboard, answering whether it landed. The clipboard is missing on plain-http
 * hosts and a write is refused when permission is denied; both are a "no", not an exception.
 */
export async function copyText(
  text: string,
  clipboard: Pick<Clipboard, "writeText"> | undefined,
): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

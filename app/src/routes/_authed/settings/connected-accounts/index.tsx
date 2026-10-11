import {
  IconBrandGoogleDrive,
  IconBrandNotion,
  IconCheck,
  IconPlug,
  IconSearch,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { RowMark } from "@/components/layout/row-mark";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { GithubSources } from "@/components/settings/github-sources";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  connectionsQueryOptions,
  type PluginServer,
  personalConnections,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";
import { clearTeamBotConsentsMutationOptions } from "@/lib/team-bots";

/**
 * The services a Bot reads as you.
 *
 * Yours, not the deployment's. An administrator decides which vendors this deployment may reach at
 * all; this is the other half of that decision, and it is one nobody can make for you — there is no
 * endpoint for an administrator to connect an account on somebody's behalf. A Bot calling one of
 * these runs on your own grant, so it sees exactly what you can see and nothing else.
 */
export const Route = createFileRoute("/_authed/settings/connected-accounts/")({
  component: RouteComponent,
  /*
   * `?connected=` is how the OAuth callback reports back, carrying a server key on success and
   * `failed` otherwise. It is the only channel available: the callback is a redirect from another
   * company's server, so there is no response body to read.
   *
   * The key is omitted rather than set to undefined. Present-but-undefined makes `search` a required
   * prop on every Link to this route, which is a lot of ripple for a parameter only the callback sets.
   */
  validateSearch: (search: Record<string, unknown>): { connected?: string } =>
    typeof search.connected === "string" ? { connected: search.connected } : {},
});

/** The same marks the admin connector list uses: these are the same vendors seen from your side. */
const MARKS: Record<string, React.ComponentType<{ className?: string }>> = {
  "google-drive": IconBrandGoogleDrive,
  notion: IconBrandNotion,
};

const markFor = (key: string) => MARKS[key] ?? IconPlug;

/**
 * The brokered apps this page lists, which is not every brokered row.
 *
 * Exported as a function rather than left inline in the render, for the reason `matchingApps` on the
 * Composio picker is: the rule is the thing worth pinning and pinning it needs no DOM, no router and
 * no query client. See its one clause below.
 */
export function brokeredAccountsListedOn(
  servers: PluginServer[],
): PluginServer[] {
  return servers.filter(
    (server) =>
      server.provenance === "composio" &&
      server.authScheme !== "NO_AUTH" &&
      server.accountMode !== "shared",
  );
}

/** Apps whose account is the organisation's, shown so a person knows a Bot does not act as them there. */
export function sharedAccountsListedOn(
  servers: PluginServer[],
): PluginServer[] {
  return servers.filter(
    (server) =>
      server.provenance === "composio" && server.accountMode === "shared",
  );
}

/** Which of this page's sections are worth drawing, for a given personal-account count and server list. */
export type ConnectedAccountSection = "personal" | "empty" | "shared";

/**
 * The "which sections show" decision, pinned once rather than left as two conditions that happen
 * to agree.
 *
 * "personal" and "empty" are mutually exclusive: either there is at least one account of this
 * person's own to search and connect, or there is the empty-state copy saying so. "shared" is
 * independent of both — a deployment whose only brokered apps are all Shared has `accountCount`
 * zero (nothing personal to connect) and still has rows the Shared section must draw, because
 * those rows exist to tell a person a Bot acts as the team there, not as them. Dropping "shared"
 * whenever "empty" is chosen would hide that fact for exactly the deployments where it is the
 * only thing on this page worth saying.
 */
export function connectedAccountSections(
  accountCount: number,
  servers: PluginServer[],
): ConnectedAccountSection[] {
  const sections: ConnectedAccountSection[] = [
    accountCount > 0 ? "personal" : "empty",
  ];
  if (sharedAccountsListedOn(servers).length > 0) {
    sections.push("shared");
  }
  return sections;
}

function RouteComponent() {
  const { connected: outcome } = Route.useSearch();
  const [search, setSearch] = React.useState("");
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());

  /*
   * ONLY THE PERSON'S OWN. A Shared app's row is the deployment's, not this person's, and the
   * "Connected" badge this set feeds would otherwise tell them they hold an account they don't.
   */
  const connected = new Set(
    personalConnections(connections.data?.connections ?? []).map(
      (row) => row.serverId,
    ),
  );
  const added = new Set((plugins.data?.servers ?? []).map((s) => s.id));

  /*
   * Only vendors reached as a person, and only ones an administrator has enabled.
   *
   * A vendor with a shared token has nothing for you to decide: it answers the same for everybody,
   * so listing it here would offer a choice you do not have. And a vendor nobody has enabled cannot
   * be connected at all, because there is no OAuth client to consent against.
   */
  const yours = (plugins.data?.catalogue ?? []).filter(
    (entry) => entry.auth === "user-oauth" && added.has(entry.key),
  );

  /*
   * Brokered apps belong here for the same reason the OAuth ones do: they answer as you.
   *
   * The filter above names the catalogue's `user-oauth` kind, which a brokered row cannot have
   * because it has no catalogue entry at all — so the one connector that is nothing but per-person
   * accounts was the one this page never listed.
   *
   * EXCEPT THE ONES THAT NEED NO ACCOUNT, WHICH IS THE SAME RULE THE `user-oauth` FILTER ABOVE IS.
   * That one keeps out a vendor with a shared token because it "has nothing for you to decide"; a
   * Composio `NO_AUTH` app has exactly as little, one layer further in. There is no account to make:
   * `/servers/:id/connect` refuses to create one and the call gate lets it through with no row, so
   * a row for it here can never turn green. What an admin enabling Hacker News put on every
   * person's page was a permanently grey "Not connected" that reads as an unfinished task, opening
   * a page that says the app needs no account and draws no button — the list and the page it opens
   * contradicting each other, with the list the more believable of the two.
   *
   * ASKED OF THE RECORDED SCHEME, which this read already carries and the detail route already
   * consumes. Anything that is not the vendor's `NO_AUTH` is an app somebody connects, an
   * unrecorded scheme included: a row whose column was never written is far likelier to be a key or
   * consent app, and dropping it here would hide a connection somebody does have.
   */
  const brokered = brokeredAccountsListedOn(plugins.data?.servers ?? []);
  /*
   * Listed, never connected here. A Shared app's account is the organisation's, not this person's to
   * make or to break, so this list draws no Connect action and links nowhere — it exists only so a
   * person can see that a Bot calling this app acts as the team, not as them.
   */
  const shared = sharedAccountsListedOn(plugins.data?.servers ?? []);
  const sectionsToShow = connectedAccountSections(
    yours.length + brokered.length,
    plugins.data?.servers ?? [],
  );
  const accounts = [
    ...yours.map((entry) => {
      const Mark = markFor(entry.key);
      return {
        key: entry.key,
        title: entry.title,
        summary: entry.summary,
        mark: <Mark className="size-4" />,
      };
    }),
    ...brokered.map((server) => ({
      key: server.id,
      title: server.title,
      summary: server.summary || `Connect your ${server.title} account.`,
      mark: <PluginLogo logo={server.logo} />,
    })),
  ];
  const query = search.trim().toLocaleLowerCase();
  const matching = accounts.filter((account) =>
    `${account.title} ${account.summary}`.toLocaleLowerCase().includes(query),
  );
  const connectedCount = accounts.filter((account) =>
    connected.has(account.key),
  ).length;
  const sections = [
    {
      title: "Connected",
      accounts: matching.filter((account) => connected.has(account.key)),
    },
    {
      title: "Not connected",
      accounts: matching.filter((account) => !connected.has(account.key)),
    },
  ];

  return (
    <PageShell
      className="max-w-4xl @container"
      description="Connect your apps so your Bots can work with them."
      title="Connected accounts"
    >
      {/*
       * Only the failure is worth saying. A success needs no sentence: the row it came back to now
       * reads "Connected", which is the same news told by the thing it is news about.
       */}
      {outcome === "failed" ? (
        <p className="text-destructive text-sm" role="alert">
          That account could not be connected. Nothing was saved — try again.
        </p>
      ) : null}
      {/*
       * BOTH READS DECIDE THIS, AND ONLY ONE OF THEM USED TO. The waits were already paired here;
       * the errors were not — this branch tested `plugins.error` alone, so a `/api/plugins` that
       * succeeded beside a `/api/plugins/connections` that failed left the `connected` set empty and
       * every row below asserting "Not connected", with no error text anywhere on the page. Somebody
       * holding Gmail through Composio and Drive through OAuth was shown both as unconnected and
       * clicked through to reconnect accounts they already had. The brokered rows make it worse than
       * it was before they existed, because a brokered row's entire content is the connection state.
       *
       * ONE SENTENCE FOR BOTH, because the two failures are one fact from where the reader stands:
       * this page could not be loaded, and what it would otherwise draw is not shown rather than
       * drawn wrong.
       */}
      {plugins.isPending || connections.isPending ? null : plugins.error ||
        connections.error ? (
        <p className="mt-12 text-destructive text-sm" role="alert">
          Your connected accounts could not be loaded, so nothing is listed here
          rather than a list that may be wrong. Reload the page, and tell an
          administrator if it persists.
        </p>
      ) : sectionsToShow.includes("empty") ? (
        <PageSection>
          <PageEmpty>
            Nothing to connect yet. These appear once an administrator enables a
            connector that reads as the person asking.
          </PageEmpty>
        </PageSection>
      ) : (
        <>
          <p className="mt-5 text-xs text-muted-foreground">
            {connectedCount} connected · {accounts.length} available
          </p>
          <InputGroup className="mt-3 h-9 border-transparent bg-muted/60 shadow-none dark:bg-muted/60">
            <InputGroupAddon>
              <IconSearch aria-hidden="true" className="size-4" />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search apps"
              placeholder="Search apps"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </InputGroup>
          {matching.length === 0 ? (
            <p className="mt-8 text-sm text-muted-foreground" role="status">
              No apps match “{search.trim()}”.
            </p>
          ) : (
            sections
              .filter((section) => section.accounts.length > 0)
              .map((section) => (
                <section
                  className="mt-8"
                  key={section.title}
                  aria-label={section.title}
                >
                  <h2 className="mb-3 px-2 text-xs font-medium text-muted-foreground">
                    {section.title}
                  </h2>
                  <div className="grid grid-cols-1 gap-x-6 gap-y-2 @min-[36rem]:grid-cols-2">
                    {section.accounts.map((account) => (
                      <Item
                        key={account.key}
                        className="min-w-0 flex-nowrap gap-3 px-2 py-3"
                        data-testid={`account-${account.key}`}
                        render={
                          <Link
                            params={{ key: account.key }}
                            to="/settings/connected-accounts/$key"
                          />
                        }
                        size="sm"
                      >
                        <RowMark className="size-9">{account.mark}</RowMark>
                        <ItemContent className="min-w-0 gap-0.5">
                          <ItemTitle className="block w-auto truncate">
                            {account.title}
                          </ItemTitle>
                          <ItemDescription
                            className="line-clamp-1 break-all text-xs"
                            title={account.summary}
                          >
                            {account.summary}
                          </ItemDescription>
                        </ItemContent>
                        <ItemActions className="shrink-0">
                          {connected.has(account.key) ? (
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                              <IconCheck
                                aria-hidden="true"
                                className="size-3.5 text-emerald-600 dark:text-emerald-400"
                              />
                              Connected
                            </span>
                          ) : (
                            <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium">
                              Connect
                            </span>
                          )}
                        </ItemActions>
                      </Item>
                    ))}
                  </div>
                </section>
              ))
          )}
        </>
      )}
      {/*
       * Below the searchable list, and never inside it: these rows answer no search and carry no
       * Connect action, because there is nothing here for this person to do. The point of the
       * section is the opposite of the one above it — to say plainly that a Bot calling this app
       * acts as the organisation, not as whoever is looking at this page.
       *
       * RENDERED OUTSIDE THE EMPTY-STATE BRANCH, deliberately: `connectedAccountSections` can
       * choose "empty" and "shared" together, because a deployment whose only brokered apps are
       * all Shared has an empty `accounts` list — there is nothing personal to connect — but that
       * is not the same as having nothing to show. Nesting this inside the empty branch's `<>…</>`
       * used to mean the empty-state copy ("Nothing to connect yet") replaced this section outright
       * instead of sitting above it. The gating condition matches the one guarding that branch so
       * this section never draws while the reads are pending or failed.
       */}
      {!plugins.isPending &&
      !connections.isPending &&
      !plugins.error &&
      !connections.error &&
      sectionsToShow.includes("shared") ? (
        <PageSection title="Shared by your organisation">
          <div className="grid grid-cols-1 gap-x-6 gap-y-2 @min-[36rem]:grid-cols-2">
            {shared.map((server) => (
              <Item
                key={server.id}
                className="min-w-0 flex-nowrap gap-3 px-2 py-3"
                data-testid={`account-${server.id}`}
                size="sm"
              >
                <RowMark className="size-9">
                  <PluginLogo logo={server.logo} />
                </RowMark>
                <ItemContent className="min-w-0 gap-0.5">
                  <ItemTitle className="block w-auto truncate">
                    {server.title}
                  </ItemTitle>
                  <ItemDescription
                    className="line-clamp-1 break-all text-xs"
                    title="Shared by your organisation. Bots act as the team account."
                  >
                    Shared by your organisation. Bots act as the team account.
                  </ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </div>
        </PageSection>
      ) : null}
      <GithubSources />
      <TeamBotConsents />
    </PageShell>
  );
}

/**
 * A Bot someone shared with you uses its owner's connected apps unless you let it use yours on the
 * card it shows you. This forgets every one of those answers, so each such Bot asks again.
 */
function TeamBotConsents() {
  const clear = useMutation(clearTeamBotConsentsMutationOptions());
  return (
    <PageSection
      description="A Bot someone shared with you uses their connected apps, and yours only where you allowed it on the card it showed you."
      title="Bots shared with you"
    >
      {clear.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {clear.error.message}
        </p>
      ) : null}
      <PageRows>
        <Item size="sm">
          <ItemContent>
            <ItemTitle>Your answers</ItemTitle>
            <ItemDescription>
              {clear.isSuccess
                ? "Cleared. Each will ask again."
                : "Forget them, so each asks again."}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              disabled={clear.isPending}
              onClick={() => clear.mutate()}
              size="sm"
              variant="outline"
            >
              Clear
            </Button>
          </ItemActions>
        </Item>
      </PageRows>
    </PageSection>
  );
}

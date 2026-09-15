import {
  IconBrandGoogleDrive,
  IconBrandNotion,
  IconChevronRight,
  IconPlug,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { RowMark } from "@/components/layout/row-mark";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  connectionsQueryOptions,
  type PluginServer,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";
import { cn } from "@/lib/utils";

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
      server.provenance === "composio" && server.authScheme !== "NO_AUTH",
  );
}

function RouteComponent() {
  const { connected: outcome } = Route.useSearch();
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());

  const connected = new Set(
    (connections.data?.connections ?? []).map((row) => row.serverId),
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

  return (
    <PageShell
      description="Services a Bot reads as you, so it only ever sees what you can see. Connecting is yours to grant, and nobody can grant it for you."
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
      ) : (
        <PageSection>
          {yours.length === 0 && brokered.length === 0 ? (
            /*
             * Says whose move it is. "Nothing here" on its own reads as though you failed to do
             * something, when what is missing is an administrator enabling a connector.
             */
            <PageEmpty>
              Nothing to connect yet. These appear once an administrator enables
              a connector that reads as the person asking.
            </PageEmpty>
          ) : (
            <PageRows>
              {yours.map((entry, index) => {
                const Mark = markFor(entry.key);
                return (
                  <React.Fragment key={entry.key}>
                    {/* A real link with no children: children passed to `render` replace the row's own. */}
                    <Item
                      data-testid={`account-${entry.key}`}
                      render={
                        <Link
                          params={{ key: entry.key }}
                          to="/settings/connected-accounts/$key"
                        />
                      }
                      size="sm"
                    >
                      <RowMark>
                        <Mark className="size-4" />
                      </RowMark>
                      <ItemContent>
                        <ItemTitle>{entry.title}</ItemTitle>
                        <ItemDescription>{entry.summary}</ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        {/*
                         * A dot, so connected is legible without reading. Two states that differ only
                         * by the word "not" are two states somebody has to read carefully to tell
                         * apart, which is the wrong amount of effort for the only fact this row
                         * carries. The same green as the account page's own control, so the list and
                         * the page it opens agree at a glance.
                         *
                         * Decorative: the text beside it already says which, so a screen reader that
                         * announced the dot as well would say it twice.
                         */}
                        <span
                          aria-hidden="true"
                          className={cn(
                            "size-1.5 rounded-full",
                            connected.has(entry.key)
                              ? "bg-emerald-500"
                              : "bg-muted-foreground/40",
                          )}
                        />
                        <span className="text-muted-foreground text-xs">
                          {connected.has(entry.key)
                            ? "Connected"
                            : "Not connected"}
                        </span>
                        <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                      </ItemActions>
                    </Item>
                    {(index !== yours.length - 1 || brokered.length > 0) && (
                      <Separator />
                    )}
                  </React.Fragment>
                );
              })}
              {brokered.map((server, index) => {
                const Mark = markFor(server.id);
                return (
                  <React.Fragment key={server.id}>
                    <Item
                      data-testid={`account-${server.id}`}
                      render={
                        <Link
                          params={{ key: server.id }}
                          to="/settings/connected-accounts/$key"
                        />
                      }
                      size="sm"
                    >
                      <RowMark>
                        <Mark className="size-4" />
                      </RowMark>
                      <ItemContent>
                        <ItemTitle>{server.title}</ItemTitle>
                        {/* Written here rather than read off the row: a brokered app has no
                            catalogue entry, so the summary the server sends back is empty. */}
                        <ItemDescription>
                          Reached through Composio, which holds the account, so
                          a Bot sees only what you can see.
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        {/*
                         * The same dot and the same two words as the rows above, read out of the
                         * same set. The connections endpoint now answers out of both tables, so a
                         * brokered app this person has connected is in `connected` under the id of
                         * its server row — which is the id this row is drawn from. The state was
                         * never a different kind of fact here, only an unanswerable one.
                         */}
                        <span
                          aria-hidden="true"
                          className={cn(
                            "size-1.5 rounded-full",
                            connected.has(server.id)
                              ? "bg-emerald-500"
                              : "bg-muted-foreground/40",
                          )}
                        />
                        <span className="text-muted-foreground text-xs">
                          {connected.has(server.id)
                            ? "Connected"
                            : "Not connected"}
                        </span>
                        <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                      </ItemActions>
                    </Item>
                    {index !== brokered.length - 1 && <Separator />}
                  </React.Fragment>
                );
              })}
            </PageRows>
          )}
        </PageSection>
      )}
    </PageShell>
  );
}

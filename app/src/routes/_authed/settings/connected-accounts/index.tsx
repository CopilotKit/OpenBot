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
      {plugins.isPending || connections.isPending ? null : plugins.error ? (
        <p className="mt-12 text-destructive text-sm" role="alert">
          Your connected accounts could not be loaded.
        </p>
      ) : (
        <PageSection>
          {yours.length === 0 ? (
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
                    {index !== yours.length - 1 && <Separator />}
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

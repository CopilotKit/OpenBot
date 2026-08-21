import {
  IconBrandGoogleDrive,
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
  type CatalogueItem,
  connectionsQueryOptions,
  type PluginServer,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * What this deployment can reach, as one list per state.
 *
 * This screen used to be three tabs: a catalogue of what could be added, a second tab for what had
 * been, and skills. Answering one question about one vendor — is Drive available, and what can it
 * do — meant visiting two of them, and the third was a different kind of thing altogether. Two
 * lists say the same thing in one read: what is connected, and what else there is.
 *
 * Every row goes to that vendor's own page, because what a connector needs configured is not the
 * same from one vendor to the next. A token, an OAuth client, an instance hostname, and a grant per
 * tool per Bot do not fit on a row, and the previous screen's attempt to fit them made a page that
 * scrolled sideways.
 */
export const Route = createFileRoute("/_authed/admin/plugins/")({
  component: RouteComponent,
});

/**
 * A vendor's own mark where there is one, and a plug where there is not.
 *
 * The fallback covers a server an administrator added by URL, which has no catalogue entry and so no
 * mark of its own — and it would cover a catalogue vendor Tabler ships no brand for. Only Drive is in
 * the catalogue today, and Tabler has it.
 */
const MARKS: Record<string, React.ComponentType<{ className?: string }>> = {
  "google-drive": IconBrandGoogleDrive,
};

const markFor = (key: string) => MARKS[key] ?? IconPlug;

/**
 * What a connected row says on the right.
 *
 * The current answer rather than the field's name, which is what the layout skill asks of a summary:
 * "4 tools · 2 Bots" tells an administrator where this vendor stands, and "Tools" would not.
 *
 * A vendor reached as the person asking is a special case worth its own words. It can be fully
 * configured — client registered, tools listed — and still answer nothing, because the thing that
 * reads anything is a grant belonging to whoever is asking. "Not connected" is about you, not about
 * the deployment.
 */
function summaryFor(
  server: PluginServer,
  /**
   * The vendor's auth kind, from the catalogue rather than the server record.
   *
   * A server row says what this deployment has stored; whose credential reaches it is a fact about
   * the vendor. Undefined for a server added by URL, which has no catalogue entry and is therefore
   * never reached as a person.
   */
  auth: CatalogueItem["auth"] | undefined,
  youConnected: boolean,
): string {
  if (auth === "user-oauth" && !youConnected) return "Not connected";
  if (server.tools.length === 0) return "No tools yet";

  const bots = new Set(server.tools.flatMap((tool) => tool.grantedTo)).size;
  const tools = `${server.tools.length} ${server.tools.length === 1 ? "tool" : "tools"}`;
  if (bots === 0) return `${tools} · no Bots`;
  return `${tools} · ${bots} ${bots === 1 ? "Bot" : "Bots"}`;
}

function RouteComponent() {
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());

  const connected = new Set(
    (connections.data?.connections ?? []).map((row) => row.serverId),
  );
  const added = new Set((plugins.data?.servers ?? []).map((s) => s.id));
  const explore = (plugins.data?.catalogue ?? []).filter(
    (entry) => !added.has(entry.key),
  );
  /** Keyed by catalogue key, which is also the server id, so a row can ask how it is reached. */
  const authByKey = new Map(
    (plugins.data?.catalogue ?? []).map((entry) => [entry.key, entry.auth]),
  );

  return (
    <PageShell
      description="What this deployment can reach, and which Bots may reach it. Adding a plugin is account-wide; which Bots hold its tools is decided on its own page."
      title="Plugins"
    >
      {/* Pending, error, empty, rows — pending first, so no sentence asserts anything mid-fetch. */}
      {plugins.isPending ? null : plugins.error ? (
        <p className="mt-12 text-destructive text-sm" role="alert">
          Plugins could not be loaded.
        </p>
      ) : (
        <>
          <PageSection
            description="Added for the whole deployment. Open one to set what it needs and which Bots hold its tools."
            title="Connected"
          >
            {plugins.data?.servers.length === 0 ? (
              <PageEmpty>
                Nothing connected yet. Everything available is below.
              </PageEmpty>
            ) : (
              <PageRows>
                {plugins.data?.servers.map((server, index) => {
                  const Mark = markFor(server.id);
                  return (
                    <React.Fragment key={server.id}>
                      {/*
                       * A real link with no children. `useRender` merges props, and children passed
                       * here replace the row's own — the media, content and actions all vanish and
                       * the row draws empty. Its accessible name comes from the title inside it.
                       */}
                      <Item
                        data-testid={`plugin-${server.id}`}
                        render={
                          <Link
                            params={{ key: server.id }}
                            to="/admin/plugins/$key"
                          />
                        }
                        size="sm"
                      >
                        <RowMark>
                          <Mark className="size-4" />
                        </RowMark>
                        <ItemContent>
                          <ItemTitle>{server.title}</ItemTitle>
                          {/*
                           * The vendor's last failure takes the description's place when there is
                           * one. A server with no tools and no explanation reads as a server that
                           * offers nothing, which sends somebody looking in the wrong place.
                           */}
                          <ItemDescription
                            className={
                              server.lastError ? "text-destructive" : undefined
                            }
                          >
                            {server.lastError ?? server.summary}
                          </ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <span className="text-muted-foreground text-xs">
                            {summaryFor(
                              server,
                              authByKey.get(server.id),
                              connected.has(server.id),
                            )}
                          </span>
                          <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                        </ItemActions>
                      </Item>
                      {index !== (plugins.data?.servers.length ?? 0) - 1 && (
                        <Separator />
                      )}
                    </React.Fragment>
                  );
                })}
              </PageRows>
            )}
          </PageSection>

          <PageSection
            description="Reviewed, first-party servers this build will talk to. Open one to add it."
            title="Explore plugins"
          >
            {explore.length === 0 ? (
              <PageEmpty>Everything in the catalogue is connected.</PageEmpty>
            ) : (
              <PageRows>
                {explore.map((entry: CatalogueItem, index) => {
                  const Mark = markFor(entry.key);
                  return (
                    <React.Fragment key={entry.key}>
                      <Item
                        data-testid={`plugin-${entry.key}`}
                        render={
                          <Link
                            params={{ key: entry.key }}
                            to="/admin/plugins/$key"
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
                          <span className="text-muted-foreground text-xs">
                            Not added
                          </span>
                          <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                        </ItemActions>
                      </Item>
                      {index !== explore.length - 1 && <Separator />}
                    </React.Fragment>
                  );
                })}
              </PageRows>
            )}
          </PageSection>
        </>
      )}
    </PageShell>
  );
}

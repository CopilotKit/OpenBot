import { IconBrandGithub, IconChevronRight } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { GithubSources } from "@/components/settings/github-sources";
import {
  type LinkableProvider,
  LinkedAccountSection,
  linkableProviderTitle,
} from "@/components/settings/linked-accounts";
import {
  linkedNotice,
  visibleLinkedNotice,
} from "@/components/settings/linked-notice";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { IDENTITY_SUMMARIES, isBrokeredGithub } from "@/lib/connections/rows";
import { linkedAccountsQueryOptions } from "@/lib/identity/queries";
import {
  connectionsQueryOptions,
  personalConnections,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * GitHub's or Slack's page under Connections: the person's own account there, and for GitHub what
 * hangs off it.
 *
 * These used to be a "Linked accounts" section and a "GitHub events" section on the Connections
 * page itself, beside the apps, so a person had to know a link was a different kind of thing from an
 * app before they could find it. Now each is a row like any app, and this is the row's page.
 *
 * `linked` is what the GitHub callback sends back, `?linked=github` and its failures. It is said
 * once and then dropped from the address, so a reload does not repeat the news.
 */
export function IdentityConnectionPage({
  linked,
  provider,
}: {
  linked: string | undefined;
  provider: LinkableProvider;
}) {
  const title = linkableProviderTitle(provider);
  const [arrival] = useState(() => linkedNotice(linked));
  const links = useQuery(linkedAccountsQueryOptions());
  const notice = visibleLinkedNotice(arrival, links.data);
  const navigate = useNavigate();
  useEffect(() => {
    if (linked !== undefined) {
      navigate({
        to: ".",
        search: (previous: Record<string, unknown>) => {
          const { linked: _linked, ...rest } = previous;
          return rest;
        },
        replace: true,
      });
    }
  }, [linked, navigate]);

  return (
    <PageShell
      backButton={{ label: "Connections", linkProps: { to: "/connections" } }}
      description={IDENTITY_SUMMARIES[provider]}
      title={title}
    >
      {notice ? (
        <p
          className={
            notice.tone === "error"
              ? "mt-4 text-destructive text-sm"
              : "mt-4 text-muted-foreground text-sm"
          }
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.text}
        </p>
      ) : null}
      <LinkedAccountSection provider={provider} />
      {provider === "github" ? (
        <>
          <GithubSources />
          <GithubTools />
        </>
      ) : null}
    </PageShell>
  );
}

/**
 * A brokered GitHub app, where one is enabled. It is a separate connection — tools that read and
 * change repositories as you — and the Connections list leaves its row out so GitHub is listed once,
 * which makes this the way to it.
 */
function GithubTools() {
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const app = plugins.data?.composioConfigured
    ? plugins.data.servers.find(
        (server) => isBrokeredGithub(server) && server.accountMode !== "shared",
      )
    : undefined;
  if (!app) return null;
  const connected = personalConnections(
    connections.data?.connections ?? [],
  ).some((row) => row.serverId === app.id);
  return (
    <PageSection
      description="Lets your Bots read and change your repositories as you. You connect this separately from your account above."
      title="Tools"
    >
      <PageRows>
        <Item
          render={<Link params={{ key: app.id }} to="/connections/$key" />}
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconBrandGithub />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>GitHub tools</ItemTitle>
            <ItemDescription>
              {connected ? "Connected" : "Not connected"}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
      </PageRows>
    </PageSection>
  );
}

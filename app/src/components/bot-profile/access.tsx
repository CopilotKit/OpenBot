import { IconApps, IconBox, IconChevronRight } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import { HandoffPanel } from "@/components/agents/handoff-panel";
import {
  AppAccessAction,
  appAccessSentence,
} from "@/components/plugins/app-access-action";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { Button } from "@/components/ui/button";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import type { AgentProfile } from "@/lib/agents/queries";
import { botAppsQueryOptions } from "@/lib/app-access/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { setPluginGrantMutationOptions } from "@/lib/plugins/mutations";
import {
  agentPluginsQueryOptions,
  type GrantedPlugins,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";
import { readToolName } from "@/lib/plugins/tool-name";
import { queryClient } from "@/query-client";

/**
 * "google-drive" as "Google Drive": the connector key, said the way a person would.
 *
 * ONLY FOR A CONNECTOR THE APP-ACCESS READ DID NOT NAME. Every app it names is drawn by its own
 * display name — "Gmail", where this would have said "Composio Gmail".
 */
function connectorName(key: string): string {
  return key
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Connector key → the labels of the tools this Bot holds on it.
 *
 * Vendors prefix every tool with their own name — "Notion create pages" — which next to a row
 * already titled Notion reads as a stutter. Stripped only as a leading word, and re-cased, so
 * "Notion search" becomes "Search" while "Search notion pages" is left alone.
 */
function connectorTools(plugins: GrantedPlugins): Map<string, string[]> {
  const connectors = new Map<string, string[]>();
  for (const tool of plugins.tools) {
    const key = tool.ref.split("/")[0] ?? tool.ref;
    let label = readToolName(tool.toolName).label;
    const prefix = `${key.toLowerCase()} `;
    if (label.toLowerCase().startsWith(prefix)) {
      const rest = label.slice(prefix.length);
      label = rest ? rest[0]?.toUpperCase() + rest.slice(1) : label;
    }
    connectors.set(key, [...(connectors.get(key) ?? []), label]);
  }
  return connectors;
}

/** How many apps this Bot holds tools on. For the summary on the Bot's page. */
export function connectorCount(plugins: GrantedPlugins): number {
  return connectorTools(plugins).size;
}

/** What this Bot may reach: your skills on it, everything granted to it, and who it may ask. */
export function AccessSections({ agent }: { agent: AgentProfile }) {
  return (
    <>
      {agent.mine ? <YourSkills agentId={agent.id} /> : null}
      <Granted agentId={agent.id} />
      <HandoffPanel agentId={agent.id} />
    </>
  );
}

/**
 * Your own skills, one switch each. Only on your own Bot: the server lets a person put their own
 * skill on a Bot they own, and neither half alone is enough.
 */
function YourSkills({ agentId }: { agentId: string }) {
  const me = useQuery(currentUserQueryOptions()).data;
  const page = useQuery(pluginsPageQueryOptions());
  const grant = useMutation(setPluginGrantMutationOptions(queryClient));
  const skills = (page.data?.skills ?? []).filter(
    (skill) => me && skill.ownerUserId === me.id,
  );
  return (
    <PageSection
      description="Turn on a skill to use it with this Bot. Type / in a conversation to run it."
      title="Your skills"
    >
      {grant.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {grant.error.message}
        </p>
      ) : null}
      {page.isPending ? null : page.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          Couldn't load your skills. Reload the page.
        </p>
      ) : skills.length === 0 ? (
        <PageEmpty>
          No skills yet.{" "}
          <Link
            className="underline underline-offset-4"
            to="/capabilities/skills"
          >
            Write one
          </Link>
          .
        </PageEmpty>
      ) : (
        <PageRows>
          {skills.map((skill, index) => (
            <Fragment key={skill.slug}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconBox />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>/{skill.slug}</ItemTitle>
                  <ItemDescription>{skill.summary}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    aria-label={skill.slug}
                    checked={skill.grantedTo.includes(agentId)}
                    disabled={grant.isPending}
                    onCheckedChange={(granted) =>
                      grant.mutate({
                        agentId,
                        granted,
                        kind: "skill",
                        ref: skill.slug,
                      })
                    }
                  />
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}

/**
 * Everything this Bot holds, read from the same snapshot a run is offered, and what each app is for
 * the person looking.
 *
 * READ-ONLY FOR GRANTS, NOT FOR THE PERSON'S OWN PART. Apps are granted by an administrator, who gets
 * a link to where that is decided. But a Bot that holds Gmail is no use to somebody who has not
 * connected their Gmail, and this list used to say "Gmail · 4 tools" to everybody alike — so each
 * app now says what it is for the person reading (`GET /api/plugins/for/:agentId/apps`) with the one
 * thing they can do about it: Connect, Reconnect, Request access, or Requested. The state is the
 * server's and is drawn as it comes; see `AppAccessAction`.
 *
 * ADMINISTRATORS SEE THEIR OWN STATE HERE TOO, AND NOBODY ELSE'S. The app-access read answers for
 * whoever is asking, exactly as the connections read does, so this cannot become a list of who has
 * connected what.
 */
function Granted({ agentId }: { agentId: string }) {
  const me = useQuery(currentUserQueryOptions()).data;
  const plugins = useQuery(agentPluginsQueryOptions(agentId));
  const apps = useQuery(botAppsQueryOptions(agentId));
  // Both, so no row is drawn without its state and then redrawn with one a moment later.
  if (plugins.isPending || apps.isPending) return null;
  if (!plugins.data) {
    return (
      <p className="mt-6 text-destructive text-sm" role="alert">
        Couldn't load what this Bot can use. Reload the page.
      </p>
    );
  }
  const admin = me?.role === "admin";
  const tools = connectorTools(plugins.data);
  const states = apps.data ?? [];
  /*
   * Every app the Bot holds a grant for, by the app's own name, and then any connector the grant
   * snapshot names that the app-access read did not — which is none on a healthy deployment, and
   * keeps a row from vanishing on one where the second read failed.
   */
  const described = new Set(states.map((app) => app.key));
  const rest = [...tools.entries()].filter(([key]) => !described.has(key));
  const skills = plugins.data.skills;
  const count = states.length + rest.length + skills.length;
  return (
    <PageSection
      description="The apps and skills this Bot can use, and whether each app is ready for you. It can't use anything else."
      title="What it can use"
    >
      {apps.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          Couldn't check whether each app is ready for you. Reload the page.
        </p>
      ) : null}
      {count === 0 ? (
        <PageEmpty>
          No apps yet. An admin has to add them. Until then this Bot can only
          talk with you.
        </PageEmpty>
      ) : (
        <PageRows>
          {states.map((app, index) => {
            const labels = tools.get(app.key) ?? [];
            return (
              <Fragment key={app.key}>
                {index > 0 ? <Separator /> : null}
                <Item data-app={app.key} data-state={app.state} size="sm">
                  <ItemMedia variant="icon">
                    <PluginLogo logo={app.logo} />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{app.displayName}</ItemTitle>
                    {/*
                     * Unclamped: the sentence ends on who can fix it, and two lines at a phone's
                     * width cut exactly that off.
                     */}
                    <ItemDescription className="line-clamp-none">
                      {app.state === "ready"
                        ? [appAccessSentence(app)]
                            .concat(labels.length > 0 ? [toolList(labels)] : [])
                            .join(" ")
                        : appAccessSentence(app)}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {app.state === "ready" ? (
                      <ToolCount count={labels.length} />
                    ) : (
                      <AppAccessAction access={app} agentId={agentId} />
                    )}
                    {admin ? (
                      <ManageLink
                        agentId={agentId}
                        appKey={app.key}
                        title={app.displayName}
                      />
                    ) : null}
                  </ItemActions>
                </Item>
              </Fragment>
            );
          })}
          {rest.map(([key, labels], index) => (
            <Fragment key={key}>
              {states.length + index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconApps />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{connectorName(key)}</ItemTitle>
                  <ItemDescription>{toolList(labels)}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <ToolCount count={labels.length} />
                  {admin ? (
                    <ManageLink
                      agentId={agentId}
                      appKey={key}
                      title={connectorName(key)}
                    />
                  ) : null}
                </ItemActions>
              </Item>
            </Fragment>
          ))}
          {skills.map((skill, index) => (
            <Fragment key={skill.slug}>
              {states.length + rest.length + index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconBox />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{skill.title}</ItemTitle>
                  <ItemDescription>{skill.summary}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-sm">Skill</span>
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}

/** The first few tool labels, and how many more. */
function toolList(labels: string[]): string {
  return `${labels.slice(0, 4).join(", ")}${labels.length > 4 ? ` and ${labels.length - 4} more` : ""}`;
}

function ToolCount({ count }: { count: number }) {
  return (
    <span className="text-muted-foreground text-sm tabular-nums">
      {count} {count === 1 ? "tool" : "tools"}
    </span>
  );
}

/**
 * Where an administrator decides which of the app's tools this Bot holds.
 *
 * A CHEVRON OF ITS OWN RATHER THAN THE WHOLE ROW. The row used to be the link, which was right while
 * it held nothing else; now it can hold Connect or Request access, and a button inside a link is two
 * controls answering one click. The destination is unchanged.
 */
function ManageLink({
  agentId,
  appKey,
  title,
}: {
  agentId: string;
  appKey: string;
  title: string;
}) {
  return (
    <Button
      aria-label={`Manage ${title} on this Bot`}
      render={
        <Link
          params={{ agentId, key: appKey }}
          to="/admin/plugins/$key/bots/$agentId"
        />
      }
      size="icon-sm"
      variant="ghost"
    >
      <IconChevronRight className="size-4 text-muted-foreground" />
    </Button>
  );
}

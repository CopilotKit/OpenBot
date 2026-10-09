import { IconApps, IconBox } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import { HandoffPanel } from "@/components/agents/handoff-panel";
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
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { setPluginGrantMutationOptions } from "@/lib/plugins/mutations";
import {
  agentPluginsQueryOptions,
  type GrantedPlugins,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";
import { readToolName } from "@/lib/plugins/tool-name";
import { queryClient } from "@/query-client";

/** "google-drive" as "Google Drive": the connector key, said the way a person would. */
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
      {/* The panel draws its own heading and count, and nothing at all when there is nothing to
          say to somebody who cannot change it. */}
      <PageSection>
        <HandoffPanel agentId={agent.id} />
      </PageSection>
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
      description="A skill this Bot carries is offered in its composer as /name."
      title="Your skills"
    >
      {grant.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {grant.error.message}
        </p>
      ) : null}
      {page.isPending ? null : page.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          Could not load your skills.
        </p>
      ) : skills.length === 0 ? (
        <PageEmpty>
          You have not written a skill yet.{" "}
          <Link className="underline underline-offset-4" to="/skills">
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
 * Everything this Bot holds, read from the same snapshot a run is offered. Read-only: apps are
 * granted by an administrator, who gets a link to where that is decided.
 */
function Granted({ agentId }: { agentId: string }) {
  const me = useQuery(currentUserQueryOptions()).data;
  const plugins = useQuery(agentPluginsQueryOptions(agentId));
  if (plugins.isPending) return null;
  if (!plugins.data) {
    return (
      <p className="mt-6 text-destructive text-sm" role="alert">
        What this Bot may reach could not be loaded.
      </p>
    );
  }
  const connectors = [...connectorTools(plugins.data).entries()];
  const skills = plugins.data.skills;
  return (
    <PageSection
      description="What this Bot may reach when it works. Anything not listed is refused when called."
      title="Granted"
    >
      {connectors.length === 0 && skills.length === 0 ? (
        <PageEmpty>
          Nothing granted yet. An administrator grants apps from the Plugins
          screens; until then this Bot can converse, and nothing more.
        </PageEmpty>
      ) : (
        <PageRows>
          {connectors.map(([key, labels], index) => (
            <Fragment key={key}>
              {index > 0 ? <Separator /> : null}
              <Item
                render={
                  me?.role === "admin" ? (
                    <Link
                      params={{ agentId, key }}
                      to="/admin/plugins/$key/bots/$agentId"
                    />
                  ) : undefined
                }
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconApps />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{connectorName(key)}</ItemTitle>
                  <ItemDescription>
                    {labels.slice(0, 4).join(", ")}
                    {labels.length > 4 ? ` and ${labels.length - 4} more` : ""}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-sm tabular-nums">
                    {labels.length} {labels.length === 1 ? "tool" : "tools"}
                  </span>
                </ItemActions>
              </Item>
            </Fragment>
          ))}
          {skills.map((skill, index) => (
            <Fragment key={skill.slug}>
              {connectors.length + index > 0 ? <Separator /> : null}
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

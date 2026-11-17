import {
  IconChevronRight,
  IconDeviceMobile,
  IconSitemap,
  IconUsersGroup,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
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
  countLabel,
  memorySummary,
  reachSummary,
  setupSummary,
  sharingSummary,
} from "@/lib/agents/bot-summaries";
import type { AgentProfile } from "@/lib/agents/queries";
import { approvalInboxOptions, ruleCoversBot } from "@/lib/approvals";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { isOrganizationAdmin } from "@/lib/auth/roles";
import { delegationSummary } from "@/lib/bot-agents/queries";
import { destinationsQueryOptions } from "@/lib/delivery";
import {
  deploymentCapabilitiesQueryOptions,
  useOffersMemory,
} from "@/lib/deployment/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { memorySourcesQueryOptions } from "@/lib/memory";
import { primitive, SETUP } from "@/lib/primitives";
import { proactiveSettingsQueryOptions } from "@/lib/proactive";
import { responsibilitiesQueryOptions } from "@/lib/responsibilities";
import { mergeRoutines } from "@/lib/routines/merged";
import { routinesQueryOptions } from "@/lib/routines/queries";
import { teamBotsQueryOptions } from "@/lib/team-bots";
import { connectorCount } from "./access";
import { useBotDelegation, useBotPlugins } from "./use-bot-reads";

/** The four groups the rows sit under, in the order they are drawn. */
export const SETTINGS_GROUPS = [
  "When it works",
  "What it knows",
  "What it uses",
  "This Bot",
] as const;

type Row = {
  group: (typeof SETTINGS_GROUPS)[number];
  to:
    | "/bots/$agentId/routines"
    | "/bots/$agentId/memory"
    | "/bots/$agentId/skills"
    | "/bots/$agentId/apps"
    | "/bots/$agentId/computer"
    | "/bots/$agentId/approvals"
    | "/bots/$agentId/setup"
    | "/bots/$agentId/agents"
    | "/bots/$agentId/sharing"
    | "/bots/$agentId/reach";
  title: string;
  icon: React.ComponentType;
  summary: string;
};

/**
 * The Bot's settings, in four groups (`SETTINGS_GROUPS`): when it works (Routines), what it knows
 * (Memory, Skills), what it uses (Apps, Computer, Approvals) and This Bot (Setup, Agents, then in the
 * team edition Sharing and Reaching you). Each row states its current answer and opens the page that
 * changes it; a group with no rows is not drawn.
 *
 * Both editions draw the same rows. A row shows only where it has something to set
 * (`docs/how-openbot-works.md`): Conversations and Activity are never rows, Memory only where
 * OpenBot offers it, and Computer only where this Bot has something of its own there (folders on
 * this computer inside OpenBot Desktop, its browser in the personal edition, or a computer of its
 * own for someone who may list computers).
 */
export function BotSettingsRows({ agent }: { agent: AgentProfile }) {
  const me = useQuery(currentUserQueryOptions()).data;
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const memory = useOffersMemory();
  const routines = useQuery(routinesQueryOptions());
  const goals = useQuery(responsibilitiesQueryOptions());
  const checkIns = useQuery(proactiveSettingsQueryOptions());
  const sources = useQuery({ ...memorySourcesQueryOptions(), enabled: memory });
  const plugins = useBotPlugins(agent.id);
  const approvals = useQuery(approvalInboxOptions());
  const teamBots = useQuery({ ...teamBotsQueryOptions(), enabled: !personal });
  const reach = useQuery({
    ...destinationsQueryOptions(),
    enabled: !personal,
  });
  const delegation = useBotDelegation(agent.id);
  const published = teamBots.data?.find((bot) => bot.botId === agent.id);
  const admin = isOrganizationAdmin(me?.role);
  // Its owner and admins change it there; anyone it is published to finds its link there.
  const canShare =
    !personal && (agent.mine || admin || published !== undefined);
  const desktop = desktopShell() !== null;
  const hasComputer = desktop || personal || (agent.isolated && admin);

  const row = (
    id: "routines" | "memory" | "skills" | "apps" | "computer" | "approvals",
    group: Row["group"],
    to: Row["to"],
    summary: string,
  ): Row => ({
    group,
    to,
    title: primitive(id).label,
    icon: primitive(id).icon,
    summary,
  });

  const rows: Row[] = [
    row(
      "routines",
      "When it works",
      "/bots/$agentId/routines",
      // Its routines, goals and check-ins, counted as the Routines list draws them.
      routines.data && goals.data && checkIns.data
        ? countLabel(
            mergeRoutines({
              routines: routines.data.routines,
              goals: goals.data,
              checkIns: checkIns.data,
              agentId: agent.id,
            }).length,
            "routine",
            "routines",
            "No routines",
          )
        : "",
    ),
    ...(memory
      ? [
          row(
            "memory",
            "What it knows",
            "/bots/$agentId/memory",
            sources.data
              ? memorySummary(
                  sources.data.filter((source) => source.botId === agent.id)
                    .length,
                )
              : "",
          ),
        ]
      : []),
    row(
      "skills",
      "What it knows",
      "/bots/$agentId/skills",
      plugins.data
        ? countLabel(plugins.data.skills.length, "skill", "skills", "No skills")
        : "",
    ),
    row(
      "apps",
      "What it uses",
      "/bots/$agentId/apps",
      plugins.data
        ? countLabel(connectorCount(plugins.data), "app", "apps", "No apps")
        : "",
    ),
    ...(hasComputer
      ? [
          row(
            "computer",
            "What it uses",
            "/bots/$agentId/computer",
            agent.isolated
              ? agent.isolationActive
                ? "A computer of its own"
                : "Shares a computer for now"
              : desktop
                ? "Folders on this computer, and its browser"
                : "Its browser on your computer",
          ),
        ]
      : []),
    row(
      "approvals",
      "What it uses",
      "/bots/$agentId/approvals",
      approvals.data
        ? countLabel(
            approvals.data.rules.filter(
              (rule) =>
                rule.botId !== "*" && ruleCoversBot(rule.botId, agent.id),
            ).length,
            "rule",
            "rules",
            "No rules",
          )
        : "",
    ),
    {
      group: "This Bot",
      to: "/bots/$agentId/setup",
      title: SETUP.label,
      icon: SETUP.icon,
      summary: setupSummary(agent, personal ? "personal" : "team"),
    },
    {
      group: "This Bot",
      to: "/bots/$agentId/agents",
      title: "Agents",
      icon: IconSitemap,
      summary: delegation.data ? delegationSummary(delegation.data) : "",
    },
    ...(canShare
      ? [
          {
            group: "This Bot" as const,
            to: "/bots/$agentId/sharing" as const,
            title: "Sharing",
            icon: IconUsersGroup,
            summary: teamBots.data
              ? sharingSummary(published, agent.visibility)
              : "",
          },
        ]
      : []),
    // Slack, Teams and text: the personal edition has none of them.
    ...(personal
      ? []
      : [
          {
            group: "This Bot" as const,
            to: "/bots/$agentId/reach" as const,
            title: "Reaching you",
            icon: IconDeviceMobile,
            summary: reach.data
              ? reachSummary(
                  reach.data
                    .filter((destination) => destination.botId === agent.id)
                    .map((destination) => destination.transport),
                )
              : "",
          },
        ]),
  ];

  return (
    <>
      {SETTINGS_GROUPS.map((group) => {
        const inGroup = rows.filter((row) => row.group === group);
        if (inGroup.length === 0) return null;
        return (
          <PageSection key={group} title={group}>
            <PageRows>
              {inGroup.map(({ to, title, icon: Icon, summary }, index) => (
                <Fragment key={to}>
                  {index > 0 ? <Separator /> : null}
                  <Item
                    render={<Link params={{ agentId: agent.id }} to={to} />}
                    size="sm"
                  >
                    <ItemMedia variant="icon">
                      <Icon />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{title}</ItemTitle>
                      <ItemDescription>{summary}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <IconChevronRight className="size-4 text-muted-foreground" />
                    </ItemActions>
                  </Item>
                </Fragment>
              ))}
            </PageRows>
          </PageSection>
        );
      })}
    </>
  );
}

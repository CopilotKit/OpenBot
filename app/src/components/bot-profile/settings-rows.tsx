import {
  IconBrain,
  IconChecks,
  IconChevronRight,
  IconDeviceMobile,
  IconTargetArrow,
  IconClock,
  IconPuzzle,
  IconSettings,
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
  accessSummary,
  countLabel,
  memorySummary,
  reachSummary,
  setupSummary,
  sharingSummary,
} from "@/lib/agents/bot-summaries";
import type { AgentProfile } from "@/lib/agents/queries";
import { approvalInboxOptions, ruleCoversBot } from "@/lib/approvals";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { deliveryQueryOptions } from "@/lib/delivery";
import { memorySourcesQueryOptions } from "@/lib/memory";
import { proactiveSettingsQueryOptions } from "@/lib/proactive";
import { responsibilitiesQueryOptions } from "@/lib/responsibilities";
import { agentPluginsQueryOptions } from "@/lib/plugins/queries";
import { routinesQueryOptions } from "@/lib/routines/queries";
import { teamBotsQueryOptions } from "@/lib/team-bots";
import { connectorCount } from "./access";

type Row = {
  to:
    | "/bots/$agentId/responsibilities"
    | "/bots/$agentId/reach"
    | "/bots/$agentId/memory"
    | "/bots/$agentId/approvals"
    | "/bots/$agentId/routines"
    | "/bots/$agentId/access"
    | "/bots/$agentId/sharing"
    | "/bots/$agentId/setup";
  title: string;
  icon: typeof IconClock;
  summary: string;
};

/**
 * One row per area of this Bot's configuration, each stating its current answer and opening the page
 * that changes it. Sharing is for its owner, administrators, and anyone it is published to.
 */
export function BotSettingsRows({ agent }: { agent: AgentProfile }) {
  const me = useQuery(currentUserQueryOptions()).data;
  const routines = useQuery(routinesQueryOptions());
  const plugins = useQuery(agentPluginsQueryOptions(agent.id));
  const teamBots = useQuery(teamBotsQueryOptions());
  const published = teamBots.data?.teamBots.find((bot) => bot.id === agent.id);
  // Its owner and administrators change it there; anyone it is published to finds its link there.
  const canShare =
    agent.mine || me?.role === "admin" || published !== undefined;

  const goals = useQuery(responsibilitiesQueryOptions());
  const reach = useQuery(deliveryQueryOptions());
  const sources = useQuery(memorySourcesQueryOptions());
  const research = useQuery(proactiveSettingsQueryOptions());
  const approvals = useQuery(approvalInboxOptions());

  const rows: Row[] = [
    {
      to: "/bots/$agentId/responsibilities",
      title: "Responsibilities",
      icon: IconTargetArrow,
      summary: goals.data
        ? countLabel(
            goals.data.filter(
              (goal) => goal.agentId === agent.id && goal.status === "active",
            ).length,
            "active",
            "active",
            "None active",
          )
        : "",
    },
    {
      to: "/bots/$agentId/reach",
      title: "Reaching you",
      icon: IconDeviceMobile,
      summary: reach.data
        ? reachSummary(
            reach.data.bindings
              .filter(
                (binding) => binding.enabled && binding.agentId === agent.id,
              )
              .map((binding) => binding.transport),
          )
        : "",
    },
    {
      to: "/bots/$agentId/memory",
      title: "Memory",
      icon: IconBrain,
      summary:
        sources.data && research.data
          ? memorySummary(
              sources.data.filter((source) => source.agentId === agent.id)
                .length,
              research.data.some(
                (setting) => setting.agentId === agent.id && setting.enabled,
              ),
            )
          : "",
    },
    {
      to: "/bots/$agentId/approvals",
      title: "Approval rules",
      icon: IconChecks,
      summary: approvals.data
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
    },
    {
      to: "/bots/$agentId/routines",
      title: "Routines",
      icon: IconClock,
      summary: routines.data
        ? countLabel(
            routines.data.routines.filter((row) => row.agentId === agent.id)
              .length,
            "routine",
            "routines",
            "No routines",
          )
        : "",
    },
    {
      to: "/bots/$agentId/access",
      title: "Skills and access",
      icon: IconPuzzle,
      summary: plugins.data
        ? accessSummary(
            plugins.data.skills.length,
            connectorCount(plugins.data),
          )
        : "",
    },
    ...(canShare
      ? [
          {
            to: "/bots/$agentId/sharing" as const,
            title: "Sharing",
            icon: IconUsersGroup,
            summary: teamBots.data
              ? sharingSummary(published, agent.visibility)
              : "",
          },
        ]
      : []),
    {
      to: "/bots/$agentId/setup",
      title: "Setup",
      icon: IconSettings,
      summary: setupSummary(agent),
    },
  ];

  return (
    <PageSection title="Settings for this Bot">
      <PageRows>
        {rows.map(({ to, title, icon: Icon, summary }, index) => (
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
}

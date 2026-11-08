import {
  IconBrain,
  IconChecks,
  IconChevronRight,
  IconClock,
  IconDeviceMobile,
  IconPuzzle,
  IconSettings,
  IconTargetArrow,
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
import {
  deploymentCapabilitiesQueryOptions,
  useOffersMemory,
} from "@/lib/deployment/queries";
import { memorySourcesQueryOptions } from "@/lib/memory";
import { agentPluginsQueryOptions } from "@/lib/plugins/queries";
import { proactiveSettingsQueryOptions } from "@/lib/proactive";
import { responsibilitiesQueryOptions } from "@/lib/responsibilities";
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
  // The personal edition has one person and nobody to share with.
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const memory = useOffersMemory();
  const canShare =
    !personal &&
    (agent.mine || me?.role === "admin" || published !== undefined);

  const goals = useQuery(responsibilitiesQueryOptions());
  const reach = useQuery(deliveryQueryOptions());
  const sources = useQuery({ ...memorySourcesQueryOptions(), enabled: memory });
  const research = useQuery(proactiveSettingsQueryOptions());
  const approvals = useQuery(approvalInboxOptions());

  const allRows: Row[] = [
    {
      to: "/bots/$agentId/responsibilities",
      title: "Goals",
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
    // Not where memory isn't offered: there this Bot's check-ins are on What it can do.
    ...(memory
      ? [
          {
            to: "/bots/$agentId/memory" as const,
            title: "Memory",
            icon: IconBrain,
            summary:
              sources.data && research.data
                ? memorySummary(
                    sources.data.filter((source) => source.agentId === agent.id)
                      .length,
                    research.data.some(
                      (setting) =>
                        setting.agentId === agent.id && setting.enabled,
                    ),
                  )
                : "",
          },
        ]
      : []),
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
      summary: setupSummary(agent, personal ? "personal" : "team"),
    },
  ];
  /*
   * THREE ROWS IN THE PERSONAL EDITION. Approval rules, Responsibilities and check-ins are sections
   * of the access page there, renamed What it can do, so one page answers what a Bot can do. Reaching
   * you is Slack, Teams and text, and Memory is what its local Intelligence isn't licensed for: the
   * personal edition has neither.
   */
  const rows = personal
    ? allRows.flatMap((row): Row[] =>
        row.to === "/bots/$agentId/access"
          ? [{ ...row, title: "What it can do" }]
          : row.to === "/bots/$agentId/responsibilities" ||
              row.to === "/bots/$agentId/reach" ||
              row.to === "/bots/$agentId/approvals"
            ? []
            : [row],
      )
    : allRows;

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

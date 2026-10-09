import {
  IconChevronRight,
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
  setupSummary,
  sharingSummary,
} from "@/lib/agents/bot-summaries";
import type { AgentProfile } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { agentPluginsQueryOptions } from "@/lib/plugins/queries";
import { routinesQueryOptions } from "@/lib/routines/queries";
import { teamBotsQueryOptions } from "@/lib/team-bots";
import { connectorCount } from "./access";

type Row = {
  to:
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
 * that changes it. Sharing is only for its owner and administrators.
 */
export function BotSettingsRows({ agent }: { agent: AgentProfile }) {
  const me = useQuery(currentUserQueryOptions()).data;
  const routines = useQuery(routinesQueryOptions());
  const plugins = useQuery(agentPluginsQueryOptions(agent.id));
  const canShare = agent.mine || me?.role === "admin";
  const teamBots = useQuery({ ...teamBotsQueryOptions(), enabled: canShare });

  const rows: Row[] = [
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
              ? sharingSummary(
                  teamBots.data.teamBots.find((bot) => bot.id === agent.id),
                )
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

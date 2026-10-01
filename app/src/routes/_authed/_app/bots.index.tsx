import { IconChevronRight } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  attentionSummary,
  needsInput,
} from "@/components/bot-profile/attention";
import { PageEmpty, PageRows, PageShell } from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { botAttentionQueryOptions } from "@/lib/bot-lifecycle/queries";

export const Route = createFileRoute("/_authed/_app/bots/")({
  component: BotsPage,
});

/** Every Bot the person can reach, with what each needs from them, each opening its profile. */
function BotsPage() {
  const agents = useQuery(agentListQueryOptions());
  const attention = useQuery(botAttentionQueryOptions());
  const byId = new Map((attention.data ?? []).map((bot) => [bot.agentId, bot]));
  return (
    <PageShell
      description="What each of your Bots is doing, what it needs from you, and whether it is paused."
      title="Bots"
    >
      {agents.isPending ? null : agents.error ? (
        <p className="mt-6 text-destructive text-sm" role="alert">
          Could not load your Bots.
        </p>
      ) : agents.data.length === 0 ? (
        <PageEmpty>You have no Bots yet.</PageEmpty>
      ) : (
        <PageRows className="mt-6">
          {agents.data.map((agent, index) => {
            const state = byId.get(agent.id);
            const summary = state
              ? [state.paused ? "Paused" : "", attentionSummary(state)]
                  .filter(Boolean)
                  .join(" · ")
              : "";
            return (
              <Fragment key={agent.id}>
                {index > 0 ? <Separator /> : null}
                <Item
                  render={
                    <Link params={{ agentId: agent.id }} to="/bots/$agentId" />
                  }
                  size="sm"
                >
                  <ItemMedia>
                    <AbstractAvatar
                      name={agent.name}
                      seed={agent.avatarSeed}
                      size={28}
                    />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{agent.name}</ItemTitle>
                    <ItemDescription>{summary || agent.title}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {state && needsInput(state) > 0 ? (
                      <span className="rounded-full bg-primary px-1.5 text-[11px] font-medium text-primary-foreground tabular-nums">
                        {needsInput(state)}
                      </span>
                    ) : null}
                    <IconChevronRight className="size-4 text-muted-foreground" />
                  </ItemActions>
                </Item>
              </Fragment>
            );
          })}
        </PageRows>
      )}
    </PageShell>
  );
}

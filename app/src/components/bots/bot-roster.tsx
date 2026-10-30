import {
  IconChevronRight,
  IconPlus,
  IconRobot,
  IconShare,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  attentionSummary,
  needsInput,
  waitingOnYou,
} from "@/components/bot-profile/attention";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import {
  DoneTasks,
  NeedsYouRows,
  useNeedsYou,
} from "@/components/needs-you/needs-you";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { groupRoster } from "@/lib/agents/roster";
import {
  type BotAttention,
  botAttentionQueryOptions,
} from "@/lib/bot-lifecycle/queries";

/**
 * Every Bot the person can reach, in the one place they are listed: what needs the person first,
 * then pinned, then their own, then the ones shared with them, and the ones they hid folded away at
 * the end.
 *
 * Needs you is where the sidebar's badge leads, so it holds everything behind that number in one
 * card: the Bots with a question, an approval or a stalled hand-off (answered on the Bot's page),
 * the tasks started from check-ins, and what every Bot's check-ins found, each row naming its Bot.
 *
 * This replaces three screens (Bots, Agents and Team Bots) that listed the same Bots three ways.
 */
export function BotRoster() {
  const agents = useQuery(agentListQueryOptions());
  const hidden = useQuery(agentListQueryOptions(true));
  const attention = useQuery(botAttentionQueryOptions());
  const list = useNeedsYou();
  const byId = new Map((attention.data ?? []).map((bot) => [bot.agentId, bot]));

  if (agents.isPending) return null;
  // Only when nothing ever loaded: a failed background refetch keeps the roster it had.
  if (agents.data === undefined) {
    return (
      <p className="mt-6 text-destructive text-sm" role="alert">
        Couldn't load your Bots. Reload the page.
      </p>
    );
  }
  const { needsYou, pinned, yours, shared } = groupRoster(
    agents.data,
    (agentId) => {
      const state = byId.get(agentId);
      return state ? needsInput(state) : 0;
    },
  );
  const yoursPinned = pinned.some((agent) => agent.mine);
  const yoursWaiting = needsYou.some((agent) => agent.mine);

  return (
    <>
      {needsYou.length || list.tasks.length || list.items.length ? (
        <PageSection title="Needs you">
          {list.error ? (
            <p className="mt-4 text-destructive text-sm" role="alert">
              {list.error.message}
            </p>
          ) : null}
          <NeedsYouRows
            items={list.items}
            lead={needsYou.map((agent) => (
              <RosterRow
                agent={agent}
                key={agent.id}
                state={byId.get(agent.id)}
              />
            ))}
            tasks={list.tasks}
          />
        </PageSection>
      ) : null}
      {pinned.length ? (
        <PageSection title="Pinned">
          <RosterRows agents={pinned} byId={byId} />
        </PageSection>
      ) : null}
      <PageSection title="Yours">
        {yours.length ? (
          <RosterRows agents={yours} byId={byId} />
        ) : (
          <PageEmpty
            action={
              yoursPinned || yoursWaiting ? undefined : (
                <Button
                  render={(props) => (
                    <Link {...props} search={{ new: true }} to="/bots" />
                  )}
                  size="sm"
                  variant="outline"
                >
                  <IconPlus />
                  New Bot
                </Button>
              )
            }
            icon={IconRobot}
            title={
              yoursPinned
                ? "All pinned"
                : yoursWaiting
                  ? "All waiting on you"
                  : "No Bots yet"
            }
          >
            {yoursPinned
              ? "Your Bots are all pinned above."
              : yoursWaiting
                ? "Your Bots are all under Needs you."
                : "Bots you create show up here."}
          </PageEmpty>
        )}
      </PageSection>
      <PageSection title="Shared with you">
        {shared.length ? (
          <RosterRows agents={shared} byId={byId} />
        ) : (
          <PageEmpty icon={IconShare} title="Nothing shared yet">
            Bots somebody shares with you show up here.
          </PageEmpty>
        )}
      </PageSection>
      <DoneTasks done={list.done} />
      {hidden.data?.length ? (
        <HiddenSection agents={hidden.data} byId={byId} />
      ) : null}
    </>
  );
}

/**
 * The Bots this person hid, folded until asked for: a way back for somebody who hid something, not
 * a fourth list everybody reads past. A Bot's page is where Unhide lives.
 */
function HiddenSection({
  agents,
  byId,
}: {
  agents: AgentProfile[];
  byId: Map<string, BotAttention>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <PageSection
      action={
        <Button onClick={() => setOpen(!open)} size="sm" variant="ghost">
          {open ? "Hide" : "Show"}
        </Button>
      }
      description={`${agents.length} ${agents.length === 1 ? "Bot" : "Bots"} you hid. Only your list changes.`}
      title="Hidden"
    >
      {open ? <RosterRows agents={agents} byId={byId} /> : null}
    </PageSection>
  );
}

function RosterRows({
  agents,
  byId,
}: {
  agents: AgentProfile[];
  byId: Map<string, BotAttention>;
}) {
  return (
    <PageRows>
      {agents.map((agent, index) => (
        <Fragment key={agent.id}>
          {index > 0 ? <Separator /> : null}
          <RosterRow agent={agent} state={byId.get(agent.id)} />
        </Fragment>
      ))}
    </PageRows>
  );
}

/**
 * One Bot, opening its page. The count is everything from it that waits on the person, its
 * check-in items and tasks included, so a Bot whose items are listed under Needs you still says so
 * wherever it sits.
 */
function RosterRow({
  agent,
  state,
}: {
  agent: AgentProfile;
  state: BotAttention | undefined;
}) {
  const summary = state
    ? [state.paused ? "Paused" : "", attentionSummary(state)]
        .filter(Boolean)
        .join(" · ")
    : "";
  const waiting = state ? waitingOnYou(state) : 0;
  return (
    <Item
      render={<Link params={{ agentId: agent.id }} to="/bots/$agentId" />}
      size="sm"
    >
      <ItemMedia>
        <AbstractAvatar name={agent.name} seed={agent.avatarSeed} size={28} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{agent.name}</ItemTitle>
        <ItemDescription>{summary || agent.title}</ItemDescription>
      </ItemContent>
      <ItemActions>
        {waiting > 0 ? (
          <span className="rounded-full bg-primary px-1.5 text-[11px] font-medium text-primary-foreground tabular-nums">
            {waiting}
          </span>
        ) : null}
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}

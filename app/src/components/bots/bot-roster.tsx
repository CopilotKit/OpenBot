import { IconBolt, IconChevronRight, IconPlus } from "@/components/icons";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { AgentCard } from "@/components/agents/agent-card";
import {
  attentionSummary,
  useStoppedTasks,
  waitingOnYou,
} from "@/components/bot-profile/attention";
import { LoadingRows } from "@/components/layout/loading-rows";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { NeedsYouBoard } from "@/components/needs-you/board";
import { DoneTasks, useNeedsYou } from "@/components/needs-you/needs-you";
import { Badge } from "@/components/ui/badge";
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
import { shownSubtitle } from "@/lib/agents/subtitle";
import {
  type BotAttention,
  botAttentionQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { cn } from "@/lib/utils";
import { useKit } from "@/skins/store";

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
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const agents = useQuery(agentListQueryOptions());
  const hidden = useQuery(agentListQueryOptions(true));
  const attention = useQuery(botAttentionQueryOptions());
  const list = useNeedsYou();
  const byId = new Map((attention.data ?? []).map((bot) => [bot.botId, bot]));

  if (agents.isPending)
    return (
      <PageSection>
        <LoadingRows label="Loading your Bots" media="avatar" />
      </PageSection>
    );
  // Only when nothing ever loaded: a failed background refetch keeps the roster it had.
  if (agents.data === undefined) {
    return (
      <p className="mt-6 text-destructive text-sm" role="alert">
        Couldn't load your Bots. Try again in a moment.
      </p>
    );
  }
  // Every Bot stays in its own section; what it waits on is on the board above, by name.
  const { pinned, yours, shared } = groupRoster(agents.data);
  const available = pinned.length + yours.length + shared.length;
  const hiddenCount = hidden.data?.length ?? 0;
  const newBot = (
    <Button
      render={(props) => <Link {...props} search={{ new: true }} to="/bots" />}
      size="sm"
      variant="outline"
    >
      <IconPlus />
      New Bot
    </Button>
  );

  return (
    <>
      {/*
       * What waits on the person, each thing under the Bot it came from and decided where it is.
       * A Bot waiting on them stays in its own section below too, with its badge.
       */}
      <NeedsYouBoard />
      {/*
       * AVAILABLE BOTS FIRST, AND ONLY SECTIONS WITH BOTS IN THEM. An empty Yours used to sit above
       * the assistant OpenBot includes, so the first thing a new person read was "No Bots yet" over
       * a Bot they could talk to. The way to make one is a sentence after them instead, beside the
       * page's own New Bot.
       */}
      {pinned.length ? (
        <PageSection title="Pinned">
          <RosterList agents={pinned} byId={byId} />
        </PageSection>
      ) : null}
      {yours.length ? (
        <PageSection title="Yours">
          <RosterList agents={yours} byId={byId} />
        </PageSection>
      ) : null}
      {shared.length ? (
        <PageSection
          title={personal ? "Included with OpenBot" : "Shared with you"}
        >
          <RosterList agents={shared} byId={byId} />
        </PageSection>
      ) : null}
      {available === 0 ? (
        // Waits for the hidden list, so it never says "No Bots yet" to someone who hid theirs.
        hidden.isPending ? null : (
          <PageSection>
            <PageEmpty
              action={newBot}
              icon={IconBolt}
              title={hiddenCount ? "No Bots on your list" : "No Bots yet"}
            >
              {hiddenCount
                ? "The Bots you hid are below. Create a Bot for a specific job."
                : "Create a Bot for a specific job."}
            </PageEmpty>
          </PageSection>
        )
      ) : yours.length === 0 ? (
        <p className="mt-12 text-muted-foreground text-sm">
          Create a Bot for a specific job.{" "}
          <Link
            className="font-medium text-foreground underline underline-offset-4"
            search={{ new: true }}
            to="/bots"
          >
            New Bot
          </Link>
        </p>
      ) : null}
      <DoneTasks done={list.done} />
      {hidden.data?.length ? (
        <HiddenSection agents={hidden.data} byId={byId} personal={personal} />
      ) : null}
    </>
  );
}

/**
 * The Bots this person hid, folded until asked for: a way back for somebody who hid something, not
 * a fourth list everybody reads past. A Bot's page is where Unhide lives. The personal edition has
 * nobody else with a list, so it doesn't say only theirs changed.
 */
function HiddenSection({
  agents,
  byId,
  personal,
}: {
  agents: AgentProfile[];
  byId: Map<string, BotAttention>;
  personal: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <PageSection
      action={
        // Short on screen; to a screen reader it says which list it opens, beside Done's own Show.
        <Button
          aria-expanded={open}
          aria-label={open ? "Hide hidden Bots" : "Show hidden Bots"}
          onClick={() => setOpen(!open)}
          size="sm"
          variant="ghost"
        >
          {open ? "Hide" : "Show"}
        </Button>
      }
      description={`${agents.length} ${agents.length === 1 ? "Bot" : "Bots"} you hid.${personal ? "" : " Only your list changes."}`}
      title="Hidden"
    >
      {open ? <RosterList agents={agents} byId={byId} /> : null}
    </PageSection>
  );
}

/**
 * A section's Bots: Figma's Bot Cards in the current kit ("bots" on Master screens), the rows the
 * legacy kit's skins were drawn with in that kit (skins/kit.ts).
 */
function RosterList({
  agents,
  byId,
}: {
  agents: AgentProfile[];
  byId: Map<string, BotAttention>;
}) {
  const currentKit = useKit() === "current";
  return currentKit ? (
    <BotCards agents={agents} byId={byId} />
  ) : (
    <RosterRows agents={agents} byId={byId} />
  );
}

/**
 * What a Bot's row or card says under its name, and how many things from it wait on the person.
 * The count is everything from it that waits on them, its check-in items and tasks included, so a
 * Bot whose items are listed under Needs you still says so wherever it sits.
 */
function useRosterState(
  agent: AgentProfile,
  state: BotAttention | undefined,
): { summary: string; waiting: number } {
  const stopped = useStoppedTasks();
  if (!state) return { summary: "", waiting: 0 };
  return {
    summary: [
      state.paused ? "Paused" : "",
      attentionSummary(state, stopped(agent.id)),
    ]
      .filter(Boolean)
      .join(" · "),
    waiting: waitingOnYou(state),
  };
}

/**
 * Each Bot a white card with its orb, its name and two lines, two to a row 2px apart, opening its
 * page. A section of one Bot is one card across the column, as Figma draws Included with OpenBot.
 * What a Bot waits on replaces what it is for, with the count at the card's end.
 */
function BotCards({
  agents,
  byId,
}: {
  agents: AgentProfile[];
  byId: Map<string, BotAttention>;
}) {
  return (
    <ul
      className={cn(
        "mt-3 grid grid-cols-1 gap-0.5",
        agents.length > 1 && "sm:grid-cols-2",
      )}
    >
      {agents.map((agent) => (
        <li className="min-w-0" key={agent.id}>
          <BotCard agent={agent} state={byId.get(agent.id)} />
        </li>
      ))}
    </ul>
  );
}

function BotCard({
  agent,
  state,
}: {
  agent: AgentProfile;
  state: BotAttention | undefined;
}) {
  const { summary, waiting } = useRosterState(agent, state);
  return (
    <Link
      className="block rounded-card"
      params={{ agentId: agent.id }}
      to="/bots/$agentId"
    >
      <AgentCard
        agent={agent}
        appearance="row"
        description={summary}
        trailing={
          waiting > 0 ? <Badge variant="count">{waiting}</Badge> : undefined
        }
      />
    </Link>
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

/** One Bot, opening its page, with what `useRosterState` says of it. */
function RosterRow({
  agent,
  state,
}: {
  agent: AgentProfile;
  state: BotAttention | undefined;
}) {
  const { summary, waiting } = useRosterState(agent, state);
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
        <ItemDescription>
          {summary || shownSubtitle(agent.title)}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {waiting > 0 ? <Badge variant="count">{waiting}</Badge> : null}
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}

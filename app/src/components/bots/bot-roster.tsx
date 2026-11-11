import { IconBolt, IconChevronRight, IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { LoadingRows } from "@/components/layout/loading-rows";
import {
  attentionSummary,
  waitingOnYou,
} from "@/components/bot-profile/attention";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { NeedsYouBoard } from "@/components/needs-you/board";
import { DoneTasks, useNeedsYou } from "@/components/needs-you/needs-you";
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
  const byId = new Map((attention.data ?? []).map((bot) => [bot.agentId, bot]));

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
        Couldn't load your Bots. Reload the page.
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
          <RosterRows agents={pinned} byId={byId} />
        </PageSection>
      ) : null}
      {yours.length ? (
        <PageSection title="Yours">
          <RosterRows agents={yours} byId={byId} />
        </PageSection>
      ) : null}
      {shared.length ? (
        <PageSection
          title={personal ? "Included with OpenBot" : "Shared with you"}
        >
          <RosterRows agents={shared} byId={byId} />
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
        <Button onClick={() => setOpen(!open)} size="sm" variant="ghost">
          {open ? "Hide" : "Show"}
        </Button>
      }
      description={`${agents.length} ${agents.length === 1 ? "Bot" : "Bots"} you hid.${personal ? "" : " Only your list changes."}`}
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
        <ItemDescription>
          {summary || shownSubtitle(agent.title)}
        </ItemDescription>
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

import { defaultAgentProfile } from "@/lib/agents/default-agent";
import type { AgentProfile } from "@/lib/agents/queries";
import type { ApprovalInboxData } from "@/lib/approvals";
import type { BotAttention } from "@/lib/bot-lifecycle/queries";
import type { ChannelSummary } from "@/lib/channels/queries";

/*
 * The rules OpenMuse's frame runs on, kept apart from the components so each one is a plain function
 * of OpenBot's own data. None of them decides anything the server already decided: they only choose
 * which of OpenBot's records to put where.
 */

export type MuseTab = "chat" | "activity" | "ideas" | "goals" | "apps";

/**
 * The Bot at the centre of the frame.
 *
 * OpenMuse is one agent. OpenBot has many, so the centre follows, in order: the Bot of the
 * conversation on screen, the Bot the person last chose, and OpenBot's own default Bot — the same
 * `defaultAgentProfile` the home screen and `/bot` fall back to.
 */
export function centreBot(
  agents: readonly AgentProfile[] | undefined,
  chosenId: string | null,
  conversationBotId: string | undefined,
): AgentProfile | undefined {
  if (!agents?.length) return undefined;
  return (
    agents.find((agent) => agent.id === conversationBotId) ??
    agents.find((agent) => agent.id === chosenId) ??
    defaultAgentProfile(agents)
  );
}

/**
 * A Bot's main chat: its one-to-one conversation the roster already lists first.
 *
 * The roster arrives pinned first and newest first, so the first one-to-one channel with this Bot is
 * the one the person is most likely to mean. A group is never a Bot's main chat.
 */
export function mainChannel(
  agentId: string | undefined,
  channels: readonly ChannelSummary[] | undefined,
): ChannelSummary | undefined {
  if (!agentId) return undefined;
  return channels?.find(
    (channel) =>
      channel.active !== false &&
      channel.agentIds.length === 1 &&
      channel.agentIds[0] === agentId,
  );
}

/**
 * The tab whose own screen this path is, or null on any other OpenBot page. Chat is the conversation
 * routes; Apps is OpenBot's Connections, the apps a Bot uses as you. A Bot's page, Routines,
 * Capabilities and the rest light no tab, because they are not that tab's screen.
 */
export function tabFor(pathname: string): MuseTab | null {
  if (pathname === "/s/activity") return "activity";
  if (pathname === "/s/ideas") return "ideas";
  if (pathname === "/s/goals") return "goals";
  if (pathname === "/connections" || pathname.startsWith("/connections/")) {
    return "apps";
  }
  if (
    pathname === "/" ||
    pathname === "/channel" ||
    pathname.startsWith("/channel/") ||
    pathname.startsWith("/group/")
  ) {
    return "chat";
  }
  return null;
}

/**
 * Whether the page stays in OpenMuse's 760px column on a wide screen. A tab's own screen does. Every
 * other OpenBot page, and a conversation with its Bot's computer or settings open beside it, gets
 * OpenBot's own width, so its wide layouts and side panels have the room they were built for.
 */
export function inColumn(pathname: string, sidePanelOpen: boolean): boolean {
  return tabFor(pathname) !== null && !sidePanelOpen;
}

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The line under the Bot's name: what it is doing right now, in OpenMuse's own words.
 *
 * Something waiting on the person outranks work in progress, because it is the one thing on this
 * line they can act on. Work comes from the roster the channel socket keeps live, so the line
 * changes while a turn runs without anybody refreshing.
 */
export function statusLine(input: {
  attention: BotAttention | undefined;
  channels: readonly ChannelSummary[] | undefined;
  agentId: string | undefined;
}): string {
  const { attention, channels, agentId } = input;
  if (attention?.approvals) {
    return `Ready to review · ${plural(attention.approvals, "approval")}`;
  }
  if (attention?.questions) {
    return `Needs your input · ${plural(attention.questions, "question")}`;
  }
  if (attention?.handoffs) return "Waiting on a hand-off";
  const working = agentId
    ? channels?.find(
        (channel) =>
          channel.agentIds.includes(agentId) &&
          (channel.busy || (channel.work?.length ?? 0) > 0),
      )
    : undefined;
  if (working) {
    const routine = working.work?.find((work) => work.kind === "routine");
    if (routine && !working.busy) return "Running a routine…";
    return `Working on ${working.summary?.trim() || working.name}…`;
  }
  if (attention?.paused) return "Paused";
  return "Ready when you are";
}

/** Approvals and questions the person has not answered yet, across every Bot. */
export function waitingOnYou(inbox: ApprovalInboxData | undefined) {
  const requests = (inbox?.requests ?? []).filter(
    (request) => request.status === "pending",
  );
  const questions = inbox?.questions ?? [];
  return { requests, questions, count: requests.length + questions.length };
}

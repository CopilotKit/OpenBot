import { IconSettings } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useRef, useState } from "react";
import { z } from "zod";
import { AgentProfile } from "@/components/agents/agent-profile";
import { BotPausedBanner } from "@/components/bot-profile/pause-banner";
import { ChannelAvatar } from "@/components/channels/avatar";
import { ChannelChat } from "@/components/channels/channel-chat";
import { ConversationActions } from "@/components/channels/conversation-actions";
import {
  ConversationOrb,
  ConversationPresenceProvider,
  ConversationStatusLine,
} from "@/components/channels/conversation-presence";
import {
  ComputerChatControls,
  ComputerControlButton,
} from "@/components/computer/computer-controls";
import {
  ComputerPaneTitle,
  ComputerViewPanel,
} from "@/components/computer/computer-panel";
import type { ComputerViewHandle } from "@/components/computer/computer-view";
import { useAutoWatchScreen } from "@/components/computer/use-auto-watch-screen";
import { DetailPanel } from "@/components/layout/detail-panel";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { Button } from "@/components/ui/button";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import { type AgentChannel, channelQueryOptions } from "@/lib/channels/queries";

const chatSearchSchema = z.object({
  settings: z.boolean().optional(),
  /** Opens the Bot's screen in the shared detail pane. */
  watch: z.boolean().optional(),
});

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

const HEADING_ENTRANCE_SECONDS = 0.18;
const HEADING_ENTRANCE_OFFSET = "translateY(4px)";

/** The live screen's pane: wide enough for a readable screen and the steps under it. */
const SCREEN_PANEL_WIDTH = 440;

/** A conversation's Bot in its header: 40px, the smallest orb that is fully animated. */
const HEADER_ORB_SIZE = 40;

export const Route = createFileRoute("/_authed/_app/channel/$channelId")({
  validateSearch: chatSearchSchema,
  component: RouteComponent,
});

/**
 * The conversation's presence wraps everything on the route, so its header and the pane beside it
 * read the same conversation; `ChannelChat` reports into it.
 */
function RouteComponent() {
  const { channelId } = Route.useParams();
  const channel = useQuery(channelQueryOptions(channelId));
  return (
    <ConversationPresenceProvider
      channelId={channelId}
      threadId={channel.data?.threadId}
    >
      <Conversation />
    </ConversationPresenceProvider>
  );
}

function Conversation() {
  const { channelId } = Route.useParams();
  const { settings, watch } = Route.useSearch();
  const channel = useQuery(channelQueryOptions(channelId));
  const navigate = Route.useNavigate();
  const isSettingsOpen = settings === true;
  const prefersReducedMotion = useReducedMotion();
  const isWatching = watch === true;
  /** Channel routing currently supports one coworker. */
  const agentId = channel.data?.agentIds[0];
  /*
   * The Bot's own name, for its computer. The conversation's name is what the conversation is about,
   * and a screen badged "Q3 budget" says nothing about whose computer it is.
   */
  const botName = useQuery(agentListQueryOptions()).data?.find(
    (agent) => agent.id === agentId,
  )?.name;
  /** Whether the pane would be a sheet over the conversation, as `DetailPanel` last measured. */
  const [overlaying, setOverlaying] = useState(true);
  /** The screen in the pane, which the header's Take control opens full size. */
  const screen = useRef<ComputerViewHandle>(null);
  /*
   * A group is on its way to its own route (`ChannelBody`) and keeps its small faces until then.
   * Anything else, a conversation still loading included, has room for one Bot's orb, so the header
   * does not grow once the conversation arrives.
   */
  const group =
    channel.data !== undefined && channel.data.agentIds.length !== 1;

  useMarkOpenChannelRead(channelId);

  /*
   * Browser activity may auto-open the screen once per run unless this run was dismissed, and only
   * where it opens beside the conversation. On a narrow screen it lights the computer button.
   */
  const autoWatch = useAutoWatchScreen({
    botId: agentId,
    watching: isWatching,
    busy: isSettingsOpen,
    docked: !overlaying,
    open: () =>
      navigate({
        search: (previous) => ({
          ...previous,
          settings: undefined,
          watch: true,
        }),
      }),
    close: () =>
      navigate({ search: (previous) => ({ ...previous, watch: undefined }) }),
  });

  // Settings and watch share one pane; opening either clears the other URL flag.
  const show = (next: "settings" | "watch" | null) => {
    // Dismissal applies only to the current browser-activity run.
    if (next !== "watch" && isWatching) autoWatch.dismiss();
    return navigate({
      search: (previous) => ({
        ...previous,
        settings: next === "settings" ? true : undefined,
        watch: next === "watch" ? true : undefined,
      }),
    });
  };

  return (
    <DetailPanel
      onClose={() => show(null)}
      open={(isSettingsOpen || isWatching) && agentId !== undefined}
      /*
       * The screen's width unless the Bot's settings are open, closed included, so whether it would
       * overlay is measured for the pane that opens by itself.
       */
      detailWidth={isSettingsOpen ? undefined : SCREEN_PANEL_WIDTH}
      onOverlayChange={setOverlaying}
      title={
        isWatching && agentId !== undefined ? (
          <ComputerPaneTitle agentId={agentId} name={botName} />
        ) : undefined
      }
      actions={
        isWatching && agentId !== undefined ? (
          <ComputerControlButton
            computerId={agentId}
            inline
            onTakeControl={() => screen.current?.openFullSize()}
          />
        ) : undefined
      }
      detail={
        agentId === undefined ? null : isWatching ? (
          // Manual watch remains active even when there is no current browser action.
          <ComputerViewPanel
            agentId={agentId}
            name={botName}
            screen={screen}
            wheelInHeader
          />
        ) : (
          <AgentProfile
            agentId={agentId}
            footer={
              channel.data ? (
                <ConversationActions
                  channelId={channelId}
                  leave={() => navigate({ to: "/" })}
                  name={channel.data.name}
                />
              ) : null
            }
          />
        )
      }
    >
      <div className="flex flex-col">
        <div
          className="min-h-12 border-b border-border sticky top-0 flex flex-row flex-wrap items-center justify-between px-3 py-2 gap-2"
          data-slot="conversation-header"
        >
          {/* Keyed on the displayed name so cold channel loads animate the resolved name, not the id. */}
          <div className="flex min-w-0 items-center gap-1.5">
            <SidebarToggle />
            <motion.div
              animate={{ opacity: 1 }}
              className="shrink-0"
              initial={{ opacity: 0 }}
              key={`avatar:${channel.data?.name ?? channelId}`}
              transition={{
                duration: HEADING_ENTRANCE_SECONDS,
                ease: EASE_OUT,
              }}
            >
              {group ? (
                <ChannelAvatar
                  participantIds={channel.data?.agentIds ?? []}
                  size={22}
                />
              ) : (
                <ConversationOrb
                  participantIds={channel.data?.agentIds ?? []}
                  size={HEADER_ORB_SIZE}
                />
              )}
            </motion.div>
            {/* The name, and under it what the Bot is doing. At rest the name sits level with the orb. */}
            <div className="flex min-w-0 flex-col pl-1">
              <motion.span
                animate={
                  prefersReducedMotion
                    ? { opacity: 1 }
                    : { opacity: 1, transform: "translateY(0px)" }
                }
                className="min-w-0 type-sub font-medium truncate"
                initial={
                  prefersReducedMotion
                    ? { opacity: 0 }
                    : { opacity: 0, transform: HEADING_ENTRANCE_OFFSET }
                }
                key={`name:${channel.data?.name ?? channelId}`}
                transition={{
                  duration: HEADING_ENTRANCE_SECONDS,
                  ease: EASE_OUT,
                }}
              >
                {channel.data?.name ?? "Channel"}
              </motion.span>
              {group ? null : <ConversationStatusLine />}
            </div>
          </div>
          <div className="flex flex-row gap-1.5">
            <ComputerChatControls
              computerId={agentId}
              open={isWatching}
              onOpenChange={(open) => show(open ? "watch" : null)}
              unseen={autoWatch.unseen}
            />
            <Button
              aria-label="This conversation's Bot"
              aria-pressed={isSettingsOpen}
              className={isSettingsOpen ? "bg-foreground/5" : undefined}
              disabled={agentId === undefined}
              onClick={() => show(isSettingsOpen ? null : "settings")}
              variant="ghost"
              size="icon"
            >
              <IconSettings className="size-4.5" />
            </Button>
          </div>
        </div>
      </div>
      {agentId && channel.data?.agentIds.length === 1 ? (
        <BotPausedBanner agentId={agentId} />
      ) : null}
      <ChannelBody
        channel={channel.data}
        isPending={channel.isPending}
        hasError={Boolean(channel.error)}
      />
    </DetailPanel>
  );
}

/**
 * A channel with exactly one coworker is its CopilotKit chat. One with several is a group, which
 * redirects to its shared transcript at `/group/$channelId`.
 */
function ChannelBody({
  channel,
  isPending,
  hasError,
}: {
  channel: AgentChannel | undefined;
  isPending: boolean;
  hasError: boolean;
}) {
  // Nothing while the channel loads: a placeholder inside a local round-trip is a flicker.
  if (isPending) return null;
  if (hasError || !channel) {
    return (
      <p className="p-8 text-sm text-destructive" role="alert">
        Couldn't load this conversation. Reload the page.
      </p>
    );
  }

  const runtimeAgentId =
    channel.agentIds.length === 1 ? channel.agentIds[0] : undefined;
  // Two or more Bots is a group conversation, with its own shared transcript. Every link to a
  // channel lands here, so this is the one redirect they all need.
  if (!runtimeAgentId) {
    return (
      <Navigate
        params={{ channelId: channel.id }}
        replace
        to="/group/$channelId"
      />
    );
  }

  // Remount on channel changes so CopilotKit agent/thread state cannot leak between channels.
  return (
    <ChannelChat
      channel={channel}
      key={channel.id}
      runtimeAgentId={runtimeAgentId}
    />
  );
}

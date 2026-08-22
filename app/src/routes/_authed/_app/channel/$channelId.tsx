import { IconDeviceDesktop, IconSettings } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import { AgentProfile } from "@/components/agents/agent-profile";
import { ChannelAvatar } from "@/components/channels/avatar";
import { ChannelChat } from "@/components/channels/channel-chat";
import { ActivityLog } from "@/components/computer/activity-log";
import { ComputerView } from "@/components/computer/computer-view";
import { useNeedsYou } from "@/components/computer/needs-you";
import { DetailPanel } from "@/components/layout/detail-panel";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { type AgentChannel, channelQueryOptions } from "@/lib/channels/queries";
import {
  activityFor,
  hasBrowsed,
  subscribeToActivity,
} from "@/lib/computers/activity";
import { onComputerActivity } from "@/lib/copilot/computer-activity";

const chatSearchSchema = z.object({
  settings: z.boolean().optional(),
  /** Opens the Bot's screen in the shared detail pane. */
  watch: z.boolean().optional(),
});

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

const HEADING_ENTRANCE_SECONDS = 0.18;
const HEADING_ENTRANCE_OFFSET = "translateY(4px)";

/** Shared detail pane width for the live screen view. */
const SCREEN_PANEL_WIDTH = 400;

export const Route = createFileRoute("/_authed/_app/channel/$channelId")({
  validateSearch: chatSearchSchema,
  component: RouteComponent,
});

/**
 * What the Bot is looking at, and what it is doing.
 *
 * Two surfaces rather than one. The screen was the only window into a Bot's computer, so a Bot that
 * spent two minutes in a terminal showed a blank browser and nothing else: the honest answer to
 * "what is it doing" was "something, on a machine holding your logins". The second tab is the shell
 * and the workspace, and it fills up while the screen sits still.
 *
 * The screen stays the default, because most work is browsing and it is the surface somebody has to
 * take the wheel on. The count on the other tab is what says the Bot is busy somewhere else.
 */
function ComputerViewPanel({
  agentId,
  name,
}: {
  agentId: string;
  name?: string;
}) {
  const activity = useSyncExternalStore(
    subscribeToActivity,
    () => activityFor(agentId),
    () => activityFor(agentId),
  );
  const browsed = useSyncExternalStore(
    subscribeToActivity,
    () => hasBrowsed(agentId),
    () => hasBrowsed(agentId),
  );

  /*
   * Which surface opens, decided by what the Bot is actually doing.
   *
   * The screen belongs to the computer rather than to the conversation: Bots share one and the
   * profile keeps whatever page was open last. A Bot that spends a whole conversation in a terminal
   * therefore has a screen showing somebody else's page from an hour ago, and defaulting to it
   * captions that as what this Bot is doing now.
   *
   * So the screen is the default until there is a reason to think otherwise, and work away from the
   * browser with no page opened is that reason. Once somebody picks a tab, their choice stands.
   */
  const [chosen, setChosen] = useState<"screen" | "activity" | null>(null);
  const showing =
    chosen ?? (!browsed && activity.length > 0 ? "activity" : "screen");

  return (
    <div className="mt-4 px-4">
      <div className="p-4">
        <div className="mb-3 flex gap-2">
          <Button
            onClick={() => setChosen("screen")}
            size="sm"
            variant={showing === "screen" ? "default" : "outline"}
          >
            Screen
          </Button>
          <Button
            onClick={() => setChosen("activity")}
            size="sm"
            variant={showing === "activity" ? "default" : "outline"}
          >
            Activity
            {activity.length > 0 ? (
              <span className="ml-1.5 tabular-nums opacity-70">
                {activity.length}
              </span>
            ) : null}
          </Button>
        </div>

        {/*
          Both mounted, one hidden. Unmounting the screen would drop its socket and its polling, so
          looking at the terminal for a moment would cost the live view and the take-the-wheel prompt
          that rides on it.
        */}
        <div className={showing === "screen" ? undefined : "hidden"}>
          <ComputerView active computerId={agentId} />
          {/*
            The caption says whose page this is, and it is only this Bot's once it has opened one.
            Before that the browser still shows whatever was last open on the shared computer, and
            calling that "General Assistant's screen" states something untrue with confidence.
          */}
          <span className="mt-4 flex w-full items-center justify-center text-balance px-4 text-center text-muted-foreground text-sm">
            {browsed
              ? `${name || "Agent"}'s screen`
              : `${name || "Agent"} has not opened a page in this conversation. This is whatever its computer had open last.`}
          </span>
        </div>

        <div className={showing === "activity" ? undefined : "hidden"}>
          <ActivityLog computerId={agentId} />
        </div>
      </div>
    </div>
  );
}

function RouteComponent() {
  const { channelId } = Route.useParams();
  const { settings, watch } = Route.useSearch();
  const channel = useQuery(channelQueryOptions(channelId));
  const navigate = Route.useNavigate();
  const isSettingsOpen = settings === true;
  const prefersReducedMotion = useReducedMotion();
  const isWatching = watch === true;
  /** Channel routing currently supports one coworker. */
  const agentId = channel.data?.agentIds[0];
  /** Needs-you state is rendered by the screen when the screen is already open. */
  const needsYou = useNeedsYou(agentId, !isWatching);

  // Needs-you prompts auto-open the screen because the actionable prompt is rendered there.
  useEffect(() => {
    if (!needsYou) return;
    show("watch");
  });

  // Browser activity may auto-open the screen once per run unless this run was dismissed.
  const dismissedEpoch = useRef<number | null>(null);
  const runEpoch = useRef<number | null>(null);
  useEffect(() => {
    if (!agentId) return;
    return onComputerActivity((activity) => {
      if (activity.botId !== agentId) return;
      runEpoch.current = activity.epoch;
      if (dismissedEpoch.current === activity.epoch) return;
      navigate({
        search: (previous) =>
          previous.watch === true || previous.settings === true
            ? previous
            : { ...previous, settings: undefined, watch: true },
      });
    });
  }, [agentId, navigate]);

  // Settings and watch share one pane; opening either clears the other URL flag.
  const show = (next: "settings" | "watch" | null) => {
    // Dismissal applies only to the current browser-activity run.
    if (next !== "watch" && isWatching)
      dismissedEpoch.current = runEpoch.current;
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
      detailWidth={isWatching ? SCREEN_PANEL_WIDTH : undefined}
      detail={
        agentId === undefined ? null : isWatching ? (
          // Manual watch remains active even when there is no current browser action.
          <ComputerViewPanel agentId={agentId} name={channel?.data?.name} />
        ) : (
          <AgentProfile agentId={agentId} />
        )
      }
    >
      <div className="flex flex-col">
        <div className="h-12 border-b border-border sticky top-0 flex flex-row items-center justify-between px-3 gap-2">
          {/* Keyed on the displayed name so cold channel loads animate the resolved name, not the id. */}
          <div className="flex min-w-0 items-center gap-1.5">
            <SidebarTrigger className="md:hidden shrink-0" />
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
              <ChannelAvatar
                participantIds={channel.data?.agentIds ?? []}
                size={22}
              />
            </motion.div>
            <motion.span
              animate={
                prefersReducedMotion
                  ? { opacity: 1 }
                  : { opacity: 1, transform: "translateY(0px)" }
              }
              className="min-w-0 text-sm tracking-tight truncate"
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
          </div>
          <div className="flex flex-row gap-1.5">
            <Button
              aria-label={
                needsYou
                  ? "This Bot is waiting for you. Open its screen"
                  : "Watch this Bot's screen"
              }
              aria-pressed={isWatching}
              className={`relative ${isWatching ? "bg-foreground/5" : ""}`}
              disabled={agentId === undefined}
              onClick={() => show(isWatching ? null : "watch")}
              variant="ghost"
              size="icon"
            >
              <IconDeviceDesktop className="size-4.5" />
              {/* Mirrors needs-you state outside the hidden screen pane. */}
              {needsYou ? (
                <span className="absolute right-1 top-1 size-2 rounded-full bg-amber-500" />
              ) : null}
            </Button>
            <Button
              aria-label="Channel coworker"
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
      <ChannelBody
        channel={channel.data}
        isPending={channel.isPending}
        hasError={Boolean(channel.error)}
      />
    </DetailPanel>
  );
}

/**
 * A channel holds exactly one coworker. More than one is not supported yet, and rendering a shared
 * transcript for several agents before the runtime can route between them would look like it works.
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
        Could not load this channel.
      </p>
    );
  }

  const runtimeAgentId =
    channel.agentIds.length === 1 ? channel.agentIds[0] : undefined;
  if (!runtimeAgentId) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        This channel has more than one coworker, which is not supported yet.
      </p>
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

import { IconDownload, IconLoader2, IconSettings } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { z } from "zod";
import { AgentProfile } from "@/components/agents/agent-profile";
import { BotPausedBanner } from "@/components/bot-profile/pause-banner";
import { ChannelAvatar } from "@/components/channels/avatar";
import { ChannelChat } from "@/components/channels/channel-chat";
import { ConversationActions } from "@/components/channels/conversation-actions";
import {
  downloadMarkdown,
  exportFilename,
  transcriptMarkdown,
} from "@/components/channels/transcript-export";
import { ComputerChatControls } from "@/components/computer/computer-controls";
import { ComputerViewPanel } from "@/components/computer/computer-panel";
import { useAutoWatchScreen } from "@/components/computer/use-auto-watch-screen";
import { DetailPanel } from "@/components/layout/detail-panel";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { Button } from "@/components/ui/button";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import { type AgentChannel, channelQueryOptions } from "@/lib/channels/queries";
import { readThreadMessages } from "@/lib/copilot/thread-messages";

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

/**
 * How long an export will wait for the conversation's durable history.
 *
 * Far longer than the 1.5s the transcript's own restore waits, because that deadline exists to
 * keep a mount from stalling behind a slow read — an export is asked for deliberately, by a person
 * waiting on a button, and "not exported because the store was slow once" is a failure they would
 * rather not have. The transcript on screen is meanwhile untouched: this read is beside it, not
 * through it.
 */
const EXPORT_READ_DEADLINE_MS = 10_000;

export const Route = createFileRoute("/_authed/_app/channel/$channelId")({
  validateSearch: chatSearchSchema,
  component: RouteComponent,
});

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

  useMarkOpenChannelRead(channelId);

  /*
   * The export button's own state, kept here rather than in the transcript below: the button is
   * asked for by a person looking at the header, and both the waiting and the refusal belong
   * beside it, where the click happened.
   *
   * THE DURABLE HISTORY IS READ FRESH, not lifted from the transcript on screen. What is on screen
   * is the running agent's own array, which holds the turn in flight and anything the run has not
   * yet handed the store; what the store holds is the record. A person exporting a conversation is
   * keeping the record, and the two are the same thing except exactly when they would most want
   * them to be. A turn still streaming when Export is pressed can be missing from the file; press
   * it again once the Bot has finished.
   */
  const [exporting, setExporting] = useState(false);
  const [exportProblem, setExportProblem] = useState<string | null>(null);

  const exportConversation = async () => {
    const open = channel.data;
    if (!open || agentId === undefined || exporting) return;
    setExporting(true);
    setExportProblem(null);
    try {
      const stored = await readThreadMessages(open.threadId, agentId, {
        deadlineMs: EXPORT_READ_DEADLINE_MS,
      });
      if (stored.availability === "unavailable") throw new Error("unreadable");
      downloadMarkdown(
        exportFilename(open.name),
        transcriptMarkdown({
          name: open.name,
          messages: stored.messages,
          unreadable: stored.unreadable,
        }),
      );
    } catch {
      // One sentence, the same one every time: what the caller can do about it is try again, and
      // the reason is either the store or the network, neither of which this screen can name.
      setExportProblem(
        "Couldn't read this conversation to export it. Try again.",
      );
    } finally {
      setExporting(false);
    }
  };

  // Browser activity may auto-open the screen once per run unless this run was dismissed.
  const autoWatch = useAutoWatchScreen({
    botId: agentId,
    watching: isWatching,
    busy: isSettingsOpen,
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
      detailWidth={isWatching ? SCREEN_PANEL_WIDTH : undefined}
      title={isWatching ? "Computer" : undefined}
      detail={
        agentId === undefined ? null : isWatching ? (
          // Manual watch remains active even when there is no current browser action.
          <ComputerViewPanel agentId={agentId} name={channel?.data?.name} />
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
            <ComputerChatControls
              computerId={agentId}
              open={isWatching}
              onOpenChange={(open) => show(open ? "watch" : null)}
            />
            {/*
             * Disabled rather than hidden while the channel loads, so the header's buttons are in
             * the same places on first paint as on every paint after — a control that appears once
             * the network answers reads as the page moving under the person.
             */}
            <Button
              aria-label="Export conversation as Markdown"
              disabled={
                channel.data === undefined || agentId === undefined || exporting
              }
              onClick={() => {
                void exportConversation();
              }}
              variant="ghost"
              size="icon"
            >
              {exporting ? (
                <IconLoader2 className="size-4.5 motion-safe:animate-spin" />
              ) : (
                <IconDownload className="size-4.5" />
              )}
            </Button>
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
      {/* Said under the header, where the person is looking, and cleared by the next attempt. */}
      {exportProblem ? (
        <p className="text-destructive px-3 py-1 text-xs" role="alert">
          {exportProblem}
        </p>
      ) : null}
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

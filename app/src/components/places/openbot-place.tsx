import { IconPlus } from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { AnimatePresence } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ChannelRow } from "@/components/app-sidebar/conversation-roster";
import {
  QuestionBoardRow,
  RequestBoardRow,
  requestBoardTitle,
  useWaiting,
} from "@/components/approvals/waiting";
import {
  unreadSummary,
  useWaitingCount,
  waitingAcross,
} from "@/components/bot-profile/attention";
import { ChannelAvatar } from "@/components/channels/avatar";
import { useBotName, useNeedsYou } from "@/components/needs-you/needs-you";
import { useStalledHandoffs } from "@/components/needs-you/stalled-handoffs";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useOptionalSidebar } from "@/components/ui/sidebar";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { botAttentionQueryOptions } from "@/lib/bot-lifecycle/queries";
import {
  type ChannelWork,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { briefDuration, useNow } from "@/lib/elapsed";
import { type AtWorkRow, useAtWork } from "@/lib/places/at-work";
import {
  type NeedsYouEntry,
  needsYouEntries,
  recentFor,
} from "@/lib/places/openbot-sections";
import { primitive } from "@/lib/primitives";
import { routineDoes } from "@/lib/routines/merged";
import { routinesQueryOptions } from "@/lib/routines/queries";
import { useMessageListEmphasis } from "@/lib/settings/message-list";
import {
  PlaceEmpty,
  type PlaceEntry,
  PlaceHeading,
  PlaceRow,
  StripBadge,
} from "./place-row";

/**
 * A question or request, opened beside the list. Answering moves to another page, so the popover
 * closes on the way, and a phone's sidebar sheet with it: Answer is a button, which the sheet's own
 * link handling does not see.
 */
function BoardPopover({
  title,
  trailing,
  children,
}: {
  title: string;
  trailing: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const sidebar = useOptionalSidebar();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const openedAt = useRef(pathname);
  useEffect(() => {
    if (!open || pathname === openedAt.current) return;
    setOpen(false);
    sidebar?.setOpenMobile(false);
  }, [open, pathname, sidebar]);
  return (
    <Popover
      onOpenChange={(next) => {
        if (next) openedAt.current = pathname;
        setOpen(next);
      }}
      open={open}
    >
      <PopoverTrigger render={<PlaceRow title={title} trailing={trailing} />} />
      <PopoverContent
        align="start"
        className="w-96"
        side="right"
        sideOffset={8}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

function NeedsYouRow({ entry }: { entry: NeedsYouEntry }) {
  const botName = useBotName();
  const trailing = (
    <span className="text-muted-foreground text-xs">
      {botName(entry.botId)}
    </span>
  );
  switch (entry.kind) {
    case "question":
      return (
        <BoardPopover title={entry.question.question} trailing={trailing}>
          <QuestionBoardRow question={entry.question} />
        </BoardPopover>
      );
    case "request":
      return (
        <BoardPopover
          title={requestBoardTitle(entry.request)}
          trailing={trailing}
        >
          <RequestBoardRow request={entry.request} />
        </BoardPopover>
      );
    case "task":
      return (
        <PlaceRow
          title={entry.listed.task.title}
          to={{
            to: "/channel/$channelId",
            params: { channelId: entry.listed.task.channelId },
          }}
          trailing={trailing}
        />
      );
    case "handoff":
      return (
        <PlaceRow
          title={entry.item.title}
          to={{ to: "/bots/$agentId", params: { agentId: entry.botId } }}
          trailing={trailing}
        />
      );
  }
}

function Elapsed({ since, now }: { since: string; now: number }) {
  return (
    <span className="text-muted-foreground text-xs tabular-nums">
      {briefDuration((now - Date.parse(since)) / 1000)}
    </span>
  );
}

/**
 * Working on: one row per conversation with work running in it. A routine running is the row, by
 * its own name and the Bot it runs as; otherwise the row is the conversation. Under it, one line
 * for each other piece of work, and for how long.
 */
function WorkingOn({ rows }: { rows: AtWorkRow[] }) {
  const now = useNow(1000, rows.length > 0);
  const botName = useBotName();
  const anyRoutine = rows.some((row) =>
    row.work.some((work) => work.kind === "routine"),
  );
  const routines = useQuery({
    ...routinesQueryOptions(),
    enabled: anyRoutine,
  }).data?.routines;
  const routineName = (routineId: string): string | null => {
    const routine = routines?.find((found) => found.id === routineId);
    return routine ? (routine.title ?? routineDoes(routine)) : null;
  };
  const shown = useQuery(agentListQueryOptions());
  const hidden = useQuery(agentListQueryOptions(true));
  /* The roster's name when the person has the Bot, else the name it had when the work began. */
  const nameOf = (work: ChannelWork) =>
    [...(shown.data ?? []), ...(hidden.data ?? [])].find(
      (bot) => bot.id === work.botId,
    )?.name ??
    work.botName ??
    botName(work.botId);
  const RoutineIcon = primitive("routines").icon;

  return rows.map((row) => {
    const routine = row.work.find((work) => work.kind === "routine");
    const lines = row.work.filter((work) => work !== routine);
    return (
      <div key={row.channelId}>
        <PlaceRow
          detail={routine ? nameOf(routine) : undefined}
          media={
            routine ? (
              <RoutineIcon className="size-5 text-muted-foreground" />
            ) : (
              <ChannelAvatar participantIds={row.agentIds} size={20} typing />
            )
          }
          title={
            routine
              ? (routine.kind === "routine" &&
                  routineName(routine.routineId)) ||
                "A routine"
              : row.title
          }
          to={{
            to: row.group ? "/group/$channelId" : "/channel/$channelId",
            params: { channelId: row.channelId },
          }}
          trailing={row.since ? <Elapsed now={now} since={row.since} /> : null}
        />
        {lines.map((work) => (
          <p
            className="flex items-center gap-2 truncate pr-2 pl-9 text-muted-foreground text-xs"
            key={work.key}
          >
            <span className="min-w-0 flex-1 truncate">
              {work.kind === "routine"
                ? `Running ${routineName(work.routineId) ?? "a routine"}`
                : `Asked ${nameOf(work)}`}
            </span>
            <Elapsed now={now} since={work.since} />
          </p>
        ))}
      </div>
    );
  });
}

/**
 * For you: what needs the person, what is running on its own, and the conversations they were
 * last in. Each section is drawn only when it has rows.
 */
function ForYouPlace() {
  const list = useNeedsYou();
  const waiting = useWaiting(undefined);
  const handoffs = useStalledHandoffs();
  const entries = needsYouEntries({
    questions: waiting.questions,
    requests: waiting.pending,
    tasks: list.tasks,
    done: list.done,
    handoffs,
  });
  const waitingCount = useWaitingCount();
  const atWork = useAtWork();
  const working = atWork.rows;
  const channels = useInfiniteQuery(channelListQueryOptions());
  const recent = recentFor(channels.data ?? [], entries, working);
  const emphasis = useMessageListEmphasis();
  const loading = list.pending || waiting.loading;
  const failed = Boolean(list.error || waiting.error || atWork.failed);
  const empty =
    entries.length === 0 && working.length === 0 && recent.length === 0;

  return (
    <div className="flex flex-col pb-2">
      <PlaceRow
        media={<IconPlus className="size-5" />}
        title="New conversation"
        to={{ to: "/" }}
      />
      {loading ? null : (
        <>
          {entries.length > 0 ? (
            <section>
              <PlaceHeading count={waitingCount}>Needs you</PlaceHeading>
              {entries.map((entry) => (
                <NeedsYouRow entry={entry} key={`${entry.kind}-${entry.id}`} />
              ))}
            </section>
          ) : null}
          {working.length > 0 ? (
            <section>
              <PlaceHeading count={working.length}>Working on</PlaceHeading>
              <WorkingOn rows={working} />
            </section>
          ) : null}
          {recent.length > 0 ? (
            <section>
              <PlaceHeading>Recent</PlaceHeading>
              <AnimatePresence initial={false}>
                {recent.map((channel) => (
                  <ChannelRow
                    animateOrder
                    channel={channel}
                    dense
                    emphasis={emphasis}
                    key={channel.id}
                  />
                ))}
              </AnimatePresence>
            </section>
          ) : null}
          {failed ? (
            <p className="px-2 py-3 text-muted-foreground text-xs" role="alert">
              Couldn't load what needs you. Try again in a moment.
            </p>
          ) : empty ? (
            <PlaceEmpty>
              Nothing yet. Your conversations and what your Bots are doing show
              up here.
            </PlaceEmpty>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * What waits on the person as a count; else a pulse while work runs on its own; else a dot for
 * anything unread, as the Bots badge draws.
 */
function ForYouBadge() {
  const bots = useQuery(botAttentionQueryOptions()).data;
  const running = useAtWork().rows.length > 0;
  const waiting = waitingAcross(bots);
  if (waiting > 0) return <StripBadge count={waiting} />;
  if (running) return <StripBadge pulse />;
  const unread = unreadSummary(bots);
  return unread ? <StripBadge dot label={unread} /> : null;
}

export const openbotPlace: PlaceEntry = {
  List: ForYouPlace,
  Badge: ForYouBadge,
};

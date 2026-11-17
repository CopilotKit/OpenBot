import { IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
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
import { useBotName, useNeedsYou } from "@/components/needs-you/needs-you";
import { useStalledHandoffs } from "@/components/needs-you/stalled-handoffs";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useOptionalSidebar } from "@/components/ui/sidebar";
import { botAttentionQueryOptions } from "@/lib/bot-lifecycle/queries";
import { useAtWork } from "@/lib/places/at-work";
import {
  type NeedsYouEntry,
  needsYouEntries,
} from "@/lib/places/openbot-sections";
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

function OpenBotPlace() {
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
  const working = useAtWork().rows;
  const loading = list.pending || waiting.loading;
  const failed = Boolean(list.error || waiting.error);
  const empty =
    entries.length === 0 && working.length === 0 && list.done.length === 0;

  return (
    <div className="flex flex-col">
      <PlaceRow
        media={<IconPlus className="size-5" />}
        title="New conversation"
        to={{ to: "/" }}
      />
      {loading ? null : (
        <>
          {entries.length > 0 ? (
            <>
              <PlaceHeading count={waitingCount}>Needs you</PlaceHeading>
              {entries.map((entry) => (
                <NeedsYouRow entry={entry} key={`${entry.kind}-${entry.id}`} />
              ))}
            </>
          ) : null}
          {working.length > 0 ? (
            <>
              <PlaceHeading count={working.length}>Working on</PlaceHeading>
              {working.map((row) => (
                <PlaceRow
                  key={row.channelId}
                  title={row.title}
                  to={{
                    to: row.group ? "/group/$channelId" : "/channel/$channelId",
                    params: { channelId: row.channelId },
                  }}
                />
              ))}
            </>
          ) : null}
          {list.done.length > 0 ? (
            <>
              <PlaceHeading>Done this week</PlaceHeading>
              {list.done.map(({ task }) => (
                <PlaceRow
                  key={task.id}
                  title={task.title}
                  to={{
                    to: "/channel/$channelId",
                    params: { channelId: task.channelId },
                  }}
                />
              ))}
            </>
          ) : null}
          {failed ? (
            <p className="px-2 py-3 text-muted-foreground text-xs" role="alert">
              Couldn't load what needs you. Try again in a moment.
            </p>
          ) : empty ? (
            <PlaceEmpty>
              Nothing needs you. Work your Bots start shows up here.
            </PlaceEmpty>
          ) : null}
        </>
      )}
    </div>
  );
}

/** What waits on the person, or, when nothing does, a dot for anything unread, as the Bots badge draws. */
function OpenBotBadge() {
  const bots = useQuery(botAttentionQueryOptions()).data;
  const waiting = waitingAcross(bots);
  const unread = waiting === 0 ? unreadSummary(bots) : null;
  if (unread) return <StripBadge dot label={unread} />;
  return <StripBadge count={waiting} />;
}

export const openbotPlace: PlaceEntry = {
  List: OpenBotPlace,
  Badge: OpenBotBadge,
};

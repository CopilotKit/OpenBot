import {
  IconArrowsExchange,
  IconCalendarRepeat,
  IconChecks,
  IconChevronRight,
  IconClockPlay,
  IconHelpCircle,
  IconListCheck,
  IconShieldCheck,
  IconTargetArrow,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Item } from "@/components/ui/item";
import { approvalInboxOptions } from "@/lib/approvals";
import {
  cancelFollowUpMutationOptions,
  stopHandoffMutationOptions,
} from "@/lib/bot-lifecycle/mutations";
import {
  type ActivityItem,
  type ActivityKind,
  botActivityQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import { useMuse } from "../context";
import { actionPhrase, approvalStatus } from "../model";
import {
  ErrorNotice,
  IconTile,
  MuseButton,
  MuseCard,
  MuseChip,
  MuseEmpty,
  type MuseIcon,
  MuseScreen,
  museText,
  SectionHeading,
} from "../ui";

const ICONS: Record<ActivityKind, MuseIcon> = {
  routine: IconCalendarRepeat,
  responsibility: IconTargetArrow,
  handoff: IconArrowsExchange,
  approval: IconChecks,
  question: IconHelpCircle,
  follow_up: IconClockPlay,
};

const KIND: Record<ActivityKind, string> = {
  routine: "Routine",
  responsibility: "Responsibility",
  handoff: "Delegated task",
  approval: "Approval",
  question: "Question",
  follow_up: "Follow-up",
};

type Filter = "All" | "In progress" | "Finished";

/**
 * Activity: the work the centre Bot is doing, has scheduled and has finished, from OpenBot's own
 * activity ledger for that Bot; then every approval it asked for, waiting or decided.
 */
export function ActivityScreen() {
  const { bot, openSheet } = useMuse();
  const agentId = bot?.id ?? "";
  const activity = useQuery({
    ...botActivityQueryOptions(agentId),
    enabled: Boolean(agentId),
  });
  const inbox = useQuery(approvalInboxOptions());
  const [filter, setFilter] = useState<Filter>("All");
  const [receipts, setReceipts] = useState<"all" | "review">("all");

  const live = activity.data?.inProgress ?? [];
  const scheduled = activity.data?.scheduled ?? [];
  const finished = activity.data?.completed ?? [];
  const work =
    filter === "Finished"
      ? finished.map((item) => ({ item, live: false }))
      : [
          ...live.map((item) => ({ item, live: true })),
          ...scheduled.map((item) => ({ item, live: false })),
          ...(filter === "All"
            ? finished.map((item) => ({ item, live: false }))
            : []),
        ];

  const approvals = (inbox.data?.requests ?? []).filter(
    (request) => request.action.botId === agentId,
  );
  const pending = approvals.filter((request) => request.status === "pending");
  const shownApprovals = receipts === "review" ? pending : approvals;

  return (
    <MuseScreen title="Activity">
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap gap-2">
          {(["All", "In progress", "Finished"] as const).map((item) => (
            <MuseButton
              aria-pressed={filter === item}
              key={item}
              onClick={() => setFilter(item)}
              primary={filter === item}
              small
            >
              {item}
            </MuseButton>
          ))}
        </div>
        {!bot || activity.isPending ? null : activity.error ? (
          <ErrorNotice error={activity.error.message} />
        ) : work.length === 0 ? (
          <MuseEmpty
            detail={`Ask ${bot.name} for something in Chat. Its work, schedule and results stay here.`}
            icon={IconListCheck}
            title="A place for the work"
          />
        ) : (
          work.map(({ item, live }) => (
            <WorkCard agentId={agentId} item={item} key={item.id} live={live} />
          ))
        )}
        <SectionHeading className="mt-2 mb-0" title="Approvals" />
        <div className="flex flex-wrap gap-2.5">
          <MuseButton
            aria-pressed={receipts === "all"}
            onClick={() => setReceipts("all")}
            primary={receipts === "all"}
            small
          >
            All approvals
          </MuseButton>
          <MuseButton
            aria-pressed={receipts === "review"}
            onClick={() => setReceipts("review")}
            primary={receipts === "review"}
            small
          >
            Waiting · {pending.length}
          </MuseButton>
        </div>
        {inbox.isPending ? null : inbox.error ? (
          <ErrorNotice error={inbox.error.message} />
        ) : shownApprovals.length === 0 ? (
          <MuseCard>
            <MuseEmpty
              detail={
                receipts === "review"
                  ? `When ${bot?.name ?? "a Bot"} needs your OK before it acts, it appears here.`
                  : `Every action ${bot?.name ?? "a Bot"} asks you about is recorded here, with what you decided.`
              }
              icon={IconShieldCheck}
              title={
                receipts === "review"
                  ? "You're all caught up"
                  : "The beginning of something lighter"
              }
            />
          </MuseCard>
        ) : (
          <MuseCard>
            <SectionHeading title="Approval requests" />
            {shownApprovals.map((request) => {
              const waiting = request.status === "pending";
              return (
                <Item
                  className="flex-nowrap gap-[15px] rounded-none border-0 border-border border-t px-0 py-[17px] text-left hover:bg-transparent"
                  key={request.id}
                  render={
                    waiting ? (
                      <button
                        onClick={() => openSheet("notifications")}
                        type="button"
                      />
                    ) : undefined
                  }
                >
                  <IconTile
                    icon={waiting ? IconShieldCheck : IconChecks}
                    tint={waiting ? "lavender" : "green"}
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <p className={museText.body}>
                      {actionPhrase(request.action.toolRef).replace(/^./, (c) =>
                        c.toUpperCase(),
                      )}
                    </p>
                    <p className={cn(museText.small, "truncate")}>
                      {relativeTime(request.createdAt)}
                      {request.action.scope ? ` · ${request.action.scope}` : ""}
                    </p>
                  </div>
                  <MuseChip
                    tint={
                      request.status === "denied"
                        ? "danger"
                        : waiting
                          ? "lavender"
                          : "plain"
                    }
                  >
                    {approvalStatus(request.status).toLowerCase()}
                  </MuseChip>
                  {waiting ? (
                    <IconChevronRight
                      aria-hidden="true"
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                  ) : null}
                </Item>
              );
            })}
          </MuseCard>
        )}
      </div>
    </MuseScreen>
  );
}

/**
 * One piece of work, as OpenMuse's task card: a tile, its title, where it stands, and the one
 * control OpenBot offers for it — stop a hand-off, cancel a follow-up.
 */
function WorkCard({
  agentId,
  item,
  live,
}: {
  agentId: string;
  item: ActivityItem;
  live: boolean;
}) {
  const stop = useMutation(stopHandoffMutationOptions(queryClient));
  const cancel = useMutation(cancelFollowUpMutationOptions(queryClient));
  const Icon = ICONS[item.kind];
  const when = relativeTime(item.at);
  const body = (
    <>
      <div className="flex items-center gap-2.5">
        <span className="relative">
          <IconTile
            accent
            icon={Icon}
            size={34}
            tint={item.needsYou ? "orange" : "sky"}
          />
          {live ? (
            <span
              aria-hidden="true"
              className={cn(
                "absolute -top-0.5 -right-0.5 size-2 animate-pulse rounded-full ring-2 ring-[var(--openmuse-task)]",
                item.needsYou
                  ? "bg-[var(--openmuse-amber)]"
                  : "bg-[var(--openmuse-green-dot)]",
              )}
            />
          ) : null}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className={museText.heading}>{item.title}</p>
          <p className={museText.small}>
            {KIND[item.kind]} · {item.status.replace(/_/g, " ")}
            {when ? ` · ${when}` : ""}
          </p>
        </div>
        {item.channelId ? (
          <IconChevronRight
            aria-hidden="true"
            className="size-[17px] shrink-0 text-muted-foreground"
          />
        ) : null}
      </div>
      {item.detail ? (
        <p className={cn(museText.muted, "line-clamp-4")}>{item.detail}</p>
      ) : null}
      {item.needsYou ? (
        <p className="font-semibold text-[11px] text-[var(--openmuse-accent)] leading-[17px]">
          {item.kind === "question"
            ? "Your input is needed"
            : "Approval requested"}
        </p>
      ) : null}
    </>
  );
  const control = item.stoppable ? (
    <MuseButton
      className="self-start"
      disabled={stop.isPending}
      onClick={() => stop.mutate({ agentId, id: item.id })}
      small
    >
      {stop.isPending ? "Stopping…" : "Stop"}
    </MuseButton>
  ) : item.cancellable ? (
    <MuseButton
      className="self-start"
      disabled={cancel.isPending}
      onClick={() => cancel.mutate({ agentId, id: item.id })}
      small
    >
      {cancel.isPending ? "Cancelling…" : "Cancel"}
    </MuseButton>
  ) : null;
  const card =
    "flex flex-col gap-[11px] rounded-[22px] bg-[var(--openmuse-task)] p-5";
  return (
    <div className="flex flex-col gap-2">
      {item.channelId ? (
        <Link
          aria-label={`Open: ${item.title}`}
          className={cn(
            card,
            "outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
          )}
          params={{ channelId: item.channelId }}
          to="/channel/$channelId"
        >
          {body}
        </Link>
      ) : (
        <div className={card}>{body}</div>
      )}
      {control}
      <ErrorNotice error={stop.error?.message ?? cancel.error?.message} />
    </div>
  );
}

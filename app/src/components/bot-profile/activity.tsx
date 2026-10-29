import {
  IconArrowsExchange,
  type IconBell,
  IconCalendarRepeat,
  IconChecks,
  IconChevronRight,
  IconClockPlay,
  IconHelpCircle,
  IconHistory,
  IconTargetArrow,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
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
import {
  cancelFollowUpMutationOptions,
  stopHandoffMutationOptions,
} from "@/lib/bot-lifecycle/mutations";
import {
  type ActivityItem,
  type ActivityKind,
  type BotActivity,
  botActivityQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

const ICONS: Record<ActivityKind, typeof IconBell> = {
  routine: IconCalendarRepeat,
  responsibility: IconTargetArrow,
  handoff: IconArrowsExchange,
  approval: IconChecks,
  question: IconHelpCircle,
  follow_up: IconClockPlay,
};

const KIND_LABEL: Record<ActivityKind, string> = {
  routine: "Routine",
  responsibility: "Responsibility",
  handoff: "Delegated task",
  approval: "Approval",
  question: "Question",
  follow_up: "Follow-up",
};

/** Where an item opens: its conversation when it has one, otherwise the screen that owns its kind. */
function linkFor(item: ActivityItem, agentId: string) {
  if (item.channelId)
    return (
      <Link to="/channel/$channelId" params={{ channelId: item.channelId }} />
    );
  switch (item.kind) {
    case "approval":
    case "question":
      return <Link params={{ agentId }} to="/bots/$agentId" />;
    case "responsibility":
      return <Link params={{ agentId }} to="/bots/$agentId/responsibilities" />;
    case "routine":
      return <Link params={{ agentId }} to="/bots/$agentId/routines" />;
    default:
      return null;
  }
}

function ActivityRow({
  agentId,
  item,
  live = false,
}: {
  agentId: string;
  item: ActivityItem;
  /** Under way now: a pulsing dot on its icon, amber when it is waiting on the person. */
  live?: boolean;
}) {
  const stop = useMutation(stopHandoffMutationOptions(queryClient));
  const cancel = useMutation(cancelFollowUpMutationOptions(queryClient));
  const Icon = ICONS[item.kind];
  const link = linkFor(item, agentId);
  const when = relativeTime(item.at);
  const control = item.stoppable ? (
    <Button
      disabled={stop.isPending}
      onClick={() => stop.mutate({ agentId, id: item.id })}
      size="sm"
      variant="outline"
    >
      {stop.isPending ? "Stopping…" : "Stop"}
    </Button>
  ) : item.cancellable ? (
    <Button
      disabled={cancel.isPending}
      onClick={() => cancel.mutate({ agentId, id: item.id })}
      size="sm"
      variant="outline"
    >
      {cancel.isPending ? "Cancelling…" : "Cancel"}
    </Button>
  ) : null;
  const content = (
    <>
      <ItemMedia className="relative" variant="icon">
        <Icon />
        {live ? (
          <span
            aria-hidden="true"
            className={cn(
              "absolute -top-0.5 -right-0.5 size-2 animate-pulse rounded-full ring-2 ring-card",
              item.needsYou ? "bg-amber-500" : "bg-emerald-500",
            )}
          />
        ) : null}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{item.title}</ItemTitle>
        <ItemDescription>
          {KIND_LABEL[item.kind]} · {item.needsYou ? "needs you" : item.status}
          {when ? ` · ${when}` : ""}
          {item.detail ? ` · ${item.detail}` : ""}
        </ItemDescription>
      </ItemContent>
    </>
  );
  /*
   * A row with a Stop or Cancel keeps the row itself unlinked, so the button is not nested inside a
   * link; the conversation is still one click away through the title's own link.
   */
  if (control)
    return (
      <Item size="sm">
        {content}
        <ItemActions>
          {link ? (
            <Button render={link} size="sm" variant="ghost">
              Open
            </Button>
          ) : null}
          {control}
        </ItemActions>
      </Item>
    );
  return link ? (
    <Item render={link} size="sm">
      {content}
    </Item>
  ) : (
    <Item size="sm">{content}</Item>
  );
}

function ActivitySection({
  agentId,
  empty,
  items,
  live = false,
  title,
}: {
  agentId: string;
  empty: string;
  items: ActivityItem[];
  live?: boolean;
  title: string;
}) {
  return (
    <PageSection title={title}>
      {items.length === 0 ? (
        <PageEmpty icon={IconHistory}>{empty}</PageEmpty>
      ) : (
        <PageRows>
          {items.map((item, index) => (
            <Fragment key={item.id}>
              {index > 0 ? <Separator /> : null}
              <ActivityRow agentId={agentId} item={item} live={live} />
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}

/** How many running or scheduled items the Bot's page shows before "All activity". */
const GLANCE = 3;

/**
 * The Bot page's view of its activity: what is under way and what is lined up, so either is seen
 * without opening anything, then a row to the full lists. Running work comes first, with its dot.
 *
 * The full lists used to sit here and ran on for screens; finished work is the long part and the
 * least urgent, so it lives only on the Activity page.
 */
export function BotActivityGlance({ agentId }: { agentId: string }) {
  const activity = useQuery(botActivityQueryOptions(agentId));
  if (activity.isPending) return null;
  const upcoming = activity.data
    ? [
        ...activity.data.inProgress.map((item) => ({ item, live: true })),
        ...activity.data.scheduled.map((item) => ({ item, live: false })),
      ].slice(0, GLANCE)
    : [];
  return (
    <PageSection title="Activity">
      <PageRows>
        {upcoming.map(({ item, live }) => (
          <Fragment key={item.id}>
            <ActivityRow agentId={agentId} item={item} live={live} />
            <Separator />
          </Fragment>
        ))}
        <Item
          render={<Link params={{ agentId }} to="/bots/$agentId/activity" />}
          size="sm"
        >
          {upcoming.length ? null : (
            <ItemMedia variant="icon">
              <IconHistory />
            </ItemMedia>
          )}
          <ItemContent>
            <ItemTitle>All activity</ItemTitle>
            <ItemDescription>
              {activity.data
                ? activitySummary(activity.data)
                : "Couldn't load this Bot's activity."}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
      </PageRows>
    </PageSection>
  );
}

/**
 * The Bot page's one line about its activity: what is running and what is lined up, the two that
 * might want a look. Finished work is only counted when there is nothing else to say.
 */
export function activitySummary(activity: BotActivity): string {
  const parts = [
    activity.inProgress.length
      ? `${activity.inProgress.length} in progress`
      : null,
    activity.scheduled.length ? `${activity.scheduled.length} scheduled` : null,
  ].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  return activity.completed.length
    ? "Nothing running or scheduled"
    : "Nothing yet";
}

/** In progress, Scheduled and Completed, read from the ledgers the work already lives in. */
export function BotActivitySections({ agentId }: { agentId: string }) {
  const activity = useQuery(botActivityQueryOptions(agentId));
  if (activity.isPending) return null;
  if (activity.error)
    return (
      <PageSection title="Activity">
        <p className="mt-4 text-destructive text-sm" role="alert">
          Couldn't load this Bot's activity. Reload the page.
        </p>
      </PageSection>
    );
  return (
    <>
      <ActivitySection
        agentId={agentId}
        empty="Nothing is running or waiting on you."
        items={activity.data.inProgress}
        live
        title="In progress"
      />
      <ActivitySection
        agentId={agentId}
        empty="Nothing is scheduled."
        items={activity.data.scheduled}
        title="Scheduled"
      />
      <ActivitySection
        agentId={agentId}
        empty="Nothing has finished yet."
        items={activity.data.completed}
        title="Completed"
      />
    </>
  );
}

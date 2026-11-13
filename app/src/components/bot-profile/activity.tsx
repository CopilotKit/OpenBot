import {
  IconArrowsExchange,
  type IconBell,
  IconCalendarRepeat,
  IconChecks,
  IconChevronRight,
  IconClock,
  IconClockPlay,
  IconHelpCircle,
  IconHistory,
  IconListDetails,
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
import { currentUserQueryOptions } from "@/lib/auth/queries";
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
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { proactiveSettingsQueryOptions } from "@/lib/proactive";
import { relativeTime } from "@/lib/relative-time";
import { routinesQueryOptions } from "@/lib/routines/queries";
import { taskListQueryOptions } from "@/lib/tasks/queries";
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
  responsibility: "Goal",
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
      return <Link params={{ agentId }} to="/bots/$agentId/routines" />;
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
      {/* One line, cut with an ellipsis; the whole title shows on hover. */}
      <ItemContent className="min-w-0">
        <ItemTitle className="block w-auto truncate" title={item.title}>
          {item.title}
        </ItemTitle>
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
 * Running work first, then what is lined up, then the goals that wait to be asked, as many as the
 * Bot's page shows.
 */
function upcomingOf(activity: BotActivity | undefined) {
  return activity
    ? [
        ...activity.inProgress.map((item) => ({ item, live: true })),
        ...activity.scheduled.map((item) => ({ item, live: false })),
        ...(activity.onDemand ?? []).map((item) => ({ item, live: false })),
      ].slice(0, GLANCE)
    : [];
}

/**
 * The Bot page's view of its activity: what is under way and what is lined up, so either is seen
 * without opening anything, then a row to the full lists. Running work comes first, with its dot.
 *
 * Only when there is something running or lined up. With nothing to show, a whole section for one
 * row to the full lists is a heading over nothing; that row joins "For you" instead, through
 * `BotActivityRow`.
 *
 * The full lists used to sit here and ran on for screens; finished work is the long part and the
 * least urgent, so it lives only on the Activity page.
 */
export function BotActivityGlance({ agentId }: { agentId: string }) {
  const activity = useQuery(botActivityQueryOptions(agentId));
  const upcoming = upcomingOf(activity.data);
  if (activity.isPending || upcoming.length === 0) return null;
  return (
    <PageSection title="Activity">
      <PageRows>
        {upcoming.map(({ item, live }) => (
          <Fragment key={item.id}>
            <ActivityRow agentId={agentId} item={item} live={live} />
            <Separator />
          </Fragment>
        ))}
        <AllActivityItem activity={activity.data} agentId={agentId} />
      </PageRows>
    </PageSection>
  );
}

/**
 * The row to a Bot's activity, inside "For you", for when nothing is running or lined up and
 * `BotActivityGlance` draws no section of its own. Starts with a separator, because it follows the
 * card's other rows.
 */
export function BotActivityRow({ agentId }: { agentId: string }) {
  const activity = useQuery(botActivityQueryOptions(agentId));
  if (activity.isPending || upcomingOf(activity.data).length > 0) return null;
  return (
    <>
      <Separator />
      <AllActivityItem
        activity={activity.data}
        agentId={agentId}
        title="Activity"
        withIcon
      />
    </>
  );
}

function AllActivityItem({
  activity,
  agentId,
  title = "All activity",
  withIcon = false,
}: {
  activity: BotActivity | undefined;
  agentId: string;
  title?: string;
  withIcon?: boolean;
}) {
  const checkIns = useQuery(proactiveSettingsQueryOptions());
  const tasks = useQuery(taskListQueryOptions());
  return (
    <Item
      render={<Link params={{ agentId }} to="/bots/$agentId/activity" />}
      size="sm"
    >
      {withIcon ? (
        <ItemMedia variant="icon">
          <IconHistory />
        </ItemMedia>
      ) : null}
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        <ItemDescription>
          {activity
            ? activitySummary(activity, {
                checkIns: (checkIns.data ?? []).filter(
                  (checkIn) => checkIn.agentId === agentId && checkIn.enabled,
                ).length,
                openTasks: (tasks.data ?? []).filter(
                  (task) =>
                    task.agentId === agentId && task.status !== "resolved",
                ).length,
              })
            : "Couldn't load this Bot's activity."}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}

/**
 * The Bot page's one line about its activity: what is running, what is lined up and which goals
 * wait to be asked. Finished work is only counted when there is nothing else to say. A goal that
 * runs only when asked is never "scheduled": it was, and a Bot with one routine read "2 scheduled".
 *
 * Check-ins and tasks are kept apart from the activity ledger, so they are passed in. FOUND IN AN
 * AUDIT: a Bot with a check-in on and a task open read "No tasks, routines or goals yet", beside a
 * Routines row that said "1 scheduled".
 */
export function activitySummary(
  activity: BotActivity,
  beside: {
    /** How many of the Bot's check-ins are on: each is lined up, as the Routines row counts it. */
    checkIns?: number;
    /** How many of the person's tasks with this Bot are not yet resolved: each is under way. */
    openTasks?: number;
  } = {},
): string {
  const onDemand = activity.onDemand?.length ?? 0;
  const inProgress = activity.inProgress.length + (beside.openTasks ?? 0);
  const scheduled = activity.scheduled.length + (beside.checkIns ?? 0);
  const parts = [
    inProgress ? `${inProgress} in progress` : null,
    scheduled ? `${scheduled} scheduled` : null,
    onDemand ? `${onDemand} on demand` : null,
  ].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  return activity.completed.length
    ? "Nothing running or scheduled"
    : "No tasks, routines or goals yet";
}

/**
 * Whether a lined-up item is one of the Bot's routines (a goal and a check-in are routines too), so
 * its Routines page lists it. A follow-up the Bot scheduled for itself, a queued run of a goal and a
 * delegated task waiting its turn are not on that page; they stay on this one, under Scheduled.
 */
export function isRoutine(item: ActivityItem): boolean {
  return (
    item.kind === "routine" ||
    (item.kind === "responsibility" &&
      !item.id.startsWith("responsibility-run:"))
  );
}

/**
 * What the row to the Bot's Routines says: how many of its routines are lined up, and how many wait
 * to be asked. It counts only what the Routines page lists, as that page lists it: a routine that
 * runs a goal is one of the goal's starts (`goalRoutineIds`), not a second row, and each check-in
 * that is on is lined up too (`checkIns`).
 *
 * FOUND IN REVIEW: a goal and the routine that runs it counted as "2 scheduled", and check-ins not
 * at all, while the Routines page showed one row for the goal and one for the check-in.
 */
export function routinesSummary(
  activity: BotActivity,
  routinesPage: {
    /** The routines the Routines page draws under a goal (`goalId`). */
    goalRoutineIds: ReadonlySet<string>;
    /** How many of the Bot's check-ins are on. */
    checkIns: number;
  } = { goalRoutineIds: new Set(), checkIns: 0 },
): string {
  const scheduled =
    activity.scheduled.filter(
      (item) =>
        isRoutine(item) &&
        !(
          item.kind === "routine" &&
          routinesPage.goalRoutineIds.has(item.id.slice("routine:".length))
        ),
    ).length + routinesPage.checkIns;
  const onDemand = (activity.onDemand ?? []).filter(isRoutine).length;
  const parts = [
    scheduled ? `${scheduled} scheduled` : null,
    onDemand ? `${onDemand} on demand` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No routines yet.";
}

/**
 * In progress, Scheduled and Completed, read from the ledgers the work already lives in, and the
 * Bot's actions in the trail. Scheduled lists what the Bot lined up outside its routines (its own
 * follow-ups, queued runs, delegated tasks), each with its Cancel, and ends on a row to the Bot's
 * Routines for the rest.
 */
export function BotActivitySections({ agentId }: { agentId: string }) {
  const activity = useQuery(botActivityQueryOptions(agentId));
  // What the Routines page reads, to count its rows as it draws them (`routinesSummary`).
  const routines = useQuery(routinesQueryOptions());
  const checkIns = useQuery(proactiveSettingsQueryOptions());
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
      <PageSection title="Scheduled">
        <PageRows>
          {activity.data.scheduled
            .filter((item) => !isRoutine(item))
            .map((item) => (
              <Fragment key={item.id}>
                <ActivityRow agentId={agentId} item={item} />
                <Separator />
              </Fragment>
            ))}
          {/*
           * The Bot's routines have one page, its Routines. This row goes there instead of listing
           * them a second time.
           */}
          <Item
            render={<Link params={{ agentId }} to="/bots/$agentId/routines" />}
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconClock />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Routines</ItemTitle>
              <ItemDescription>
                {routinesSummary(activity.data, {
                  goalRoutineIds: new Set(
                    (routines.data?.routines ?? [])
                      .filter((routine) => routine.goalId)
                      .map((routine) => routine.id),
                  ),
                  checkIns: (checkIns.data ?? []).filter(
                    (checkIn) => checkIn.agentId === agentId && checkIn.enabled,
                  ).length,
                })}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>
      <ActivitySection
        agentId={agentId}
        empty="No tasks, routines or goals have finished yet."
        items={activity.data.completed}
        title="Completed"
      />
      <BotActionsSection agentId={agentId} />
    </>
  );
}

/**
 * Where this Bot's actions are: the audit trail, narrowed to it.
 *
 * The lists above are tasks, routines and goals. A file saved, a page opened or an app called in a
 * conversation is none of those, so a Bot could work all day and this page said nothing had
 * finished. Those actions are recorded once, in the trail, with whether each was allowed, blocked
 * or did not happen; this links there rather than keeping a second copy here. Only for someone who
 * can open the trail: Settings › Activity in the personal edition, Admin › Audit for an admin.
 */
function BotActionsSection({ agentId }: { agentId: string }) {
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const admin = useQuery(currentUserQueryOptions()).data?.role === "admin";
  if (!personal && !admin) return null;
  return (
    <PageSection title="Actions">
      <PageRows>
        <Item
          render={
            personal ? (
              <Link search={{ bot: agentId }} to="/settings/activity" />
            ) : (
              <Link search={{ bot: agentId }} to="/admin/audit" />
            )
          }
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconListDetails />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Every action this Bot took</ItemTitle>
            <ItemDescription>
              See the files, pages and apps it used, and which were allowed,
              blocked or didn't happen.
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

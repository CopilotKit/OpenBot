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
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import {
  SettingRow,
  useCheckInsBlocked,
} from "@/components/suggestions/proactive-panel";
import { TaskRow } from "@/components/tasks/task-row";
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
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { isOrganizationAdmin } from "@/lib/auth/roles";
import {
  type ActivityEntry,
  type ActivityGroup,
  groupActivity,
  isRoutine,
} from "@/lib/bot-lifecycle/activity-groups";
import {
  cancelFollowUpMutationOptions,
  stopHandoffMutationOptions,
} from "@/lib/bot-lifecycle/mutations";
import type {
  ActivityItem,
  ActivityKind,
  BotActivity,
} from "@/lib/bot-lifecycle/queries";
import { conversationTitle } from "@/lib/channels/label";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { loadFailure } from "@/lib/load-failure";
import { proactiveSettingsQueryOptions } from "@/lib/proactive";
import { relativeTime } from "@/lib/relative-time";
import { routinesQueryOptions } from "@/lib/routines/queries";
import { orderTasks } from "@/lib/tasks/groups";
import { taskListQueryOptions } from "@/lib/tasks/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import { useBotActivity } from "./use-bot-reads";

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

export function ActivityRow({
  agentId,
  item,
  live = false,
}: {
  agentId: string;
  item: ActivityItem;
  /** Under way now: a pulsing dot on its icon, the warning colour when it is waiting on the person. */
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
              item.needsYou ? "bg-warning" : "bg-success",
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

/**
 * A Bot's activity in the groups its Activity page lists: its own activity, its tasks in their live
 * state, its routines and its check-ins, put together by `groupActivity`. The Activity page draws
 * these groups and the Bot page's row to it counts them, so the two never disagree.
 */
function useActivityGroups(agentId: string, boardAbove = false) {
  const activity = useBotActivity(agentId);
  const taskList = useQuery(taskListQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  // What the Routines page reads, to count its rows as it draws them (`routinesSummary`).
  const routines = useQuery(routinesQueryOptions());
  const checkIns = useQuery(proactiveSettingsQueryOptions());
  const channel = (channelId: string) =>
    channels.data?.find((candidate) => candidate.id === channelId);
  const goalRoutineIds = new Set(
    (routines.data?.routines ?? [])
      .filter((routine) => routine.goalId)
      .map((routine) => routine.id),
  );
  const ownCheckIns = (checkIns.data ?? []).filter(
    (checkIn) => checkIn.botId === agentId && checkIn.enabled,
  );
  const groups = activity.data
    ? groupActivity({
        activity: activity.data,
        tasks: orderTasks(
          (taskList.data ?? []).filter((task) => task.agentId === agentId),
          (channelId) => channel(channelId)?.busy === true,
          Date.now(),
        ),
        checkIns: ownCheckIns,
        goalRoutineIds,
        boardAbove,
      })
    : [];
  return {
    activity,
    taskList,
    channel,
    goalRoutineIds,
    ownCheckIns,
    groups,
    pending: activity.isPending || taskList.isPending,
  };
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
  const { activity, groups, pending } = useActivityGroups(agentId);
  const upcoming = upcomingOf(activity.data);
  if (pending || upcoming.length === 0) return null;
  return (
    <PageSection title="Activity">
      <PageRows>
        {upcoming.map(({ item, live }) => (
          <Fragment key={item.id}>
            <ActivityRow agentId={agentId} item={item} live={live} />
            <Separator />
          </Fragment>
        ))}
        <AllActivityItem
          activity={activity.data}
          agentId={agentId}
          groups={groups}
        />
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
  const { activity, groups, pending } = useActivityGroups(agentId);
  if (pending || upcomingOf(activity.data).length > 0) return null;
  return (
    <>
      <Separator />
      <AllActivityItem
        activity={activity.data}
        agentId={agentId}
        groups={groups}
        title="Activity"
        withIcon
      />
    </>
  );
}

function AllActivityItem({
  activity,
  agentId,
  groups,
  title = "All activity",
  withIcon = false,
}: {
  activity: BotActivity | undefined;
  agentId: string;
  /** What the Activity page lists, which the summary counts. */
  groups: readonly ActivityGroup[];
  title?: string;
  withIcon?: boolean;
}) {
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
            ? activitySummary(activity, groups)
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
 * Counted from what the Activity page lists (`groups`, its tasks included), so the row never says
 * there is nothing while the page it opens lists something. FOUND LIVE: it said "No tasks, routines
 * or goals yet" over an Activity page with a finished task under Done, because it counted only the
 * Bot's own activity. Without `groups`, the Bot's own activity alone.
 */
export function activitySummary(
  activity: BotActivity,
  groups: readonly ActivityGroup[] = groupActivity({ activity, tasks: [] }),
): string {
  const onDemand = activity.onDemand?.length ?? 0;
  const count = (id: ActivityGroup["id"]) =>
    groups.find((group) => group.id === id)?.entries.length ?? 0;
  const inProgress = count("needs_you") + count("working");
  const parts = [
    inProgress ? `${inProgress} in progress` : null,
    activity.scheduled.length ? `${activity.scheduled.length} scheduled` : null,
    onDemand ? `${onDemand} on demand` : null,
  ].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  return groups.length
    ? "Nothing running or scheduled"
    : "No tasks, routines or goals yet";
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
 * The row for one entry: a task in its own conversation, with the way back to the conversation that
 * asked for it; a check-in as the Routines list draws it; anything else as this page always has.
 */
function EntryRow({
  agentId,
  blocked,
  botName,
  entry,
  settled,
  titleOf,
}: {
  agentId: string;
  blocked: string | null;
  botName: string;
  entry: ActivityEntry;
  /** Under Done: a task there asks for nothing. */
  settled: boolean;
  /** What a conversation is called, or null when the list has not reached it. */
  titleOf: (channelId: string) => string | null;
}) {
  if (entry.kind === "task") {
    const origin = entry.listed.task.originChannelId;
    return (
      <TaskRow
        askedIn={
          origin ? { channelId: origin, title: titleOf(origin) } : undefined
        }
        listed={entry.listed}
        settled={settled}
      />
    );
  }
  if (entry.kind === "check_in")
    return (
      <SettingRow
        agentId={agentId}
        blocked={blocked}
        botName={botName}
        label="Check-in"
        setting={entry.checkIn}
        showBot={false}
      />
    );
  return <ActivityRow agentId={agentId} item={entry.item} live={entry.live} />;
}

/**
 * Everything this Bot is doing for the person, grouped by where it stands: what needs them first,
 * then what is working, what is lined up, what is done, what failed, and what recurs. A group with
 * nothing in it is not drawn (`groupActivity`).
 *
 * It lists the conversations the Bot opened to do a piece of work in, which stay out of the
 * conversation list, each with a link back to the conversation that asked for it. Routines, goals
 * and check-ins are under Recurring, which ends on a row to the Bot's Routines, where they are
 * changed.
 */
export function BotActivitySections({
  agentId,
  boardAbove = false,
}: {
  agentId: string;
  /** The Needs you board sits above, so tasks and what the Bot asked are not listed twice. */
  boardAbove?: boolean;
}) {
  const {
    activity,
    taskList,
    channel,
    goalRoutineIds,
    ownCheckIns,
    groups,
    pending,
  } = useActivityGroups(agentId, boardAbove);
  const bots = useQuery(agentListQueryOptions());
  const blocked = useCheckInsBlocked();
  if (pending || activity.isPending) return null;
  if (activity.error)
    return (
      <PageSection title="Activity">
        <p className="mt-4 text-destructive text-sm" role="alert">
          {loadFailure(
            activity.error,
            "Couldn't load this Bot's activity. Try again in a moment.",
          )}
        </p>
      </PageSection>
    );
  const titleOf = (channelId: string) => {
    const found = channel(channelId);
    return (found && conversationTitle(found)) || null;
  };
  return (
    <>
      {/* The tasks failing to load leaves the rest listed, and says which part is missing. */}
      {taskList.error ? (
        <p className="text-destructive text-sm" role="alert">
          {loadFailure(
            taskList.error,
            "Couldn't load this Bot's tasks. Try again in a moment.",
          )}
        </p>
      ) : null}
      {groups.length === 0 && !taskList.error ? (
        <PageEmpty icon={IconHistory} title="No activity yet">
          Tasks, routines and check-ins show up here once this Bot starts them.
        </PageEmpty>
      ) : null}
      {groups.map((group) => (
        <PageSection key={group.id} title={group.title}>
          <PageRows>
            {group.entries.map((entry, index) => (
              <Fragment key={entry.key}>
                {index > 0 ? <Separator /> : null}
                <EntryRow
                  agentId={agentId}
                  blocked={blocked}
                  botName={
                    bots.data?.find((bot) => bot.id === agentId)?.name ??
                    "This Bot"
                  }
                  entry={entry}
                  settled={group.id === "done"}
                  titleOf={titleOf}
                />
              </Fragment>
            ))}
            {/* The Bot's routines are changed on one page, its Routines. This row goes there. */}
            {group.id === "recurring" ? (
              <>
                <Separator />
                <Item
                  render={
                    <Link params={{ agentId }} to="/bots/$agentId/routines" />
                  }
                  size="sm"
                >
                  <ItemMedia variant="icon">
                    <IconClock />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>Routines</ItemTitle>
                    <ItemDescription>
                      {routinesSummary(activity.data, {
                        goalRoutineIds,
                        checkIns: ownCheckIns.length,
                      })}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <IconChevronRight className="size-4 text-muted-foreground" />
                  </ItemActions>
                </Item>
              </>
            ) : null}
          </PageRows>
        </PageSection>
      ))}
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
  const admin = isOrganizationAdmin(
    useQuery(currentUserQueryOptions()).data?.role,
  );
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

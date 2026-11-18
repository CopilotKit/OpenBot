import {
  IconChevronRight,
  IconClock,
  IconPlayerPause,
  IconRadar,
} from "@tabler/icons-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import { LoadingRows } from "@/components/layout/loading-rows";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { STATUS } from "@/components/responsibilities/goal-page";
import { KIND_LABEL } from "@/components/responsibilities/triggers";
import { useGoalTriggers } from "@/components/responsibilities/use-goal-reads";
import {
  checkInStatus,
  lastCheckInLine,
  useCheckInsBlocked,
} from "@/components/suggestions/proactive-panel";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { conversationTitle } from "@/lib/channels/label";
import { channelListQueryOptions } from "@/lib/channels/queries";
import type { ProactiveSetting } from "@/lib/proactive";
import type { ResponsibilityRecord } from "@/lib/responsibilities";
import { describeEvent } from "@/lib/routines/events";
import {
  goalCanEnd,
  goalStarts,
  intervalLabel,
  isDone,
  type MergedRoutine,
  routineDoes,
} from "@/lib/routines/merged";
import type { RoutineRecord } from "@/lib/routines/queries";
import { useMergedRoutines } from "@/lib/routines/use-merged";
import { NewRoutineButton } from "./new-routine-button";
import { lastRunLabel, scheduleWords } from "./routine-page";

/** "Posts in Leads", from a conversation's title, or nothing when it isn't known. */
function postsIn(title: string | null | undefined): string | null {
  return title ? `Posts in ${title}` : null;
}

/** The parts of a details line that are known, joined. */
function details(parts: (string | null | undefined | false)[]): string {
  return parts.filter(Boolean).join(" · ");
}

/**
 * A scheduled routine's row, read as its pair: when (its schedule) above what (its title, else
 * `routineDoes`), then where it posts and a last run worth knowing about. The whole row links to its
 * page, where it is switched, run, read back and deleted.
 */
function RoutineItem({
  routine,
  botName,
  agentId,
}: {
  routine: RoutineRecord;
  /** Absent on one Bot's own list. */
  botName?: string;
  /** The Bot whose own list this is, so the page's back link returns to it. */
  agentId?: string;
}) {
  const lastRun = lastRunLabel(routine.lastRun);
  const outcome = routine.lastRun?.status;
  const does = routineDoes(routine);
  const line = details([
    botName,
    routine.enabled ? null : "Paused. Nothing starts it until you turn it on",
    routine.conversation.gone ? null : postsIn(routine.conversation.title),
  ]);
  return (
    <Item
      render={
        <Link
          params={{ routineId: routine.id }}
          search={agentId ? { agentId } : {}}
          to="/routines/schedules/$routineId"
        />
      }
      size="sm"
    >
      <ItemMedia variant="icon">
        {routine.enabled ? <IconClock /> : <IconPlayerPause />}
      </ItemMedia>
      <ItemContent className={routine.enabled ? "" : "opacity-60"}>
        <ItemTitle>{scheduleWords(routine)}</ItemTitle>
        {/* The clamp is on the words, so a long instruction doesn't push the details away. */}
        <ItemDescription className="line-clamp-2 text-foreground">
          {routine.title ?? does}
        </ItemDescription>
        {routine.title && routine.title !== does ? (
          <ItemDescription className="line-clamp-1">{does}</ItemDescription>
        ) : null}
        {line ? <ItemDescription>{line}</ItemDescription> : null}
        {/* Only a last run worth stopping for: a quiet success is in the details. */}
        {outcome === "failed" || outcome === "skipped" ? (
          <ItemDescription className={lastRun.className}>
            {lastRun.text}
          </ItemDescription>
        ) : null}
        {routine.conversation.gone ? (
          <ItemDescription className="text-destructive">
            Its conversation was deleted
          </ItemDescription>
        ) : null}
      </ItemContent>
      <ItemActions>
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}

/**
 * A goal's row: when (its schedules, events and triggers, or when you ask) above what (its title),
 * then until when (its outcome) and where it stands. It opens the goal's own page, where its
 * schedules are switched and deleted too: a link, so it can be opened in a new tab and the back
 * button returns to this list.
 *
 * A chevron rather than a Switch, although pausing is binary: the row opens a page, and a Switch
 * inside a row that is itself a link would be a control nested in a control.
 */
function GoalItem({
  goal,
  routines,
  botName,
  agentId,
  conversation,
}: {
  goal: ResponsibilityRecord;
  /** Undefined when the routines read failed: its starts are then not known. */
  routines: readonly RoutineRecord[] | undefined;
  /** Absent on one Bot's own list. */
  botName?: string;
  /** The Bot whose own list this is, so the goal's back link returns to it. */
  agentId?: string;
  /** The title of the conversation it posts in, when the conversations read so far have it. */
  conversation: string | null;
}) {
  /*
   * Its triggers, read only where the row uses them: an active goal's starts, and whether a goal
   * with an outcome can end, which they decide only once nothing else already makes it repeat.
   *
   * FOUND IN REVIEW: every goal row read its triggers, paused and completed ones too, so a list of
   * sixty goals sent sixty requests on every load, most of them for nothing the row said.
   */
  const triggersDecide =
    goal.status === "active" ||
    (Boolean(goal.successCriteria) &&
      goalCanEnd(goal, routines, undefined) &&
      !goal.endsWhenMet);
  const triggers = useGoalTriggers(goal.id, { enabled: triggersDecide });
  const Icon = STATUS[goal.status].icon;
  const starts =
    goal.status === "active"
      ? goalStarts(
          goal,
          triggers.data
            ?.filter((trigger) => trigger.enabled)
            .map((trigger) => `${KIND_LABEL[trigger.kind]} trigger`),
          routines,
          describeEvent,
        )
      : null;
  /* While its triggers are being read, the row is named by what it does rather than by nothing. */
  const when =
    goal.status === "paused"
      ? "Paused"
      : goal.status === "completed"
        ? goal.title
        : (starts ?? goal.title);
  const what = goal.status === "completed" ? "Completed" : goal.title;
  const line = details([
    botName,
    goal.status === "paused" ? "Nothing starts it until you resume it" : null,
    goal.status === "completed" ? null : postsIn(conversation),
  ]);
  return (
    <Item
      render={
        <Link
          params={{ goalId: goal.id }}
          search={agentId ? { agentId } : {}}
          to="/routines/goals/$goalId"
        />
      }
      size="sm"
    >
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent className={goal.status === "active" ? "" : "opacity-60"}>
        <ItemTitle>
          <span className="line-clamp-2">{when}</span>
        </ItemTitle>
        {when !== what ? (
          <ItemDescription className="line-clamp-2 text-foreground">
            {what}
          </ItemDescription>
        ) : null}
        {/* Until only on a goal that can end: one that repeats never reaches it. */}
        {goal.successCriteria &&
        goal.status !== "completed" &&
        goalCanEnd(goal, routines, triggers.data) ? (
          <ItemDescription className="line-clamp-1">
            Until: {goal.successCriteria}
          </ItemDescription>
        ) : null}
        {goal.progress && goal.status !== "completed" ? (
          <ItemDescription className="line-clamp-1">
            Progress: {goal.progress}
          </ItemDescription>
        ) : null}
        {line ? <ItemDescription>{line}</ItemDescription> : null}
      </ItemContent>
      <ItemActions>
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}

/**
 * A check-in's row: when (how often it looks) above what (what it looks for), then that it only
 * tells you, where it stands and where it posts. It opens the check-in's own page.
 */
function CheckInItem({
  setting,
  botName,
  blocked,
  agentId,
  conversation,
}: {
  setting: ProactiveSetting;
  /** Absent on one Bot's own list. */
  botName?: string;
  blocked: string | null;
  /** The Bot whose own list this is, so the page's back link returns to it. */
  agentId?: string;
  /** The title of the conversation it posts in, when the conversations read so far have it. */
  conversation: string | null;
}) {
  const last = lastCheckInLine(setting.lastRun);
  const outcome = setting.lastRun?.outcome;
  const line = details([
    botName,
    "Only tells you",
    checkInStatus(setting, blocked),
    postsIn(conversation),
  ]);
  return (
    <Item
      render={
        <Link
          params={{ checkInId: setting.id }}
          search={agentId ? { agentId } : {}}
          to="/routines/check-ins/$checkInId"
        />
      }
      size="sm"
    >
      <ItemMedia variant="icon">
        <IconRadar />
      </ItemMedia>
      <ItemContent className={setting.enabled ? "" : "opacity-60"}>
        <ItemTitle>{intervalLabel(setting.intervalMinutes)}</ItemTitle>
        <ItemDescription className="line-clamp-2 text-foreground">
          {setting.focus || setting.subject || "What it reads"}
        </ItemDescription>
        <ItemDescription>{line}</ItemDescription>
        {last && (outcome === "skipped" || outcome === "failed") ? (
          <ItemDescription
            className={outcome === "failed" ? "text-destructive" : undefined}
          >
            {last}
          </ItemDescription>
        ) : null}
      </ItemContent>
      <ItemActions>
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}

const EMPTY_BODY =
  "Like “every weekday at 9, send me yesterday's new leads”. Or ask a Bot in a conversation.";

/**
 * Every "when" a Bot has, in one list: its routines, its goals and its check-ins, each row read as
 * its pair, when above what (`lib/routines/merged.ts`). Built from the three reads each kind already
 * has, so each row opens and changes its own record the way it always did. Finished goals are listed
 * apart, under Done.
 *
 * Scoped by `agentId` on a Bot's page, unscoped on the every-Bot page. One query per kind either
 * way: each is owner-scoped and small, so the scope is a filter here.
 */
export function RoutinesList({
  agentId,
  embedded = false,
  onlyYours = false,
}: {
  /** Show only this Bot's. Absent shows all of the person's, each with its Bot. */
  agentId?: string;
  /** Where the page section's own top margin is somebody else's spacing. */
  embedded?: boolean;
  /** On a Bot shared with the person: say that only the ones they set up are listed. */
  onlyYours?: boolean;
} = {}) {
  const { rows, bots, pending, failed, routinesFailed } =
    useMergedRoutines(agentId);
  const blocked = useCheckInsBlocked();
  const showBot = agentId === undefined;
  /*
   * Where goals and check-ins post, from the conversations the sidebar has already read. Never
   * fetched here: a row whose conversation isn't among them just doesn't say where it posts.
   */
  const channels = useInfiniteQuery({
    ...channelListQueryOptions(),
    enabled: false,
  }).data;
  const titleOf = (conversationId: string) => {
    const channel = channels?.find((found) => found.id === conversationId);
    return channel ? conversationTitle(channel) || null : null;
  };
  const botName = (row: MergedRoutine) =>
    showBot ? (bots.get(row.agentId)?.name ?? "A Bot") : undefined;
  const listed = rows.filter((row) => !isDone(row));
  const done = rows.filter(isDone);

  const draw = (row: MergedRoutine) =>
    row.kind === "routine" ? (
      <RoutineItem
        agentId={agentId}
        botName={botName(row)}
        routine={row.routine}
      />
    ) : row.kind === "goal" ? (
      <GoalItem
        agentId={agentId}
        botName={botName(row)}
        conversation={titleOf(row.goal.conversationId)}
        goal={row.goal}
        routines={routinesFailed ? undefined : row.routines}
      />
    ) : (
      <CheckInItem
        agentId={agentId}
        blocked={blocked}
        botName={botName(row)}
        conversation={titleOf(row.checkIn.conversationId)}
        setting={row.checkIn}
      />
    );
  const drawRows = (some: MergedRoutine[]) => (
    <PageRows>
      {some.map((row, index) => (
        <Fragment key={`${row.kind}:${row.id}`}>
          {index > 0 ? <Separator /> : null}
          {draw(row)}
        </Fragment>
      ))}
    </PageRows>
  );

  return (
    <>
      <PageSection className={embedded ? "mt-0" : undefined}>
        {onlyYours ? (
          <p className="mb-3 text-muted-foreground text-sm">
            Only the ones you set up show here.
          </p>
        ) : null}
        {/* One read failing leaves the other two listed, and says which part is missing. */}
        {failed.length > 0 ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Couldn't load your {failed.join(" and ")}. Try again in a moment.
          </p>
        ) : null}

        {/*
         * Pending draws the list's shape, never the empty state, which would flash for the fetch. A
         * list that already has rows keeps them while it refetches: `isPending` is the first load only.
         */}
        {pending ? (
          <LoadingRows label="Loading when it works" />
        ) : listed.length === 0 ? (
          failed.length > 0 ? null : (
            <PageEmpty
              action={
                <NewRoutineButton
                  agentId={agentId}
                  label={agentId ? "Add" : undefined}
                  variant="outline"
                />
              }
              icon={IconClock}
              title={agentId ? "Nothing set yet" : "No routines yet"}
            >
              {EMPTY_BODY}
            </PageEmpty>
          )
        ) : (
          drawRows(listed)
        )}
      </PageSection>
      {!pending && done.length > 0 ? (
        <PageSection title="Done">{drawRows(done)}</PageSection>
      ) : null}
    </>
  );
}

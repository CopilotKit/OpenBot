import {
  IconChevronRight,
  IconClock,
  IconPlayerPause,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
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
import {
  SettingRow,
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
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { proactiveSettingsQueryOptions } from "@/lib/proactive";
import {
  type ResponsibilityRecord,
  responsibilitiesQueryOptions,
  triggersQueryOptions,
} from "@/lib/responsibilities";
import { describeEvent } from "@/lib/routines/events";
import {
  goalCanEnd,
  goalStarts,
  mergeRoutines,
  routineDoes,
} from "@/lib/routines/merged";
import {
  type RoutineRecord,
  routinesQueryOptions,
} from "@/lib/routines/queries";
import { NewRoutineButton } from "./new-routine-button";
import { lastRunLabel, scheduleWords } from "./routine-page";

type BotDirectory = Map<string, AgentProfile>;

/**
 * A scheduled routine's row, the same shape as a goal's and a check-in's: what it does (its title,
 * else `routineDoes`), when it starts, that it acts, and a last run worth knowing about. The
 * whole row links to its page, where it is switched, run, read back and deleted.
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
  const line = [
    botName,
    routine.enabled
      ? scheduleWords(routine)
      : "Paused. Nothing starts it until you turn it on",
    routine.enabled ? "Acts" : null,
  ]
    .filter(Boolean)
    .join(" · ");
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
        {/* The clamp is on the words: on the title itself it undid the gap before the kind label. */}
        <ItemTitle>
          <span className="line-clamp-2">{routine.title ?? does}</span>
          <span className="font-normal text-muted-foreground text-xs">
            Schedule
          </span>
        </ItemTitle>
        <ItemDescription>{line}</ItemDescription>
        {routine.title && routine.title !== does ? (
          <ItemDescription className="line-clamp-1">{does}</ItemDescription>
        ) : null}
        {/* Only a last run worth stopping for: a quiet success is in the details. */}
        {outcome === "failed" || outcome === "skipped" ? (
          <ItemDescription className={lastRun.className}>
            {lastRun.text}
          </ItemDescription>
        ) : null}
        {routine.channel.gone ? (
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
 * A goal's row: what it is (its title), when it starts (its schedules, events and triggers, or
 * when you ask), that it acts, and until when (its outcome). Its status and progress are on the
 * row. It opens the goal's own page, where its schedules are switched and deleted too: a link, so
 * it can be opened in a new tab and the back button returns to this list.
 *
 * A chevron rather than a Switch, although pausing is binary: the row opens a page, and a Switch
 * inside a row that is itself a link would be a control nested in a control.
 */
function GoalItem({
  goal,
  routines,
  botName,
  agentId,
}: {
  goal: ResponsibilityRecord;
  /** Undefined when the routines read failed: its starts are then not known. */
  routines: readonly RoutineRecord[] | undefined;
  /** Absent on one Bot's own list. */
  botName?: string;
  /** The Bot whose own list this is, so the goal's back link returns to it. */
  agentId?: string;
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
  const triggers = useQuery({
    ...triggersQueryOptions(goal.id),
    enabled: triggersDecide,
  });
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
  const line = [
    botName,
    goal.status === "paused"
      ? "Paused. Nothing starts it until you resume it"
      : goal.status === "completed"
        ? "Completed"
        : starts,
    goal.status === "active" ? "Acts" : null,
  ]
    .filter(Boolean)
    .join(" · ");
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
          {goal.title}
          <span className="font-normal text-muted-foreground text-xs">
            Goal
          </span>
        </ItemTitle>
        <ItemDescription>{line}</ItemDescription>
        {/* Until only on a goal that can end: one that repeats never reaches it. */}
        {goal.successCriteria && goalCanEnd(goal, routines, triggers.data) ? (
          <ItemDescription className="line-clamp-1">
            Until: {goal.successCriteria}
          </ItemDescription>
        ) : null}
        {goal.progress && goal.status !== "completed" ? (
          <ItemDescription className="line-clamp-1">
            Progress: {goal.progress}
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
 * Every routine a Bot has, in one list: its routines, its goals, and its check-ins, each row the
 * same four-part sentence (`lib/routines/merged.ts`). Built from the three reads each kind already
 * has, so each row opens and changes its own record the way it always did.
 *
 * Scoped by `agentId` on a Bot's Routines page, unscoped on Routines. One query per kind
 * either way: each is owner-scoped and small, so the scope is a filter here.
 */
export function RoutinesList({
  agentId,
  embedded = false,
}: {
  /** Show only this Bot's. Absent shows all of the person's, each with its Bot. */
  agentId?: string;
  /** Where the page section's own top margin is somebody else's spacing. */
  embedded?: boolean;
} = {}) {
  const routines = useQuery(routinesQueryOptions());
  const goals = useQuery(responsibilitiesQueryOptions());
  const checkIns = useQuery(proactiveSettingsQueryOptions());
  const blocked = useCheckInsBlocked();
  /* Names and faces for each row's Bot, hidden Bots included: a routine outlives hiding its Bot. */
  const shownBots = useQuery(agentListQueryOptions());
  const hiddenBots = useQuery({
    ...agentListQueryOptions(true),
    enabled: agentId === undefined,
  });
  const bots: BotDirectory = new Map(
    [...(shownBots.data ?? []), ...(hiddenBots.data ?? [])].map((bot) => [
      bot.id,
      bot,
    ]),
  );

  const rows = mergeRoutines({
    routines: routines.data?.routines ?? [],
    goals: goals.data ?? [],
    checkIns: checkIns.data ?? [],
    agentId,
  });
  const showBot = agentId === undefined;
  const pending = routines.isPending || goals.isPending || checkIns.isPending;
  const failed = [
    routines.error ? "routines" : null,
    goals.error ? "goals" : null,
    checkIns.error ? "check-ins" : null,
  ].filter((name): name is string => name !== null);

  return (
    <PageSection className={embedded ? "mt-0" : undefined}>
      {/* One read failing leaves the other two listed, and says which part is missing. */}
      {failed.length > 0 ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          Couldn't load your {failed.join(" and ")}. Reload the page.
        </p>
      ) : null}

      {/*
       * Pending draws the list's shape, never the empty state, which would flash for the fetch. A
       * list that already has rows keeps them while it refetches: `isPending` is the first load only.
       */}
      {pending ? (
        <LoadingRows label="Loading your routines" />
      ) : rows.length === 0 ? (
        failed.length > 0 ? null : (
          <PageEmpty
            action={<NewRoutineButton agentId={agentId} variant="outline" />}
            icon={IconClock}
            title={agentId ? "No routines for this Bot yet" : "No routines yet"}
          >
            {EMPTY_BODY}
          </PageEmpty>
        )
      ) : (
        <PageRows>
          {rows.map((row, index) => (
            <Fragment key={`${row.kind}:${row.id}`}>
              {index > 0 ? <Separator /> : null}
              {row.kind === "routine" ? (
                <RoutineItem
                  botName={
                    showBot
                      ? (bots.get(row.agentId)?.name ?? "A Bot")
                      : undefined
                  }
                  agentId={agentId}
                  routine={row.routine}
                />
              ) : row.kind === "goal" ? (
                <GoalItem
                  botName={
                    showBot
                      ? (bots.get(row.agentId)?.name ?? "A Bot")
                      : undefined
                  }
                  agentId={agentId}
                  goal={row.goal}
                  routines={routines.error ? undefined : row.routines}
                />
              ) : (
                <SettingRow
                  agentId={agentId}
                  blocked={blocked}
                  botName={bots.get(row.agentId)?.name ?? "A Bot"}
                  label="Check-in"
                  setting={row.checkIn}
                  showBot={showBot}
                />
              )}
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}

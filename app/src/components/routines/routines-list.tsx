import {
  IconChevronRight,
  IconClock,
  IconPlayerPause,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { LoadingRows } from "@/components/layout/loading-rows";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import {
  ResponsibilityDialog,
  STATUS,
} from "@/components/responsibilities/responsibility-dialog";
import { KIND_LABEL } from "@/components/responsibilities/triggers";
import {
  SettingRow,
  useCheckInsBlocked,
} from "@/components/suggestions/proactive-panel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { describeEvent } from "@/lib/routines/events";
import { proactiveSettingsQueryOptions } from "@/lib/proactive";
import { relativeTime } from "@/lib/relative-time";
import {
  type ResponsibilityRecord,
  responsibilitiesQueryOptions,
  triggersQueryOptions,
} from "@/lib/responsibilities";
import {
  goalStarts,
  type MergedRoutine,
  mergeRoutines,
} from "@/lib/routines/merged";
import { deleteRoutineMutationOptions } from "@/lib/routines/mutations";
import {
  nothingIsFiring,
  type RoutineRecord,
  routinesQueryOptions,
  stoppedRoutinesGuidance,
} from "@/lib/routines/queries";
import { queryClient } from "@/query-client";
import { NewRoutineButton } from "./new-routine-button";
import { lastRunLabel, RoutineDialog, scheduleWords } from "./routine-dialog";

type BotDirectory = Map<string, AgentProfile>;

/**
 * A scheduled routine's row, the same shape as a goal's and a check-in's: what it does (its title,
 * else its instruction), when it starts, that it acts, and a last run worth knowing about. The
 * whole row opens its details, where it is switched, run, read back and deleted.
 */
function RoutineItem({
  routine,
  botName,
  onOpen,
}: {
  routine: RoutineRecord;
  /** Absent on one Bot's own list. */
  botName?: string;
  onOpen: () => void;
}) {
  const lastRun = lastRunLabel(routine.lastRun);
  const outcome = routine.lastRun?.status;
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
    <Item render={<button onClick={onOpen} type="button" />} size="sm">
      <ItemMedia variant="icon">
        {routine.enabled ? <IconClock /> : <IconPlayerPause />}
      </ItemMedia>
      <ItemContent className={routine.enabled ? "" : "opacity-60"}>
        <ItemTitle className="line-clamp-2">
          {routine.title ?? routine.instruction}
          <span className="font-normal text-muted-foreground text-xs">
            Schedule
          </span>
        </ItemTitle>
        <ItemDescription>{line}</ItemDescription>
        {routine.title ? (
          <ItemDescription className="line-clamp-1">
            {routine.instruction}
          </ItemDescription>
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
 * row. It opens the goal's dialog, where its schedules are switched and deleted too.
 *
 * A chevron rather than a Switch, although pausing is binary: the row opens a dialog, and a Switch
 * inside a row that is itself a button would be a control nested in a control.
 */
function GoalItem({
  goal,
  routines,
  botName,
  onOpen,
}: {
  goal: ResponsibilityRecord;
  /** Undefined when the routines read failed: its starts are then not known. */
  routines: readonly RoutineRecord[] | undefined;
  /** Absent on one Bot's own list. */
  botName?: string;
  onOpen: () => void;
}) {
  const triggers = useQuery(triggersQueryOptions(goal.id));
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
    <Item render={<button onClick={onOpen} type="button" />} size="sm">
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
        {goal.successCriteria ? (
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
  const deleteRoutine = useMutation(deleteRoutineMutationOptions(queryClient));
  /** The scheduled routine whose details are open. Looked up from the query, as a goal's is. */
  const [routineId, setRoutineId] = useState<string | null>(null);
  /** The routine a delete is being confirmed for, or null. Its own dialog rather than one per row. */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  /** The goal whose dialog is open. Looked up from the query, so it follows every refetch. */
  const [goalId, setGoalId] = useState<string | null>(null);

  const rows = mergeRoutines({
    routines: routines.data?.routines ?? [],
    goals: goals.data ?? [],
    checkIns: checkIns.data ?? [],
    agentId,
  });
  const showBot = agentId === undefined;
  const sweep = routines.data?.sweep;
  // Every routine, including the ones folded into a goal's row: a goal on a schedule is a
  // schedule the sweep must fire too.
  const scheduled = (routines.data?.routines ?? []).filter(
    (routine) => agentId === undefined || routine.agentId === agentId,
  ).length;
  const noWorker = nothingIsFiring(sweep, scheduled);
  const edition = useQuery(deploymentCapabilitiesQueryOptions()).data?.edition;
  const confirming =
    routines.data?.routines.find((row) => row.id === confirmingId) ?? null;
  // Gone once it is deleted, which closes its details with it.
  const openRoutine =
    routines.data?.routines.find((row) => row.id === routineId) ?? null;
  const openGoal = rows.find(
    (row): row is Extract<MergedRoutine, { kind: "goal" }> =>
      row.kind === "goal" && row.id === goalId,
  );
  const pending = routines.isPending || goals.isPending || checkIns.isPending;
  const failed = [
    routines.error ? "routines" : null,
    goals.error ? "goals" : null,
    checkIns.error ? "check-ins" : null,
  ].filter((name): name is string => name !== null);

  return (
    <PageSection className={embedded ? "mt-0" : undefined}>
      {/* A fact about OpenBot rather than a row to act on, so said as a sentence. */}
      {noWorker ? (
        <p className="mt-4 text-muted-foreground text-sm" role="alert">
          <span className="font-medium text-amber-600 dark:text-amber-500">
            Routines aren't running.
          </span>{" "}
          {stoppedRoutinesGuidance(
            sweep?.lastSweptAt ? relativeTime(sweep.lastSweptAt) : null,
            edition,
          )}
        </p>
      ) : null}

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
                  onOpen={() => setRoutineId(row.id)}
                  routine={row.routine}
                />
              ) : row.kind === "goal" ? (
                <GoalItem
                  botName={
                    showBot
                      ? (bots.get(row.agentId)?.name ?? "A Bot")
                      : undefined
                  }
                  goal={row.goal}
                  onOpen={() => setGoalId(row.id)}
                  routines={routines.error ? undefined : row.routines}
                />
              ) : (
                <SettingRow
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

      {openRoutine ? (
        <RoutineDialog
          bot={
            showBot
              ? {
                  id: openRoutine.agentId,
                  name: bots.get(openRoutine.agentId)?.name ?? "A Bot",
                }
              : undefined
          }
          key={openRoutine.id}
          onClose={() => setRoutineId(null)}
          onDelete={() => {
            deleteRoutine.reset();
            setConfirmingId(openRoutine.id);
          }}
          routine={openRoutine}
        />
      ) : null}

      {openGoal ? (
        <ResponsibilityDialog
          goal={openGoal.goal}
          key={openGoal.id}
          onClose={() => setGoalId(null)}
          routines={openGoal.routines}
        />
      ) : null}

      {/*
       * One dialog for the whole list rather than one per row, keyed by which routine is being
       * confirmed. It names the schedule, the word a person reads first on the row.
       */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirmingId(null);
        }}
        open={confirming !== null}
      >
        {/* The heavier backdrop, forced: opened from a Bot's dialog this stacks over it, and Base
            UI would otherwise render a nested dialog with no backdrop at all. */}
        <DialogContent overlayClassName="bg-black/20 supports-backdrop-filter:backdrop-blur-sm">
          <DialogHeader>
            <DialogTitle>Delete "{confirming?.schedule}"?</DialogTitle>
            <DialogDescription>
              This routine stops for good. You can't undo this.
            </DialogDescription>
          </DialogHeader>
          {deleteRoutine.error ? (
            <DialogBody className="mt-4">
              <p className="text-destructive text-sm" role="alert">
                {deleteRoutine.error.message}
              </p>
            </DialogBody>
          ) : null}
          <DialogFooter className="mt-4">
            <Button
              onClick={() => setConfirmingId(null)}
              size="sm"
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={deleteRoutine.isPending}
              onClick={() => {
                if (!confirmingId) return;
                deleteRoutine.mutate(confirmingId, {
                  onSuccess: () => setConfirmingId(null),
                });
              }}
              size="sm"
              type="button"
              variant="destructive"
            >
              {deleteRoutine.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageSection>
  );
}

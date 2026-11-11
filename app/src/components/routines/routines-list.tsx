import {
  IconChevronRight,
  IconClock,
  IconHistory,
  IconPlayerPause,
  IconPlayerPlay,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import {
  ResponsibilityDialog,
  SOURCE_LABEL,
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
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { proactiveSettingsQueryOptions } from "@/lib/proactive";
import { relativeTime } from "@/lib/relative-time";
import {
  type ResponsibilityRecord,
  responsibilitiesQueryOptions,
  triggersQueryOptions,
} from "@/lib/responsibilities";
import {
  goalCanEnd,
  goalStarts,
  type MergedRoutine,
  mergeRoutines,
} from "@/lib/routines/merged";
import {
  deleteRoutineMutationOptions,
  runRoutineNowMutationOptions,
  setRoutineEnabledMutationOptions,
} from "@/lib/routines/mutations";
import {
  nothingIsFiring,
  type RoutineRecord,
  routinesQueryOptions,
} from "@/lib/routines/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import { NewRoutineButton } from "./new-routine-button";
import { Chip, LastRunChip, RoutineRuns } from "./routine-runs";

type BotDirectory = Map<string, AgentProfile>;

/** Whose a row is, on the every-Bot list: a chip with the Bot's face and name, to its Routines. */
function BotChip({ agentId, bots }: { agentId: string; bots: BotDirectory }) {
  const bot = bots.get(agentId);
  return (
    <Link params={{ agentId }} to="/bots/$agentId/routines">
      <Chip className="text-foreground transition-colors hover:bg-muted">
        {bot ? (
          <span aria-hidden="true" className="contents">
            <AbstractAvatar name={bot.name} seed={bot.avatarSeed} size={14} />
          </span>
        ) : null}
        {bot?.name ?? "A Bot"}
      </Chip>
    </Link>
  );
}

/**
 * A routine's row: what it does (its title, else its instruction), when it starts (its schedule),
 * and that it acts. A switch to pause it, Run now, its history, and Delete, as the row always had.
 */
function RoutineItem({
  routine,
  showBot,
  bots,
  historyOpen,
  onToggleHistory,
  onDelete,
}: {
  routine: RoutineRecord;
  showBot: boolean;
  bots: BotDirectory;
  historyOpen: boolean;
  onToggleHistory: (open: boolean) => void;
  onDelete: () => void;
}) {
  const setEnabled = useMutation(setRoutineEnabledMutationOptions(queryClient));
  const runNow = useMutation(runRoutineNowMutationOptions(queryClient));
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        {routine.enabled ? <IconClock /> : <IconPlayerPause />}
      </ItemMedia>
      {/* Paused reads at a glance: the content dims, and a chip below says the word. */}
      <ItemContent className={routine.enabled ? "" : "opacity-60"}>
        {/*
         * What it does heads the row, and when it starts takes a line of its own under it, so a
         * narrow window never squeezes the name to fit the schedule.
         */}
        <ItemTitle className="line-clamp-2">
          {routine.title ?? routine.instruction}
        </ItemTitle>
        <ItemDescription>
          {routine.schedule} · {routine.timezone} · Acts
        </ItemDescription>
        {routine.title ? (
          <ItemDescription>{routine.instruction}</ItemDescription>
        ) : null}
      </ItemContent>
      <ItemActions>
        {/*
         * Binary and immediate: it takes effect when switched, there is no save. Disabled only
         * while its own write is in flight, so switching one routine does not freeze the rest.
         */}
        <Switch
          aria-label={`Enable the routine scheduled ${routine.schedule}`}
          checked={routine.enabled}
          disabled={setEnabled.isPending}
          onCheckedChange={(next) =>
            setEnabled.mutate({ id: routine.id, enabled: next })
          }
        />
      </ItemActions>
      {/* Two sets, where it stands and what can be done to it, so they wrap onto a line of their
          own rather than crowding the title. */}
      <ItemFooter className="flex-wrap">
        <div
          className={cn(
            "flex flex-wrap items-center gap-1.5",
            routine.enabled ? "" : "opacity-60",
          )}
        >
          {showBot ? <BotChip agentId={routine.agentId} bots={bots} /> : null}
          {routine.channel.gone ? (
            <Chip className="border-destructive/40 text-destructive">
              Conversation deleted
            </Chip>
          ) : (
            // Where it posts is a place, so the chip goes there.
            <Link
              params={{ channelId: routine.channel.id }}
              to="/channel/$channelId"
            >
              <Chip className="text-muted-foreground transition-colors hover:text-foreground">
                {routine.channel.title ?? "Untitled conversation"}
              </Chip>
            </Link>
          )}
          <LastRunChip lastRun={routine.lastRun} />
          {/*
           * Enabled only: the store recomputes nextRunAt on cron/timezone change or re-enable, so a
           * disabled routine's stamp is frozen in the past. Paused takes its place, so the switch's
           * state has a word as well as a position.
           */}
          {!routine.enabled ? (
            <Chip className="text-muted-foreground">Paused</Chip>
          ) : new Date(routine.nextRunAt).getTime() <= Date.now() ? (
            /*
             * A stamp in the past is a firing the sweep has not picked up, and "Next 5 hours ago"
             * is nonsense. Said as what it is: due, and visibly waiting.
             */
            <Chip className="text-amber-600 dark:text-amber-500">
              <span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
              Due
            </Chip>
          ) : (
            <Chip className="text-muted-foreground">
              Next {relativeTime(routine.nextRunAt)}
            </Chip>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/*
           * Run now is the Test button, and it does real work: the Bot carries out the instruction
           * in the channel right away. Offered only while the routine is on.
           */}
          <Button
            aria-label={`Run the routine scheduled ${routine.schedule} now`}
            disabled={!routine.enabled || runNow.isPending}
            onClick={() =>
              runNow.mutate(routine.id, {
                onSuccess: () => onToggleHistory(true),
              })
            }
            size="sm"
            title={
              routine.enabled
                ? "Runs it now, for real. The Bot does the work and posts in the conversation."
                : "This routine is paused. Turn it on first."
            }
            type="button"
            variant="outline"
          >
            <IconPlayerPlay />
            Run now
          </Button>
          <Button
            aria-expanded={historyOpen}
            aria-label={`Run history for the routine scheduled ${routine.schedule}`}
            onClick={() => onToggleHistory(!historyOpen)}
            size="sm"
            type="button"
            variant="ghost"
          >
            <IconHistory />
            History
          </Button>
          <Button
            aria-label={`Delete the routine scheduled ${routine.schedule}`}
            onClick={onDelete}
            size="sm"
            type="button"
            variant="ghost"
          >
            <IconTrash />
            Delete
          </Button>
        </div>
      </ItemFooter>
      {setEnabled.error || runNow.error ? (
        <p className="basis-full text-destructive text-sm" role="alert">
          {setEnabled.error?.message ?? runNow.error?.message}
        </p>
      ) : null}
      {historyOpen ? (
        <div className="basis-full border-border border-t pt-2">
          <RoutineRuns routine={routine} />
        </div>
      ) : null}
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
          (subscription) =>
            `${SOURCE_LABEL[subscription.source]} ${subscription.eventType}`,
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
  const deleteRoutine = useMutation(deleteRoutineMutationOptions(queryClient));
  /** Which routine's run history is open. One at a time keeps the list scannable. */
  const [historyId, setHistoryId] = useState<string | null>(null);
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
  const confirming =
    routines.data?.routines.find((row) => row.id === confirmingId) ?? null;
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
          {sweep?.lastSweptAt
            ? `OpenBot last checked them ${relativeTime(sweep.lastSweptAt)}. None will run until it starts again. Ask an admin if this keeps happening.`
            : "OpenBot hasn't started running routines yet, so none of these will run. Ask an admin to set this up."}
        </p>
      ) : null}

      {/* One read failing leaves the other two listed, and says which part is missing. */}
      {failed.length > 0 ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          Couldn't load your {failed.join(" and ")}. Reload the page.
        </p>
      ) : null}

      {/* Pending renders nothing: the empty state would otherwise flash for the fetch. */}
      {pending ? null : rows.length === 0 ? (
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
                  bots={bots}
                  historyOpen={historyId === row.id}
                  onDelete={() => {
                    deleteRoutine.reset();
                    setConfirmingId(row.id);
                  }}
                  onToggleHistory={(open) => setHistoryId(open ? row.id : null)}
                  routine={row.routine}
                  showBot={showBot}
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

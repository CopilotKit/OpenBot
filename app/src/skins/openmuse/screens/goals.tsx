import {
  IconChevronRight,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconSquare,
  IconSquareCheckFilled,
  IconTargetArrow,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { NewResponsibilityDialog } from "@/components/responsibilities/new-responsibility-dialog";
import { ResponsibilityDialog } from "@/components/responsibilities/responsibility-dialog";
import { Item } from "@/components/ui/item";
import { relativeTime } from "@/lib/relative-time";
import {
  type ResponsibilityRecord,
  responsibilitiesQueryOptions,
} from "@/lib/responsibilities";
import {
  deleteRoutineMutationOptions,
  runRoutineNowMutationOptions,
  setRoutineEnabledMutationOptions,
} from "@/lib/routines/mutations";
import {
  nothingIsFiring,
  type RoutineRecord,
  routineRunsQueryOptions,
  routinesQueryOptions,
} from "@/lib/routines/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import { useMuse } from "../context";
import {
  Divider,
  ErrorNotice,
  MuseButton,
  MuseChip,
  MuseScreen,
  MuseSheet,
  museText,
  StatusDot,
} from "../ui";

const SHOWN = 3;

/**
 * Goals: what the centre Bot keeps doing for the person. OpenMuse's "Tracking" is OpenBot's routines
 * — standing work on a schedule — and its "Goals" are OpenBot's responsibilities, which OpenBot
 * itself titles Goals on a Bot's page.
 */
export function GoalsScreen() {
  const { bot } = useMuse();
  const routines = useQuery(routinesQueryOptions());
  const goals = useQuery(responsibilitiesQueryOptions());
  const [showAll, setShowAll] = useState(false);
  const [routineId, setRoutineId] = useState<string | null>(null);
  const [goalId, setGoalId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const standing = (routines.data?.routines ?? []).filter(
    (routine) => routine.agentId === bot?.id,
  );
  const mine = (goals.data ?? []).filter((goal) => goal.agentId === bot?.id);
  const routine = standing.find((row) => row.id === routineId);
  const goal = mine.find((row) => row.id === goalId);
  const stalled = nothingIsFiring(routines.data?.sweep, standing.length);

  return (
    <MuseScreen title="Goals">
      <div className="flex flex-col gap-[22px]">
        <section className="flex flex-col gap-2">
          <div className="mb-[5px] flex items-center gap-2.5">
            <StatusDot tone="green" />
            <h2
              className={cn(
                museText.heading,
                "text-[var(--openmuse-green-text)]",
              )}
            >
              Routines
            </h2>
          </div>
          {stalled ? (
            <p className={museText.small} role="alert">
              Routines aren't running right now. None will run until OpenBot
              starts them again.
            </p>
          ) : null}
          {routines.isPending ? null : routines.error ? (
            <ErrorNotice error="Couldn't load your routines." />
          ) : standing.length === 0 ? (
            <p className={cn(museText.muted, "py-2.5")}>
              Ask {bot?.name ?? "your Bot"} for something on a schedule, like
              “every weekday at 9, send me the headlines”.
            </p>
          ) : (
            <>
              {(showAll ? standing : standing.slice(0, SHOWN)).map((row) => (
                <GoalRow
                  done={false}
                  key={row.id}
                  label={`Open routine: ${row.instruction}`}
                  onOpen={() => setRoutineId(row.id)}
                  subtitle={
                    row.enabled
                      ? `${row.schedule} · next ${relativeTime(row.nextRunAt)}`
                      : `${row.schedule} · paused`
                  }
                  title={row.instruction}
                />
              ))}
              {standing.length > SHOWN ? (
                <MuseButton
                  className="self-start"
                  onClick={() => setShowAll(!showAll)}
                  small
                >
                  {showAll
                    ? "Show less"
                    : `Show ${standing.length - SHOWN} more`}
                </MuseButton>
              ) : null}
            </>
          )}
        </section>
        <Divider />
        <section className="flex flex-col gap-2">
          <div className="mb-[5px] flex items-center gap-2.5">
            <StatusDot tone="blue" />
            <h2
              className={cn(museText.heading, "text-[var(--openmuse-accent)]")}
            >
              Goals
            </h2>
          </div>
          {goals.isPending ? null : goals.error ? (
            <ErrorNotice error={goals.error.message} />
          ) : mine.length === 0 ? (
            <p className={cn(museText.muted, "py-2.5")}>
              Big plans start with one small step.
            </p>
          ) : (
            mine.map((row) => (
              <GoalRow
                done={row.status === "completed"}
                key={row.id}
                label={`Open goal: ${row.title}`}
                onOpen={() => setGoalId(row.id)}
                subtitle={goalSubtitle(row)}
                title={row.title}
              />
            ))
          )}
        </section>
        <Divider />
        <section className="flex flex-col gap-2">
          <h2 className={museText.heading}>Create a goal</h2>
          <Item
            className="min-h-[38px] flex-nowrap gap-3 rounded-none border-0 px-0 py-1.5 text-left hover:bg-transparent"
            render={
              <button
                aria-label={`Give ${bot?.name ?? "your Bot"} a goal`}
                disabled={!bot}
                onClick={() => setCreating(true)}
                type="button"
              />
            }
          >
            <IconTargetArrow
              aria-hidden="true"
              className="size-[23px] shrink-0 text-[var(--openmuse-quiet)]"
              stroke={1.6}
            />
            <span
              className={cn(
                museText.body,
                "flex-1 text-[var(--openmuse-quiet-text)]",
              )}
            >
              New goal
            </span>
            <IconPlus
              aria-hidden="true"
              className="size-[18px] shrink-0 text-[var(--openmuse-quiet)]"
            />
          </Item>
        </section>
      </div>
      {routine ? (
        <RoutineSheet onClose={() => setRoutineId(null)} routine={routine} />
      ) : null}
      {goal ? (
        <ResponsibilityDialog
          goal={goal}
          key={goal.id}
          onClose={() => setGoalId(null)}
        />
      ) : null}
      {creating && bot ? (
        <NewResponsibilityDialog
          agentId={bot.id}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </MuseScreen>
  );
}

function goalSubtitle(goal: ResponsibilityRecord): string {
  if (goal.status === "paused") return "Paused";
  if (goal.status === "completed") return goal.lastResult || "Completed";
  return goal.progress || goal.instruction || "Active";
}

function GoalRow({
  title,
  subtitle,
  done,
  label,
  onOpen,
}: {
  title: string;
  subtitle: string;
  done: boolean;
  label: string;
  onOpen: () => void;
}) {
  const Box = done ? IconSquareCheckFilled : IconSquare;
  return (
    <Item
      className="flex-nowrap gap-3 rounded-none border-0 px-0 py-[13px] text-left hover:bg-transparent"
      render={<button aria-label={label} onClick={onOpen} type="button" />}
    >
      <Box
        aria-hidden="true"
        className={cn(
          "size-[21px] shrink-0",
          done
            ? "text-[var(--openmuse-green-dot)]"
            : "text-[var(--openmuse-quiet)]",
        )}
        stroke={1.6}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className={cn(museText.body, "line-clamp-2")}>{title}</span>
        <span className={cn(museText.muted, "line-clamp-2")}>{subtitle}</span>
      </span>
      <IconChevronRight
        aria-hidden="true"
        className="size-[18px] shrink-0 text-[var(--openmuse-quiet)]"
      />
    </Item>
  );
}

/** One routine, as OpenMuse's tracking card: what it does, when, and the controls OpenBot offers. */
function RoutineSheet({
  routine,
  onClose,
}: {
  routine: RoutineRecord;
  onClose: () => void;
}) {
  const setEnabled = useMutation(setRoutineEnabledMutationOptions(queryClient));
  const runNow = useMutation(runRoutineNowMutationOptions(queryClient));
  const remove = useMutation(deleteRoutineMutationOptions(queryClient));
  const runs = useQuery(routineRunsQueryOptions(routine.id));
  const [confirming, setConfirming] = useState(false);
  const busy = setEnabled.isPending || runNow.isPending || remove.isPending;
  const error =
    setEnabled.error?.message ?? runNow.error?.message ?? remove.error?.message;

  return (
    <MuseSheet
      onClose={onClose}
      subtitle={`${routine.schedule} · ${routine.timezone}`}
      title="Routine"
    >
      <div className="flex flex-col gap-[13px] rounded-[23px] bg-card p-5">
        <div className="flex items-start justify-between gap-3">
          <p className={cn(museText.heading, "flex-1")}>
            {routine.instruction}
          </p>
          <MuseChip tint={routine.enabled ? "green" : "plain"}>
            {routine.enabled ? "Active" : "Paused"}
          </MuseChip>
        </div>
        <p className={museText.small}>
          Posts in{" "}
          {routine.channel.gone ? (
            "a conversation that was deleted"
          ) : (
            <Link
              className="font-semibold text-foreground underline-offset-2 hover:underline"
              onClick={onClose}
              params={{ channelId: routine.channel.id }}
              to="/channel/$channelId"
            >
              {routine.channel.name ?? "its conversation"}
            </Link>
          )}
        </p>
        <p className={museText.small}>
          {routine.lastRun?.at
            ? `Last run: ${relativeTime(routine.lastRun.at)}${routine.lastRun.status ? ` · ${routine.lastRun.status}` : ""}`
            : "Hasn't run yet"}
          {routine.enabled
            ? `\nNext run: ${relativeTime(routine.nextRunAt)}`
            : ""}
        </p>
        <ErrorNotice error={error} />
        <div className="flex flex-wrap gap-2">
          <MuseButton
            disabled={busy}
            icon={routine.enabled ? IconPlayerPause : IconPlayerPlay}
            onClick={() =>
              setEnabled.mutate({ id: routine.id, enabled: !routine.enabled })
            }
            small
          >
            {routine.enabled ? "Pause" : "Resume"}
          </MuseButton>
          <MuseButton
            disabled={busy || !routine.enabled}
            onClick={() => runNow.mutate(routine.id)}
            small
          >
            Run now
          </MuseButton>
          <MuseButton
            danger
            disabled={busy}
            icon={IconTrash}
            onClick={() =>
              confirming
                ? remove.mutate(routine.id, { onSuccess: onClose })
                : setConfirming(true)
            }
            small
          >
            {confirming ? "Remove for good" : "Stop this routine"}
          </MuseButton>
        </div>
        {runs.data?.length ? (
          <div className="mt-1 flex flex-col gap-1.5">
            <p className="font-semibold text-[11px] text-foreground">
              Recent runs
            </p>
            {runs.data.slice(0, 5).map((run) => (
              <p className={museText.small} key={run.id}>
                {relativeTime(run.startedAt)} · {run.status}
                {run.error ? ` · ${run.error}` : ""}
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </MuseSheet>
  );
}

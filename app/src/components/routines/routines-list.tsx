import { IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
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
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  deleteRoutineMutationOptions,
  setRoutineEnabledMutationOptions,
} from "@/lib/routines/mutations";
import {
  type RoutineRecord,
  routinesQueryOptions,
} from "@/lib/routines/queries";
import { queryClient } from "@/query-client";

const RELATIVE_UNITS = [
  { limit: 60_000, divisor: 1_000, unit: "second" },
  { limit: 3_600_000, divisor: 60_000, unit: "minute" },
  { limit: 86_400_000, divisor: 3_600_000, unit: "hour" },
  { limit: 604_800_000, divisor: 86_400_000, unit: "day" },
  { limit: Number.POSITIVE_INFINITY, divisor: 604_800_000, unit: "week" },
] as const;

const relativeFormat = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

/** Locale-aware relative timestamp, e.g. "2 minutes ago". */
function relativeTime(iso: string): string {
  const elapsed = Date.now() - new Date(iso).getTime();
  const scale =
    RELATIVE_UNITS.find(({ limit }) => Math.abs(elapsed) < limit) ??
    RELATIVE_UNITS[RELATIVE_UNITS.length - 1];
  return relativeFormat.format(
    -Math.round(elapsed / scale.divisor),
    scale.unit,
  );
}

/**
 * What the last-run cell says, and in what tone.
 *
 * `lastRun === null` and `lastRun.status === null` are different facts, and saying the wrong one
 * invents news: the first is "this routine has never finished a run," the second is "one is open
 * right now" — which is also what a run stuck open after repeated dispatch failures looks like from
 * here. Neither is a failure, so neither gets the destructive tone; only `status: "failed"` does.
 */
function lastRunLabel(lastRun: RoutineRecord["lastRun"]): {
  text: string;
  className: string;
} {
  if (lastRun === null) {
    return { text: "Never run yet", className: "text-muted-foreground" };
  }
  if (lastRun.status === null) {
    return { text: "Running…", className: "text-muted-foreground" };
  }
  const when = lastRun.at ? relativeTime(lastRun.at) : "recently";
  if (lastRun.status === "failed") {
    return { text: `Failed ${when}`, className: "text-destructive" };
  }
  if (lastRun.status === "skipped") {
    return {
      text: `Skipped ${when}`,
      className: "text-amber-600 dark:text-amber-500",
    };
  }
  if (lastRun.status === "succeeded") {
    return { text: `Ran ${when}`, className: "text-muted-foreground" };
  }
  // An outcome this DTO doesn't recognise degrades to a neutral label rather than an invented
  // success — the contract typing (`RoutineRunOutcome | null`) makes a fourth outcome a build-time
  // error, but this is the runtime fallback if that ever slips through.
  return { text: `Finished ${when}`, className: "text-muted-foreground" };
}

/**
 * The one list the Routines page shows: every standing instruction the signed-in person owns, a
 * switch to stop one taking effect, and a delete that ends it for good.
 */
export function RoutinesList() {
  const routines = useQuery(routinesQueryOptions());
  const setEnabled = useMutation(setRoutineEnabledMutationOptions(queryClient));
  const deleteRoutine = useMutation(deleteRoutineMutationOptions(queryClient));
  /** The routine a delete is being confirmed for, or null. Its own dialog rather than one per row. */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const rows = routines.data ?? [];
  const confirming = rows.find((row) => row.id === confirmingId) ?? null;

  return (
    <PageSection>
      {setEnabled.error ? (
        <p className="text-destructive text-sm" role="alert">
          {setEnabled.error.message}
        </p>
      ) : null}

      {/* Pending renders nothing: the empty-state sentence would otherwise flash for the fetch. */}
      {routines.isPending ? null : routines.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          Your routines could not be loaded.
        </p>
      ) : rows.length === 0 ? (
        <PageEmpty>
          Nothing scheduled. Ask a Bot — "every weekday at 9, …" — and it will
          appear here.
        </PageEmpty>
      ) : (
        <PageRows>
          {rows.map((routine, index) => {
            const { text: lastRunText, className: lastRunClassName } =
              lastRunLabel(routine.lastRun);
            return (
              <div key={routine.id}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle>
                      {routine.schedule}
                      <span className="font-normal text-muted-foreground text-xs">
                        {routine.timezone}
                      </span>
                    </ItemTitle>
                    <ItemDescription className="line-clamp-3">
                      {routine.instruction}
                    </ItemDescription>
                    {/* A set, so it wraps onto its own line rather than crowding the title. */}
                    <ItemFooter>
                      <div className="flex flex-wrap items-center gap-3 text-xs">
                        <span
                          className={
                            routine.channel.gone
                              ? "text-destructive"
                              : "text-muted-foreground"
                          }
                        >
                          {routine.channel.gone
                            ? "This channel is gone"
                            : (routine.channel.name ?? "Unnamed channel")}
                        </span>
                        <span className={lastRunClassName}>{lastRunText}</span>
                        {/*
                         * Enabled only: the store recomputes nextRunAt on cron/timezone change or
                         * re-enable, so a disabled routine's stamp is frozen in the past — rendering
                         * it unguarded would announce a stale "3 days ago" as the next run.
                         */}
                        {routine.enabled ? (
                          <span className="text-muted-foreground">
                            Next {relativeTime(routine.nextRunAt)}
                          </span>
                        ) : null}
                      </div>
                    </ItemFooter>
                  </ItemContent>
                  <ItemActions>
                    {/*
                     * Binary and immediate: it takes effect when switched, there is no save.
                     * Disabled only while its own write is in flight, so switching one routine
                     * does not freeze the rest of the list — the same idiom the per-tool plugins
                     * page uses for its per-Bot grant switches.
                     */}
                    <Switch
                      aria-label={`Enable the routine scheduled ${routine.schedule}`}
                      checked={routine.enabled}
                      disabled={
                        setEnabled.isPending &&
                        setEnabled.variables?.id === routine.id
                      }
                      onCheckedChange={(next) =>
                        setEnabled.mutate({ id: routine.id, enabled: next })
                      }
                    />
                    <Button
                      aria-label={`Delete the routine scheduled ${routine.schedule}`}
                      onClick={() => {
                        deleteRoutine.reset();
                        setConfirmingId(routine.id);
                      }}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <IconTrash />
                    </Button>
                  </ItemActions>
                </Item>
                {index !== rows.length - 1 && <Separator />}
              </div>
            );
          })}
        </PageRows>
      )}

      {/*
       * One dialog for the whole list rather than one per row, keyed by which routine is being
       * confirmed. It names the schedule, not the id or the instruction, because the schedule is
       * the word a person reads first on the row and the one most likely to tell two routines apart
       * at a glance.
       */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirmingId(null);
        }}
        open={confirming !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete "{confirming?.schedule}"?</DialogTitle>
            <DialogDescription>
              This standing instruction stops for good. Nothing further runs on
              this schedule, and there is no undo.
            </DialogDescription>
          </DialogHeader>
          {deleteRoutine.error ? (
            <p className="text-destructive text-sm" role="alert">
              {deleteRoutine.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              onClick={() => setConfirmingId(null)}
              size="sm"
              variant="ghost"
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

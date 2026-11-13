import type { Icon } from "@tabler/icons-react";
import { type MutationKey, useMutationState } from "@tanstack/react-query";
import { type LinkProps, Navigate } from "@tanstack/react-router";
import { LoadingRows } from "@/components/layout/loading-rows";
import { PageEmpty, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { backLabelFor } from "./new-routine-page";

const WORDS = {
  goal: { title: "Goal", noun: "goal" },
  routine: { title: "Routine", noun: "routine" },
  "check-in": { title: "Check-in", noun: "check-in" },
} as const;

/**
 * Whether the item a page shows was deleted from this browser: a delete of it, under
 * `mutationKey`, that is on its way or done.
 *
 * The page reads its item from a list, and the delete's own refetch of that list takes the page
 * down while the delete is still waiting on its other reads. So the page that asked is gone before
 * the delete ends, and a callback it gave `mutate` never runs. The route stays, sees the item gone
 * and the delete it was asked for, and goes back to the list ({@link RoutineDetailMissing}).
 */
export function useDeletedHere<TVariables>(
  mutationKey: MutationKey,
  isThis: (variables: TVariables) => boolean,
): boolean {
  return (
    useMutationState({
      filters: {
        mutationKey,
        predicate: (mutation) =>
          (mutation.state.status === "pending" ||
            mutation.state.status === "success") &&
          mutation.state.variables !== undefined &&
          isThis(mutation.state.variables as TVariables),
      },
      select: (mutation) => mutation.mutationId,
    }).length > 0
  );
}

/**
 * What a Routines list item's own page says before it has the item: loading, a read that failed
 * (with Retry), or an address for one that isn't there. One frame for goals, schedules and
 * check-ins, so the three pages say it in the same words.
 *
 * One deleted from its own page isn't "not here": the person meant it, and is taken back to the
 * list it came from, without the page left behind in history.
 */
export function RoutineDetailMissing({
  back,
  deleted = false,
  icon,
  kind,
  read,
}: {
  back: LinkProps;
  /** It was deleted from this browser ({@link useDeletedHere}). */
  deleted?: boolean;
  icon: Icon;
  kind: keyof typeof WORDS;
  /** The list read the item comes from. */
  read: {
    isPending: boolean;
    error: Error | null;
    isFetching: boolean;
    refetch: () => unknown;
  };
}) {
  const words = WORDS[kind];
  if (deleted) return <Navigate {...back} replace />;
  return (
    <PageShell
      backButton={{ label: backLabelFor(back), linkProps: back }}
      title={words.title}
    >
      {read.isPending ? (
        <LoadingRows label={`Loading this ${words.noun}`} rows={4} />
      ) : read.error ? (
        <div className="flex flex-wrap items-center gap-3" role="alert">
          <p className="text-destructive text-sm">
            Couldn't load this {words.noun}. Try again.
          </p>
          <Button
            disabled={read.isFetching}
            onClick={() => read.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            Retry
          </Button>
        </div>
      ) : (
        <PageEmpty icon={icon} title={`This ${words.noun} isn't here`}>
          It may have been deleted, or it belongs to someone else.
        </PageEmpty>
      )}
    </PageShell>
  );
}

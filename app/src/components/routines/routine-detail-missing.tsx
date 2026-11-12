import type { Icon } from "@tabler/icons-react";
import type { LinkProps } from "@tanstack/react-router";
import { LoadingRows } from "@/components/layout/loading-rows";
import { PageEmpty, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";

const WORDS = {
  goal: { title: "Goal", noun: "goal" },
  routine: { title: "Routine", noun: "routine" },
  "check-in": { title: "Check-in", noun: "check-in" },
} as const;

/**
 * What a Routines list item's own page says before it has the item: loading, a read that failed
 * (with Retry), or an address for one that isn't there. One frame for goals, schedules and
 * check-ins, so the three pages say it in the same words.
 */
export function RoutineDetailMissing({
  back,
  icon,
  kind,
  read,
}: {
  back: LinkProps;
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
  return (
    <PageShell
      backButton={{ label: "Routines", linkProps: back }}
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

import { Link } from "@tanstack/react-router";
import { relativeTime } from "@/lib/relative-time";
import type { RoutineRecord, RoutineRunRecord } from "@/lib/routines/queries";
import { cn } from "@/lib/utils";
import { useRoutineRuns } from "./use-routine-runs";
import { failureSaid } from "@/lib/load-failure";

/*
 * What a routine has done, where a person sees a routine: its own row on the Routines list, and each
 * schedule in a goal's dialog, which is a routine folded into the goal's row. One last-run chip and
 * one run history for both.
 */

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
  /** The chip's dot, which carries the tone so the text can stay readable. */
  dot: string;
} {
  if (lastRun === null) {
    return {
      text: "Hasn't run yet",
      className: "text-muted-foreground",
      dot: "bg-muted-foreground/40",
    };
  }
  if (lastRun.status === null) {
    return {
      text: "Running…",
      className: "text-muted-foreground",
      dot: "animate-pulse bg-muted-foreground",
    };
  }
  const when = lastRun.at ? relativeTime(lastRun.at) : "recently";
  if (lastRun.status === "failed") {
    return {
      text: `Failed ${when}`,
      className: "text-destructive",
      dot: "bg-destructive",
    };
  }
  if (lastRun.status === "skipped") {
    return {
      text: `Skipped ${when}`,
      className: "text-warning",
      dot: "bg-warning",
    };
  }
  if (lastRun.status === "succeeded") {
    return {
      text: `Ran ${when}`,
      className: "text-muted-foreground",
      dot: "bg-success",
    };
  }
  // An outcome this DTO doesn't recognise degrades to a neutral label rather than an invented
  // success — the contract typing (`RoutineRunOutcome | null`) makes a fourth outcome a build-time
  // error, but this is the runtime fallback if that ever slips through.
  return {
    text: `Finished ${when}`,
    className: "text-muted-foreground",
    dot: "bg-muted-foreground/40",
  };
}

/**
 * One fact about a routine, worn as a small pill so the footer reads as a row of states rather
 * than a sentence.
 */
export function Chip({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border bg-background/60 px-2 py-0.5 text-xs",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** When it last ran and how it went, as a chip whose dot carries the tone (`lastRunLabel`). */
export function LastRunChip({
  lastRun,
}: {
  lastRun: RoutineRecord["lastRun"];
}) {
  const label = lastRunLabel(lastRun);
  return (
    <Chip className={label.className}>
      <span className={cn("size-1.5 rounded-full", label.dot)} />
      {label.text}
    </Chip>
  );
}

const RUN_STATUS: Record<
  RoutineRunRecord["status"],
  { text: string; dot: string; className: string }
> = {
  running: {
    text: "Running",
    dot: "animate-pulse bg-muted-foreground",
    className: "",
  },
  succeeded: { text: "Succeeded", dot: "bg-success", className: "" },
  failed: {
    text: "Failed",
    dot: "bg-destructive",
    className: "text-destructive",
  },
  skipped: {
    text: "Skipped",
    dot: "bg-warning",
    className: "text-warning",
  },
  waiting: { text: "Waiting for you", dot: "bg-sky-500", className: "" },
};

/** How a run's status reads on its row. Nothing for one a newer server sends that this app doesn't know. */
export function runStatusOf(status: string) {
  const known: Partial<Record<string, (typeof RUN_STATUS)["running"]>> =
    RUN_STATUS;
  return known[status] ?? null;
}

/** Every firing of one routine, newest first, each linking to the thread it ran in. */
export function RoutineRuns({ routine }: { routine: RoutineRecord }) {
  const runs = useRoutineRuns(routine.id);
  // Pending renders nothing: "No runs yet." would otherwise flash for the fetch.
  if (runs.isPending) return null;
  if (runs.error)
    return (
      <p className="text-destructive text-xs" role="alert">
        {failureSaid(runs.error)}
      </p>
    );
  if (!runs.data?.length)
    return <p className="text-muted-foreground text-xs">No runs yet.</p>;
  return (
    <ul className="flex w-full flex-col gap-1.5">
      {runs.data.map((run) => {
        const status = runStatusOf(run.status);
        return (
          <li
            className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
            key={run.id}
          >
            {status ? (
              <span
                className={cn(
                  "inline-flex items-center gap-1.5",
                  status.className,
                )}
              >
                <span className={cn("size-1.5 rounded-full", status.dot)} />
                {status.text}
              </span>
            ) : null}
            <span className="text-muted-foreground">
              {run.source === "run_now"
                ? "Run now"
                : run.source === "trigger"
                  ? "Triggered"
                  : "Scheduled"}{" "}
              · {relativeTime(run.startedAt)}
            </span>
            {routine.conversation.gone ? null : (
              <Link
                className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
                params={{ channelId: routine.conversation.id }}
                to="/channel/$channelId"
              >
                Open conversation
              </Link>
            )}
            {run.error ? (
              <span className="basis-full text-muted-foreground">
                {run.error}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

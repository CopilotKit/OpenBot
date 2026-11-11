import {
  IconCalendarTime,
  IconChevronRight,
  IconClock,
  IconHistory,
  IconMessage,
  IconMessageOff,
  IconPlayerPlay,
  IconRobot,
  IconTrash,
  IconWorld,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
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
import { Switch } from "@/components/ui/switch";
import { relativeTime } from "@/lib/relative-time";
import {
  runRoutineNowMutationOptions,
  setRoutineEnabledMutationOptions,
} from "@/lib/routines/mutations";
import {
  type RoutineRecord,
  type RoutineRunRecord,
  routineRunsQueryOptions,
} from "@/lib/routines/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

/** The browser's own time zone, for saying a schedule's only where it differs. */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/**
 * When a routine starts, as its row says it: the schedule, with its time zone only where it isn't
 * the reader's own. "Weekdays at 09:00" in Madrid, read in Madrid, needs no zone; read in New York
 * it does. The details always name the zone.
 */
export function scheduleWords(
  routine: Pick<RoutineRecord, "schedule" | "timezone">,
  localZone: string = viewerTimeZone(),
): string {
  return routine.timezone === localZone
    ? routine.schedule
    : `${routine.schedule} · ${routine.timezone}`;
}

/**
 * What the last-run cell says, and in what tone.
 *
 * `lastRun === null` and `lastRun.status === null` are different facts, and saying the wrong one
 * invents news: the first is "this routine has never finished a run," the second is "one is open
 * right now" — which is also what a run stuck open after repeated dispatch failures looks like from
 * here. Neither is a failure, so neither gets the destructive tone; only `status: "failed"` does.
 */
export function lastRunLabel(lastRun: RoutineRecord["lastRun"]): {
  text: string;
  className: string;
} {
  if (lastRun === null)
    return { text: "Hasn't run yet", className: "text-muted-foreground" };
  if (lastRun.status === null)
    return { text: "Running…", className: "text-muted-foreground" };
  const when = lastRun.at ? relativeTime(lastRun.at) : "recently";
  if (lastRun.status === "failed")
    return { text: `Failed ${when}`, className: "text-destructive" };
  if (lastRun.status === "skipped")
    return {
      text: `Skipped ${when}`,
      className: "text-amber-600 dark:text-amber-500",
    };
  if (lastRun.status === "succeeded")
    return { text: `Ran ${when}`, className: "text-muted-foreground" };
  // An outcome this DTO doesn't recognise degrades to a neutral label rather than an invented
  // success: the contract typing makes a fourth outcome a build-time error, and this is the runtime
  // fallback if that ever slips through.
  return { text: `Finished ${when}`, className: "text-muted-foreground" };
}

/**
 * When it runs next. Enabled only: the store recomputes nextRunAt on a schedule change or
 * re-enable, so a paused routine's stamp is frozen in the past. A stamp in the past is a firing the
 * sweep has not picked up, and "Next 5 hours ago" is nonsense, so it is said as Due.
 */
function nextRunWords(routine: RoutineRecord): {
  text: string;
  className?: string;
} {
  if (!routine.enabled) return { text: "Paused" };
  if (new Date(routine.nextRunAt).getTime() <= Date.now())
    return { text: "Due", className: "text-amber-600 dark:text-amber-500" };
  return { text: relativeTime(routine.nextRunAt) };
}

const RUN_STATUS: Record<
  RoutineRunRecord["status"],
  { text: string; dot: string; className: string }
> = {
  running: {
    text: "Running",
    dot: "animate-pulse bg-muted-foreground motion-reduce:animate-none",
    className: "",
  },
  succeeded: { text: "Succeeded", dot: "bg-emerald-500", className: "" },
  failed: {
    text: "Failed",
    dot: "bg-destructive",
    className: "text-destructive",
  },
  skipped: {
    text: "Skipped",
    dot: "bg-amber-500",
    className: "text-amber-600 dark:text-amber-500",
  },
  waiting: { text: "Waiting for you", dot: "bg-sky-500", className: "" },
};

/**
 * Every firing of one routine, newest first, each linking to the thread it ran in. A run's reason,
 * a skipped one's included, is the server's own words under it; nothing is inferred from a status.
 */
function RoutineRuns({ routine }: { routine: RoutineRecord }) {
  const runs = useQuery(routineRunsQueryOptions(routine.id));
  // Pending renders nothing: "No runs yet." would otherwise flash for the fetch.
  if (runs.isPending) return null;
  if (runs.error)
    return (
      <p className="text-destructive text-sm" role="alert">
        {runs.error.message}
      </p>
    );
  if (!runs.data?.length)
    return <p className="text-muted-foreground text-sm">No runs yet.</p>;
  return (
    <ul className="flex w-full flex-col gap-2">
      {runs.data.map((run) => {
        const status = RUN_STATUS[run.status] ?? RUN_STATUS.skipped;
        return (
          <li
            className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm"
            key={run.id}
          >
            <span
              className={cn(
                "inline-flex items-center gap-1.5",
                status.className,
              )}
            >
              <span className={cn("size-1.5 rounded-full", status.dot)} />
              {status.text}
            </span>
            <span className="text-muted-foreground">
              {run.source === "run_now"
                ? "Run now"
                : run.source === "trigger"
                  ? "Triggered"
                  : "Scheduled"}{" "}
              · {relativeTime(run.startedAt)}
            </span>
            {routine.channel.gone ? null : (
              <Link
                className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
                params={{ channelId: routine.channel.id }}
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

/**
 * Everything about one scheduled routine, opened from its row, as a goal's and a check-in's are.
 *
 * The row used to carry its switch, Run now, History and Delete inline, so on a phone it stood 204px
 * tall beside 80px goals and read as a different kind of list. Here they are all in one place, each
 * the same write it always was: the switch takes effect when switched, Run now does real work, and
 * Delete asks first (the list's own confirmation, stacked over this).
 */
export function RoutineDialog({
  routine,
  bot,
  onClose,
  onDelete,
}: {
  routine: RoutineRecord;
  /** The Bot it belongs to, on the every-Bot list. Absent on the Bot's own list. */
  bot?: { id: string; name: string };
  onClose: () => void;
  onDelete: () => void;
}) {
  const setEnabled = useMutation(setRoutineEnabledMutationOptions(queryClient));
  const runNow = useMutation(runRoutineNowMutationOptions(queryClient));
  const [showRuns, setShowRuns] = useState(false);
  const lastRun = lastRunLabel(routine.lastRun);
  const next = nextRunWords(routine);
  const facts = [
    {
      key: "schedule",
      icon: IconCalendarTime,
      label: "Schedule",
      value: routine.schedule,
    },
    {
      key: "zone",
      icon: IconWorld,
      label: "Time zone",
      value: routine.timezone,
    },
    {
      key: "next",
      icon: IconClock,
      label: "Next run",
      value: next.text,
      className: next.className,
    },
    {
      key: "last",
      icon: IconHistory,
      label: "Last run",
      value: lastRun.text,
      className: lastRun.className,
    },
  ];
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{routine.title ?? routine.instruction}</DialogTitle>
          <DialogDescription>
            {routine.enabled
              ? `${routine.schedule} · ${routine.timezone} · Acts`
              : "Paused. Nothing starts it until you turn it on."}
          </DialogDescription>
        </DialogHeader>
        {/* Each section keeps its height and the body scrolls, as the goal's dialog does. */}
        <DialogBody className="mt-4 overflow-y-auto [&>*]:shrink-0">
          <div className="overflow-hidden rounded-lg">
            <Item size="sm" variant="muted">
              <ItemMedia variant="icon">
                <IconClock />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>On</ItemTitle>
                <ItemDescription>
                  {routine.enabled
                    ? "It runs on its schedule."
                    : "Paused. It won't run on its schedule."}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                {/* Binary and immediate: it takes effect when switched, there is no save. */}
                <Switch
                  aria-label={`Enable the routine scheduled ${routine.schedule}`}
                  checked={routine.enabled}
                  disabled={setEnabled.isPending}
                  onCheckedChange={(enabled) =>
                    setEnabled.mutate({ id: routine.id, enabled })
                  }
                />
              </ItemActions>
            </Item>
            <Separator />
            <Item
              render={
                <button
                  aria-label={`Run the routine scheduled ${routine.schedule} now`}
                  disabled={!routine.enabled || runNow.isPending}
                  onClick={() =>
                    runNow.mutate(routine.id, {
                      onSuccess: () => setShowRuns(true),
                    })
                  }
                  type="button"
                />
              }
              size="sm"
              variant="muted"
            >
              <ItemMedia variant="icon">
                <IconPlayerPlay />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Run now</ItemTitle>
                <ItemDescription>
                  {routine.enabled
                    ? "Runs it now, for real. The Bot does the work and posts in the conversation."
                    : "This routine is paused. Turn it on first."}
                </ItemDescription>
              </ItemContent>
            </Item>
            <Separator />
            {routine.channel.gone ? (
              <Item size="sm" variant="muted">
                <ItemMedia variant="icon">
                  <IconMessageOff />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle className="text-destructive">
                    Conversation deleted
                  </ItemTitle>
                  <ItemDescription>
                    The conversation it posts in was deleted.
                  </ItemDescription>
                </ItemContent>
              </Item>
            ) : (
              <Item
                render={
                  <Link
                    params={{ channelId: routine.channel.id }}
                    to="/channel/$channelId"
                  />
                }
                size="sm"
                variant="muted"
              >
                <ItemMedia variant="icon">
                  <IconMessage />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Open conversation</ItemTitle>
                  <ItemDescription>
                    {routine.channel.title ?? "Untitled conversation"}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
            )}
            {bot ? (
              <>
                <Separator />
                <Item
                  render={
                    <Link
                      params={{ agentId: bot.id }}
                      to="/bots/$agentId/routines"
                    />
                  }
                  size="sm"
                  variant="muted"
                >
                  <ItemMedia variant="icon">
                    <IconRobot />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{bot.name}</ItemTitle>
                    <ItemDescription>
                      See this Bot's other routines.
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <IconChevronRight className="size-4 text-muted-foreground" />
                  </ItemActions>
                </Item>
              </>
            ) : null}
          </div>
          {setEnabled.error || runNow.error ? (
            <p className="text-destructive text-sm" role="alert">
              {setEnabled.error?.message ?? runNow.error?.message}
            </p>
          ) : null}

          <div className="overflow-hidden rounded-lg">
            {facts.map(
              ({ key, icon: Icon, label, value, className }, index) => (
                <Fragment key={key}>
                  {index > 0 ? <Separator /> : null}
                  <Item size="sm" variant="muted">
                    <ItemMedia variant="icon">
                      <Icon />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{label}</ItemTitle>
                    </ItemContent>
                    <ItemActions className={cn("text-sm", className)}>
                      {value}
                    </ItemActions>
                  </Item>
                </Fragment>
              ),
            )}
            {routine.title ? (
              <>
                <Separator />
                <Item size="sm" variant="muted">
                  <ItemContent>
                    <ItemTitle>Instruction</ItemTitle>
                    <ItemDescription className="line-clamp-none">
                      {routine.instruction}
                    </ItemDescription>
                  </ItemContent>
                </Item>
              </>
            ) : null}
          </div>

          <section className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-medium text-sm">Runs</h3>
              <Button
                aria-expanded={showRuns}
                aria-label={`Run history for the routine scheduled ${routine.schedule}`}
                onClick={() => setShowRuns(!showRuns)}
                size="sm"
                type="button"
                variant="ghost"
              >
                {showRuns ? "Hide runs" : "View runs"}
              </Button>
            </div>
            {showRuns ? <RoutineRuns routine={routine} /> : null}
          </section>
        </DialogBody>
        <DialogFooter className="mt-4 justify-between">
          <Button
            aria-label={`Delete the routine scheduled ${routine.schedule}`}
            className="text-destructive hover:text-destructive"
            onClick={onDelete}
            size="sm"
            type="button"
            variant="ghost"
          >
            <IconTrash />
            Delete
          </Button>
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

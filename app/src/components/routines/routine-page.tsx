import {
  IconCalendarTime,
  IconChevronRight,
  IconClock,
  IconHistory,
  IconMessage,
  IconMessageOff,
  IconPlayerPlay,
  IconRobot,
  IconWorld,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, type LinkProps, useNavigate } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { LoadingRows } from "@/components/layout/loading-rows";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { routinesOf } from "@/components/routines/new-routine-page";
import { DeleteRow } from "@/components/routines/delete-row";
import { RoutineDetailMissing } from "@/components/routines/routine-detail-missing";
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
import { agentListQueryOptions } from "@/lib/agents/queries";
import { relativeTime } from "@/lib/relative-time";
import {
  deleteRoutineMutationOptions,
  runRoutineNowMutationOptions,
  setRoutineEnabledMutationOptions,
} from "@/lib/routines/mutations";
import {
  type RoutineRecord,
  type RoutineRunRecord,
  routineRunsQueryOptions,
  routinesQueryOptions,
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
  { text: string; className: string }
> = {
  running: { text: "Running", className: "" },
  succeeded: {
    text: "Succeeded",
    className: "text-emerald-600 dark:text-emerald-500",
  },
  failed: { text: "Failed", className: "text-destructive" },
  skipped: { text: "Skipped", className: "text-amber-600 dark:text-amber-500" },
  waiting: { text: "Waiting for you", className: "" },
};

const RUN_SOURCE: Record<RoutineRunRecord["source"], string> = {
  run_now: "Run now",
  trigger: "Triggered",
  schedule: "Scheduled",
};

/**
 * Every firing of one routine, newest first, each linking to the conversation it ran in. A run's
 * reason, a skipped one's included, is the server's own words under it; nothing is inferred from a
 * status. Polled with the routine's runs read, so the one Run now started appears without a reload.
 */
function RoutineRuns({ routine }: { routine: RoutineRecord }) {
  const runs = useQuery(routineRunsQueryOptions(routine.id));
  return (
    <PageSection title="Runs">
      {runs.isPending ? (
        <LoadingRows className="mt-4" label="Loading its runs" rows={2} />
      ) : runs.error ? (
        <div className="mt-4 flex flex-wrap items-center gap-3" role="alert">
          <p className="text-destructive text-sm">
            Couldn't load its runs. Try again.
          </p>
          <Button
            disabled={runs.isFetching}
            onClick={() => runs.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            Retry
          </Button>
        </div>
      ) : runs.data.length ? (
        <PageRows>
          {runs.data.map((run, index) => {
            const status = RUN_STATUS[run.status] ?? RUN_STATUS.skipped;
            return (
              <Fragment key={run.id}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconHistory />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle className={status.className}>
                      {status.text}
                    </ItemTitle>
                    <ItemDescription>
                      {RUN_SOURCE[run.source] ?? "Scheduled"} ·{" "}
                      {relativeTime(run.startedAt)}
                    </ItemDescription>
                    {run.error ? (
                      <ItemDescription className="line-clamp-none">
                        {run.error}
                      </ItemDescription>
                    ) : null}
                  </ItemContent>
                  {routine.channel.gone ? null : (
                    <ItemActions>
                      <Link
                        className="text-sm underline"
                        params={{ channelId: routine.channel.id }}
                        to="/channel/$channelId"
                      >
                        Open conversation
                      </Link>
                    </ItemActions>
                  )}
                </Item>
              </Fragment>
            );
          })}
        </PageRows>
      ) : (
        <p className="mt-4 text-muted-foreground text-sm">No runs yet.</p>
      )}
    </PageSection>
  );
}

/**
 * A scheduled routine's page at `/routines/schedules/$routineId`, reached from its row on a
 * Routines list, as a goal's and a check-in's are. It was a dialog over the list.
 *
 * Read from the routines list rather than a read of its own, so the row and the page are the same
 * record. `agentId` is the Bot whose Routines page it came from, for the back link.
 */
export function RoutineRoutePage({
  routineId,
  agentId,
}: {
  routineId: string;
  agentId?: string;
}) {
  const routines = useQuery(routinesQueryOptions());
  const bots = useQuery(agentListQueryOptions());
  const hidden = useQuery(agentListQueryOptions(true));
  const back = routinesOf(agentId);
  const routine = routines.data?.routines.find((row) => row.id === routineId);
  if (!routine)
    return (
      <RoutineDetailMissing
        back={back}
        icon={IconCalendarTime}
        kind="routine"
        read={routines}
      />
    );
  // A routine outlives hiding its Bot, so a hidden Bot still names it.
  const botName = [...(bots.data ?? []), ...(hidden.data ?? [])].find(
    (bot) => bot.id === routine.agentId,
  )?.name;
  return (
    <RoutinePage
      back={back}
      bot={
        agentId === undefined
          ? { id: routine.agentId, name: botName ?? "A Bot" }
          : undefined
      }
      key={routine.id}
      routine={routine}
    />
  );
}

/**
 * Everything about one scheduled routine: switched, run, read back and deleted, each the same write
 * it always was. The switch takes effect when switched, Run now does real work, and Delete, the last
 * row of the actions, asks first, then returns to the list.
 */
export function RoutinePage({
  routine,
  bot,
  back,
}: {
  routine: RoutineRecord;
  /** The Bot it belongs to, from the every-Bot list. Absent from the Bot's own list. */
  bot?: { id: string; name: string };
  /** The Routines list it came from. */
  back: LinkProps;
}) {
  const navigate = useNavigate();
  const setEnabled = useMutation(setRoutineEnabledMutationOptions(queryClient));
  const runNow = useMutation(runRoutineNowMutationOptions(queryClient));
  const remove = useMutation(deleteRoutineMutationOptions(queryClient));
  const [confirming, setConfirming] = useState(false);
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
    <PageShell
      backButton={{ label: "Routines", linkProps: back }}
      description={
        routine.enabled
          ? `${routine.schedule} · ${routine.timezone} · Acts`
          : "Paused. Nothing starts it until you turn it on."
      }
      title={routine.title ?? routine.instruction}
    >
      {/* What can be done to it now. The page title names it, so this section has no heading. */}
      <PageSection>
        <PageRows>
          <Item size="sm">
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
                onClick={() => runNow.mutate(routine.id)}
                type="button"
              />
            }
            size="sm"
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
            <Item size="sm">
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
          <Separator />
          <DeleteRow
            description="It stops for good."
            label={`Delete the routine scheduled ${routine.schedule}`}
            onClick={() => {
              remove.reset();
              setConfirming(true);
            }}
            title="Delete routine"
          />
        </PageRows>
        {setEnabled.error || runNow.error ? (
          <p className="mt-3 text-destructive text-sm" role="alert">
            {setEnabled.error?.message ?? runNow.error?.message}
          </p>
        ) : null}
      </PageSection>

      <PageSection title="Details">
        <PageRows>
          {facts.map(({ key, icon: Icon, label, value, className }, index) => (
            <Fragment key={key}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
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
          ))}
          {routine.title ? (
            <>
              <Separator />
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>Instruction</ItemTitle>
                  <ItemDescription className="line-clamp-none">
                    {routine.instruction}
                  </ItemDescription>
                </ItemContent>
              </Item>
            </>
          ) : null}
        </PageRows>
      </PageSection>

      <RoutineRuns routine={routine} />

      {/* It names the schedule, the words a person reads first on the row. */}
      <Dialog onOpenChange={setConfirming} open={confirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete "{routine.schedule}"?</DialogTitle>
            <DialogDescription>
              This routine stops for good. You can't undo this.
            </DialogDescription>
          </DialogHeader>
          {remove.error ? (
            <DialogBody className="mt-4">
              <p className="text-destructive text-sm" role="alert">
                {remove.error.message}
              </p>
            </DialogBody>
          ) : null}
          <DialogFooter className="mt-4">
            <Button
              onClick={() => setConfirming(false)}
              size="sm"
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(routine.id, {
                  onSuccess: () => navigate(back),
                })
              }
              size="sm"
              type="button"
              variant="destructive"
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

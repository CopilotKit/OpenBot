import { IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  callRoutines,
  DAY_NAMES,
  describeSchedule,
  type Routine,
  type RoutineRun,
  routineKeys,
  routineListQueryOptions,
  routineRunsQueryOptions,
  WEEK,
} from "@/lib/routines/queries";

/**
 * Work a Bot does without being asked.
 *
 * The page is built around one question that is easy to answer badly: what happened last time? A
 * routine you are watching is not the point of a routine, so the row leads with when it is next due
 * and what came of the last run, and the prompt, which is the part you already know, is behind the
 * run history rather than in front of it.
 *
 * `missed` is drawn as its own thing rather than folded in with a failure. A deployment that was not
 * running at eight o'clock did not do the eight o'clock work, and that is a fact about the machine
 * rather than about the Bot: showing it as an error sends somebody to read a prompt that is fine.
 */
export const Route = createFileRoute("/_authed/_app/routines")({
  component: RoutinesPage,
});

function RoutinesPage() {
  const queryClient = useQueryClient();
  const routines = useQuery(routineListQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  /** Which routine's history is open. One at a time: this is a list, not a dashboard. */
  const [open, setOpen] = useState<string | null>(null);

  const act = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onError: (caught: Error) => setError(caught.message),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: routineKeys.all });
    },
  });

  const rows = routines.data ?? [];

  return (
    <PageShell
      action={
        <Button onClick={() => setWriting(true)} size="sm" variant="ghost">
          <IconPlus />
          New routine
        </Button>
      }
      description="A routine is something a Bot does on its own, on a schedule. Nobody is watching a scheduled run, so it cannot ask you anything: everything it does goes through the same boundary as work you watch, and every action is in Audit."
      title="Routines"
    >
      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      {writing ? (
        <NewRoutine
          bots={(agents.data ?? []).map((agent) => ({
            id: agent.id,
            name: agent.name,
          }))}
          onCancel={() => setWriting(false)}
          onCreate={async (values) => {
            await act.mutateAsync(() =>
              callRoutines("", {
                method: "POST",
                body: JSON.stringify(values),
              }),
            );
            setWriting(false);
          }}
        />
      ) : null}

      <PageSection title="Yours">
        {routines.isPending ? (
          <PageEmpty>Loading your routines…</PageEmpty>
        ) : routines.isError ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Routines could not be loaded.
          </p>
        ) : rows.length === 0 ? (
          <PageEmpty>
            Nothing yet. A routine is a sentence you would otherwise type every
            morning.
          </PageEmpty>
        ) : (
          <PageRows>
            {rows.map((routine, index) => (
              <StaggerItem index={index} key={routine.id}>
                <RoutineRow
                  busy={act.isPending}
                  onDelete={() =>
                    act.mutate(() =>
                      callRoutines(`/${routine.id}`, { method: "DELETE" }),
                    )
                  }
                  onRunNow={() =>
                    act.mutate(() =>
                      callRoutines(`/${routine.id}/run`, { method: "POST" }),
                    )
                  }
                  onToggle={() =>
                    act.mutate(() =>
                      callRoutines(`/${routine.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ enabled: !routine.enabled }),
                      }),
                    )
                  }
                  onOpen={() =>
                    setOpen(open === routine.id ? null : routine.id)
                  }
                  opened={open === routine.id}
                  routine={routine}
                />
                {index !== rows.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}

function RoutineRow({
  routine,
  opened,
  busy,
  onOpen,
  onRunNow,
  onToggle,
  onDelete,
}: {
  routine: Routine;
  opened: boolean;
  busy: boolean;
  onOpen: () => void;
  onRunNow: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const runs = useQuery({
    ...routineRunsQueryOptions(routine.id),
    enabled: opened,
  });

  return (
    <div className="px-4 py-3">
      <Item className="p-0" size="sm">
        <ItemContent>
          <ItemTitle>
            {routine.name}
            {!routine.enabled ? (
              <span className="ml-2 font-normal text-muted-foreground text-xs">
                paused
              </span>
            ) : null}
          </ItemTitle>
          <ItemDescription>
            {describeSchedule(routine.schedule)}
            {/*
             * Next due and last run, side by side, because they are the two things somebody opens
             * this page to find out and reading them apart makes you hold one in your head.
             */}
            {routine.enabled && routine.nextDueAt ? (
              <> · next {shortTime(routine.nextDueAt)}</>
            ) : null}
          </ItemDescription>
          <p className="mt-1 text-xs">
            <LastRun run={routine.lastRun} />
          </p>
        </ItemContent>
        <ItemActions>
          <Button
            disabled={busy}
            onClick={onRunNow}
            size="sm"
            variant="outline"
          >
            Run now
          </Button>
          <Button disabled={busy} onClick={onToggle} size="sm" variant="ghost">
            {routine.enabled ? "Pause" : "Resume"}
          </Button>
          <Button onClick={onOpen} size="sm" variant="ghost">
            {opened ? "Hide runs" : "Runs"}
          </Button>
        </ItemActions>
      </Item>

      {opened ? (
        <div className="mt-3 rounded-md border border-border bg-background p-3">
          {/*
           * The prompt lives here rather than on the row. It is the part somebody already knows,
           * and it is often several sentences; putting it in the list would make every row a
           * paragraph and bury the two facts the list exists to show.
           */}
          <p className="text-muted-foreground text-xs">What it is told</p>
          <p className="mt-1 whitespace-pre-wrap text-sm">{routine.prompt}</p>

          <p className="mt-4 text-muted-foreground text-xs">Recent runs</p>
          {runs.isPending ? (
            <p className="mt-1 text-muted-foreground text-sm">Loading…</p>
          ) : (runs.data?.length ?? 0) === 0 ? (
            <p className="mt-1 text-muted-foreground text-sm">
              It has not run yet.
            </p>
          ) : (
            <ul className="mt-1 space-y-2">
              {runs.data?.map((run) => (
                <li className="text-sm" key={run.id}>
                  <span className={STATUS_CLASS[run.status]}>
                    {STATUS_LABEL[run.status]}
                  </span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {shortTime(run.startedAt)} · {TRIGGER_LABEL[run.trigger]}
                  </span>
                  {run.summary ? (
                    <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground text-xs">
                      {run.summary}
                    </p>
                  ) : null}
                  {run.error ? (
                    <p className="mt-0.5 text-destructive text-xs">
                      {run.error}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4">
            {/*
             * Deleting takes the run history with it and there is no undo, so it is down here rather
             * than on the row, and it names the routine it destroys: a button pressed against the
             * wrong row is the ordinary way this goes wrong.
             */}
            <Button onClick={onDelete} size="sm" variant="ghost">
              Delete “{routine.name}” and its history
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** What became of the last run, in one line, or the honest absence of one. */
function LastRun({ run }: { run: RoutineRun | null }) {
  if (!run) {
    return <span className="text-muted-foreground">Has not run yet</span>;
  }
  return (
    <>
      <span className={STATUS_CLASS[run.status]}>
        {STATUS_LABEL[run.status]}
      </span>
      <span className="text-muted-foreground">
        {" "}
        · {shortTime(run.startedAt)}
      </span>
      {run.summary ? (
        <span className="text-muted-foreground"> · {oneLine(run.summary)}</span>
      ) : null}
    </>
  );
}

function NewRoutine({
  bots,
  onCreate,
  onCancel,
}: {
  bots: { id: string; name: string }[];
  onCreate: (values: {
    agentId: string;
    name: string;
    prompt: string;
    schedule: { type: "daily"; time: string; weekdays: number[] };
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [agentId, setAgentId] = useState(bots[0]?.id ?? "");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [time, setTime] = useState("08:00");
  // Weekdays by default, because the routine everybody writes first is a working-day one.
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);

  const toggleDay = (day: number) =>
    setWeekdays((current) =>
      current.includes(day)
        ? current.filter((one) => one !== day)
        : [...current, day].sort((left, right) => left - right),
    );

  return (
    <PageSection title="New routine">
      <form
        className="mt-4 rounded-lg border border-border bg-card p-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void onCreate({
            agentId,
            name,
            prompt,
            schedule: { type: "daily", time, weekdays },
          });
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="routine-bot">Bot</FieldLabel>
            {/*
             * A plain select rather than the styled one, because this list is the roster and it can
             * be long; the native control is the one that behaves on a phone and with a keyboard.
             */}
            <select
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              id="routine-bot"
              onChange={(event) => setAgentId(event.target.value)}
              value={agentId}
            >
              {bots.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </select>
            <FieldDescription>
              It runs as you, and can reach what you can reach.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="routine-name">Name</FieldLabel>
            <Input
              id="routine-name"
              onChange={(event) => setName(event.target.value)}
              placeholder="Overnight alerts"
              value={name}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="routine-prompt">What to do</FieldLabel>
            <Textarea
              id="routine-prompt"
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Check the overnight alerts and write me a summary in alerts.md."
              rows={4}
              value={prompt}
            />
            <FieldDescription>
              Write it as you would say it. Nobody will be there to answer a
              question, so say where to leave the answer.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="routine-time">Time</FieldLabel>
            <Input
              className="w-32"
              id="routine-time"
              onChange={(event) => setTime(event.target.value)}
              placeholder="08:00"
              value={time}
            />
            {/*
             * UTC, said out loud. The arithmetic is in UTC and a routine that fired an hour early
             * every winter would be a bug nobody could see from this form.
             */}
            <FieldDescription>
              In UTC, as HH:MM. A routine at 08:00 runs at eight o'clock UTC
              wherever you are.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel>Days</FieldLabel>
            <div className="flex flex-wrap gap-2">
              {WEEK.map((day) => (
                <Button
                  aria-pressed={weekdays.includes(day)}
                  className={
                    weekdays.includes(day) ? "bg-foreground/5" : undefined
                  }
                  key={day}
                  onClick={() => toggleDay(day)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {DAY_NAMES[day]?.slice(0, 3)}
                </Button>
              ))}
            </div>
            {weekdays.length === 0 ? (
              <FieldDescription>
                No days selected, so it will never run on its own.
              </FieldDescription>
            ) : null}
          </Field>

          <div className="flex gap-2">
            <Button
              disabled={!agentId || !name.trim() || !prompt.trim()}
              size="sm"
              type="submit"
            >
              Save routine
            </Button>
            <Button onClick={onCancel} size="sm" type="button" variant="ghost">
              Cancel
            </Button>
          </div>
        </FieldGroup>
      </form>
    </PageSection>
  );
}

/**
 * `missed` reads as its own thing, not as a failure.
 *
 * A deployment that was asleep at eight o'clock did not do the eight o'clock work. That is a fact
 * about the machine rather than about the Bot, and drawing it in red next to a genuine failure sends
 * somebody to read a prompt that is fine.
 */
const STATUS_LABEL: Record<RoutineRun["status"], string> = {
  queued: "Waiting",
  running: "Running",
  completed: "Ran",
  failed: "Did not work",
  missed: "Missed, nothing was running",
};

const STATUS_CLASS: Record<RoutineRun["status"], string> = {
  queued: "text-muted-foreground",
  running: "text-foreground",
  completed: "text-foreground",
  failed: "font-medium text-destructive",
  missed: "font-medium text-amber-600 dark:text-amber-500",
};

const TRIGGER_LABEL: Record<RoutineRun["trigger"], string> = {
  schedule: "on its schedule",
  manual: "you pressed Run now",
  webhook: "a delivery",
};

/** UTC, everywhere, because that is what the schedule means. */
function shortTime(iso: string): string {
  return `${iso.replace("T", " ").slice(0, 16)} UTC`;
}

function oneLine(text: string): string {
  const first = text.trim().split("\n")[0] ?? "";
  return first.length > 120 ? `${first.slice(0, 117)}…` : first;
}

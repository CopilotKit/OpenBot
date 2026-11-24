import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleDashed,
  IconFileCheck,
  IconHandStop,
  IconPlayerStop,
  IconProgress,
} from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { HeldAnswer } from "@/components/approvals/waiting";
import { BoardRow } from "@/components/needs-you/board-row";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { stopIfNeedsCard } from "@/lib/plan/queries";
import { relativeTime } from "@/lib/relative-time";
import type { ListedTask } from "@/lib/tasks/groups";
import { taskLine } from "@/lib/tasks/line";
import {
  resolveTaskMutationOptions,
  stopTaskMutationOptions,
  tryTaskAgainMutationOptions,
} from "@/lib/tasks/mutations";
import {
  canTryAgain,
  couldNotFinish,
  failureSentence,
  stoppedByYou,
  TASK_DONE_LABEL,
  TASK_FAILED_LABEL,
  TASK_STOPPED,
  TASK_STOPPED_LABEL,
  type TaskStatus,
  taskStatusLabel,
} from "@/lib/tasks/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import { failureSaid } from "@/lib/load-failure";

/** Each status's icon. A status a newer server sends that this app doesn't know has a plain circle. */
const ICONS: Partial<Record<TaskStatus, typeof IconProgress>> = {
  ready_for_review: IconFileCheck,
  needs_input: IconHandStop,
  failed: IconAlertTriangle,
  working: IconProgress,
  resolved: IconCircleCheck,
};

/**
 * The dot on a task's icon, as Activity draws one on work under way: success and pulsing while it
 * runs, warning while it waits on the person, destructive when it couldn't finish. A resolved task has none.
 */
const DOT: Partial<Record<TaskStatus, string>> = {
  working: "animate-pulse bg-success",
  needs_input: "bg-warning",
  ready_for_review: "bg-warning",
  failed: "bg-destructive",
};

/**
 * Whether the row reads Stopped: the person stopped the task and it has not carried on since. Read
 * off the live status, so a stopped task whose conversation is running a turn again reads Working.
 */
function stopped({ task, status }: ListedTask): boolean {
  return status === "failed" && stoppedByYou(task);
}

/**
 * How a row draws its task. A task the person stopped is not a failure: it has the card's stop
 * icon and a quiet dot, never the warning triangle and the red one.
 */
function look(listed: ListedTask): {
  state: TaskStatus | "stopped";
  Icon: typeof IconProgress;
  dot: string | undefined;
} {
  return stopped(listed)
    ? { state: "stopped", Icon: IconPlayerStop, dot: "bg-muted-foreground" }
    : {
        state: listed.status,
        Icon: ICONS[listed.status] ?? IconCircleDashed,
        dot: DOT[listed.status],
      };
}

/**
 * The task's status in a word or two. One the person stopped reads Stopped, as its card does, and
 * one listed as finished (`settled`) reads Done, as its card does and as the heading over it says.
 */
function statusLabel(listed: ListedTask, settled = false): string | null {
  if (stopped(listed)) return TASK_STOPPED_LABEL;
  if (
    settled &&
    (listed.status === "ready_for_review" || listed.status === "resolved")
  )
    return TASK_DONE_LABEL;
  return taskStatusLabel(listed.status);
}

/**
 * What a task says after its status, on every row that lists it: why it couldn't finish, that the
 * person stopped it, or the last thing its Bot said, as plain text (`taskLine`). Nothing when the
 * Bot's last words say nothing about the task. Before the Bot has said anything, a working task has
 * just started.
 */
function nextLine(listed: ListedTask): string | null {
  const { task, status } = listed;
  if (stopped(listed)) return TASK_STOPPED;
  if (status === "failed") return couldNotFinish(task.failure);
  const said = taskLine(task.next);
  if (said) return said;
  return status === "working" ? "Just started." : null;
}

/**
 * A task's status and line on the Needs you board. One that couldn't finish says so in its card's
 * words, Couldn't finish, and its line is why, said once: the board read "Failed" beside a card
 * that said "Couldn't finish", and "Couldn't finish: …" beside "Failed".
 */
function boardStatus(
  listed: ListedTask,
  settled = false,
): { label: string | null; line: string | null } {
  if (listed.status === "failed" && !stopped(listed))
    return {
      label: TASK_FAILED_LABEL,
      line: listed.task.failure ? failureSentence(listed.task.failure) : null,
    };
  return { label: statusLabel(listed, settled), line: nextLine(listed) };
}

/**
 * Whether a row offers Mark done: only where it does something. Not while the task is working:
 * there is nothing finished to mark, and its conversation would carry on behind a row that said it
 * was done. Not on a row that already reads Done, as a finished task's row under Done does: marking
 * it changes nothing the row says.
 */
function canMarkDone(listed: ListedTask, settled = false): boolean {
  const { status } = listed;
  return (
    status !== "working" &&
    status !== "resolved" &&
    statusLabel(listed, settled) !== TASK_DONE_LABEL
  );
}

/**
 * One task: what Start made of an item, running in a conversation of its own. Its status, its Bot,
 * and what it needs next, with Open to read it and reply there, Mark done or Reopen, and Try again
 * once it couldn't finish.
 *
 * The buttons sit on a line of their own rather than the row being a link, so no button is nested
 * inside one. Open is the primary action while the task has something to read or answer.
 */
export function TaskRow({
  listed,
  botName,
  askedIn,
  settled = false,
}: {
  listed: ListedTask;
  /** Left out on a Bot's own page, where every row is that Bot's. */
  botName?: string;
  /**
   * The conversation that asked for the task, for a link back to it, with what that conversation is
   * called when it is known. A check-in's task was not asked for in one.
   */
  askedIn?: { channelId: string; title: string | null };
  /**
   * Listed as finished, on a Bot's Activity page: no dot asking for attention, and Open does not
   * lead. Its result was already said in the conversation that asked for it.
   */
  settled?: boolean;
}) {
  const { task, status } = listed;
  const resolve = useMutation(resolveTaskMutationOptions(queryClient));
  const again = useMutation(tryTaskAgainMutationOptions(queryClient));
  const stop = useMutation(stopTaskMutationOptions(queryClient));
  const { state, Icon, dot: stateDot } = look(listed);
  const dot = settled ? undefined : stateDot;
  const next = nextLine(listed);
  const busy = resolve.isPending || again.isPending || stop.isPending;
  const error = resolve.error ?? again.error ?? stop.error;
  // Stop, as on its card: while it works or waits on the person.
  const canStop = status === "working" || status === "needs_input";
  const openFirst =
    !settled && (status === "ready_for_review" || status === "needs_input");
  return (
    <Item data-task-state={state} size="sm">
      <ItemMedia className="relative" variant="icon">
        <Icon />
        {dot ? (
          <span
            aria-hidden="true"
            className={cn(
              "absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-card",
              dot,
            )}
          />
        ) : null}
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="line-clamp-none">{task.title}</ItemTitle>
        <ItemDescription>
          {[statusLabel(listed, settled), botName, relativeTime(task.updatedAt)]
            .filter(Boolean)
            .join(" · ")}
        </ItemDescription>
        {next ? (
          <ItemDescription className="text-foreground">{next}</ItemDescription>
        ) : null}
        {askedIn ? (
          /*
           * Not clamped: a clamped line cuts the underline off, and the link then reads as plain
           * text. The underline sits close, as on the task's own "Sent from" label.
           */
          <ItemDescription
            className="line-clamp-none [&>a]:underline-offset-2"
            data-slot="task-asked-in"
          >
            <Link
              className="rounded-sm outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              params={{ channelId: askedIn.channelId }}
              to="/channel/$channelId"
            >
              {askedIn.title
                ? `Asked in ${askedIn.title}`
                : "Asked in another conversation"}
            </Link>
          </ItemDescription>
        ) : null}
        <ItemFooter className="mt-2 flex-wrap justify-start">
          {canTryAgain({ ...task, status }) ? (
            <Button
              disabled={busy}
              onClick={() => {
                // Bots can't run until a card is added: the dialog says why, in place of a run.
                if (stopIfNeedsCard()) return;
                again.mutate(task.id);
              }}
              size="sm"
            >
              {again.isPending ? "Starting…" : "Try again"}
            </Button>
          ) : null}
          <Button
            render={
              <Link
                params={{ channelId: task.channelId }}
                to="/channel/$channelId"
              />
            }
            size="sm"
            variant={openFirst ? "default" : "outline"}
          >
            Open
          </Button>
          {canStop ? (
            <Button
              disabled={busy}
              onClick={() => stop.mutate(task.id)}
              size="sm"
              variant="ghost"
            >
              <IconPlayerStop data-icon="inline-start" />
              {stop.isPending ? "Stopping…" : "Stop"}
            </Button>
          ) : null}
          {status === "resolved" ? (
            <Button
              disabled={busy}
              onClick={() => resolve.mutate({ id: task.id, done: false })}
              size="sm"
              variant="outline"
            >
              {resolve.isPending ? "Reopening…" : "Reopen"}
            </Button>
          ) : canMarkDone(listed, settled) ? (
            <Button
              disabled={busy}
              onClick={() => resolve.mutate({ id: task.id, done: true })}
              size="sm"
              variant="ghost"
            >
              {resolve.isPending ? "Saving…" : "Mark done"}
            </Button>
          ) : null}
        </ItemFooter>
        {error ? (
          <p className="mt-1 text-destructive text-sm" role="alert">
            {failureSaid(error)}
          </p>
        ) : null}
      </ItemContent>
    </Item>
  );
}

/**
 * A task on the Needs you board: the same task, in the board's one row shape, with its actions on
 * the right. Open leads while there is something to read or answer.
 */
export function TaskBoardRow({
  listed,
  held,
}: {
  listed: ListedTask;
  /**
   * The wait inside the task's conversation, when one is there, with its answers: the row stands
   * for it and answers it, Allow and Deny for an action, Answer for a question, without the person
   * opening the thread (`useHeldAnswers`).
   */
  held?: HeldAnswer | undefined;
}) {
  const { task, status } = listed;
  const resolve = useMutation(resolveTaskMutationOptions(queryClient));
  const again = useMutation(tryTaskAgainMutationOptions(queryClient));
  const stop = useMutation(stopTaskMutationOptions(queryClient));
  const { state, Icon } = look(listed);
  const busy = resolve.isPending || again.isPending || stop.isPending;
  const error = resolve.error ?? again.error ?? stop.error;
  const openFirst = status === "ready_for_review" || status === "needs_input";
  const said = boardStatus(listed);
  const markDone = () => resolve.mutate({ id: task.id, done: true });
  const markDoneWords = resolve.isPending ? "Saving…" : "Mark done";
  // Stop, as on its card and its Activity row: while it works or waits on the person.
  const canStop = status === "working" || status === "needs_input";
  const stopWords = stop.isPending ? "Stopping…" : "Stop";
  const openLink = (
    <Link params={{ channelId: task.channelId }} to="/channel/$channelId" />
  );
  /*
   * Stop, Mark done and Open come after the row's answers, and fold into its menu where the row's
   * line has no room for them (`BoardRow`).
   */
  const secondary = (openVariant: "default" | "outline" | "ghost") => [
    ...(canStop
      ? [
          {
            key: "stop",
            button: (
              <Button
                disabled={busy}
                onClick={() => stop.mutate(task.id)}
                size="sm"
                variant="ghost"
              >
                <IconPlayerStop data-icon="inline-start" />
                {stopWords}
              </Button>
            ),
            menuItem: (
              <DropdownMenuItem
                disabled={busy}
                onClick={() => stop.mutate(task.id)}
              >
                {stopWords}
              </DropdownMenuItem>
            ),
          },
        ]
      : []),
    ...(held || canMarkDone(listed)
      ? [
          {
            key: "mark-done",
            button: (
              <Button
                disabled={busy}
                onClick={markDone}
                size="sm"
                variant="ghost"
              >
                {markDoneWords}
              </Button>
            ),
            menuItem: (
              <DropdownMenuItem disabled={busy} onClick={markDone}>
                {markDoneWords}
              </DropdownMenuItem>
            ),
          },
        ]
      : []),
    {
      key: "open",
      button: (
        <Button render={openLink} size="sm" variant={openVariant}>
          Open
        </Button>
      ),
      menuItem: (
        <DropdownMenuItem nativeButton={false} render={openLink}>
          Open
        </DropdownMenuItem>
      ),
    },
  ];
  if (held)
    return (
      <BoardRow
        actions={held.actions}
        detail={said.line}
        icon={<Icon />}
        meta={[
          said.label ? <span key="status">{said.label}</span> : null,
          <span key="when">{relativeTime(task.updatedAt)}</span>,
          ...held.meta,
          error ? (
            <span className="text-destructive" key="error" role="alert">
              {failureSaid(error)}
            </span>
          ) : null,
        ]}
        more={held.more}
        open={held.more !== undefined}
        // What it waits on is what the person answers: read in full, at a phone's width too.
        readDetail
        secondary={secondary("ghost")}
        state={state}
        title={task.title}
        waiting
      />
    );
  return (
    <BoardRow
      actions={
        canTryAgain({ ...task, status }) ? (
          <Button
            disabled={busy}
            onClick={() => {
              // Bots can't run until a card is added: the dialog says why, in place of a run.
              if (stopIfNeedsCard()) return;
              again.mutate(task.id);
            }}
            size="sm"
          >
            {again.isPending ? "Starting…" : "Try again"}
          </Button>
        ) : null
      }
      secondary={secondary(openFirst ? "default" : "outline")}
      detail={said.line}
      /*
       * Read in full, never cut: what a waiting task waits for is what the person has to answer,
       * and a stopped task's line says what stopping did ("Anything it had already done stays
       * done"). Cut to one line at a phone's width it read "Anything it had already...".
       */
      readDetail={status === "needs_input" || state === "stopped"}
      icon={<Icon />}
      meta={[
        said.label ? <span key="status">{said.label}</span> : null,
        <span key="when">{relativeTime(task.updatedAt)}</span>,
        error ? (
          <span className="text-destructive" key="error" role="alert">
            {failureSaid(error)}
          </span>
        ) : null,
      ]}
      title={task.title}
      state={state}
      // Tinted where a Bot is stopped on the person. One they stopped themselves is not.
      waiting={openFirst || state === "failed"}
    />
  );
}

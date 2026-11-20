import type {
  DrawnTaskReportKind,
  LinkedThread,
} from "@openbot/shared/orchestration";
import {
  IconAlertTriangle,
  IconArrowUpRight,
  IconCircleCheck,
  IconHandStop,
  IconPlayerStop,
  IconProgress,
} from "@tabler/icons-react";
import {
  QueryClientContext,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useContext, useState } from "react";
import { Button } from "@/components/ui/button";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { elapsed, useNow } from "@/lib/elapsed";
import { relativeTime } from "@/lib/relative-time";
import { stopTaskMutationOptions } from "@/lib/tasks/mutations";
import {
  type BotTask,
  failureSentence,
  type Reaction,
  reactionsQueryOptions,
  stoppedByYou,
  TASK_DONE_LABEL,
  TASK_FAILED_LABEL,
  TASK_STOPPED,
  TASK_STOPPED_LABEL,
  type TaskStatus,
  taskListQueryOptions,
  taskQueryOptions,
} from "@/lib/tasks/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

/*
 * A Bot's task threads, as the conversation that asked for them draws them: the card a task starts
 * with, updated in place while it works; the line it says when it needs the person; the result it
 * comes back with; the links the Bot gives when asked; and the reactions it leaves instead of a line.
 *
 * Drawn from OpenBot's own pieces (the gallery's card frame and tones, the task list's icons and
 * dots, its buttons) so a task reads as part of the conversation, sized for the chat column, with
 * everything stacked rather than side by side.
 */

/**
 * Where a task stands, in the words its card uses. The states A2A gives a task (working,
 * input-required, completed, failed), in the person's words.
 */
type CardState = "working" | "needs" | "done" | "failed" | "stopped";

/**
 * A task the person stopped is told apart from one that couldn't finish by when it was stopped: its
 * status is `failed` either way, and only a stop sets `stoppedAt`.
 */
function cardState(
  task: { status?: TaskStatus; stoppedAt?: string | null } | undefined,
): CardState {
  const status = task?.status;
  if (status === "needs_input") return "needs";
  if (status === "failed") return stoppedByYou(task) ? "stopped" : "failed";
  if (status === "ready_for_review" || status === "resolved") return "done";
  return "working";
}

const STATE: Record<
  CardState,
  { label: string; icon: typeof IconProgress; dot: string; text: string }
> = {
  working: {
    label: "Working",
    icon: IconProgress,
    dot: "animate-pulse bg-emerald-500",
    text: "text-muted-foreground",
  },
  needs: {
    label: "Needs you",
    icon: IconHandStop,
    dot: "bg-amber-500",
    text: "text-amber-700 dark:text-amber-400",
  },
  done: {
    label: TASK_DONE_LABEL,
    icon: IconCircleCheck,
    dot: "bg-emerald-500",
    text: "text-emerald-700 dark:text-emerald-400",
  },
  failed: {
    label: TASK_FAILED_LABEL,
    icon: IconAlertTriangle,
    dot: "bg-destructive",
    text: "text-destructive",
  },
  stopped: {
    label: TASK_STOPPED_LABEL,
    icon: IconPlayerStop,
    dot: "bg-muted-foreground",
    text: "text-muted-foreground",
  },
};

/**
 * When a working task's turn is tried again, while that is still ahead of this clock: its turn hit
 * something that passes (a rate limit, a service that did not answer) and waits. Undefined when it
 * is not waiting, when the time has passed, and once it is no longer working.
 */
function tryingAgainAt(
  task: BotTask | undefined,
  state: CardState,
  now: number,
): number | undefined {
  if (state !== "working" || !task?.tryingAgainAt) return undefined;
  const at = Date.parse(task.tryingAgainAt);
  return Number.isFinite(at) && at > now ? at : undefined;
}

/**
 * What a waiting task says in place of its last activity: the time on the person's own clock, with
 * the day when it is not today, and no clock time for a wait of under a minute.
 */
function tryingAgain(at: number, now: number): ReactNode {
  if (at - now < 60_000) return "Trying again in a moment";
  const when = new Date(at);
  const time = when.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const today = when.toDateString() === new Date(now).toDateString();
  return (
    <>
      Waiting to try again{" "}
      <time dateTime={when.toISOString()} title={when.toLocaleString()}>
        {today
          ? `at ${time}`
          : `on ${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`}
      </time>
    </>
  );
}

/**
 * How long a working task has been at it, and when a task last did something, kept right while the
 * conversation stays open: a long task that says nothing is seen to be alive, or seen to have gone
 * quiet. Counted every second while it works, and every half minute otherwise.
 *
 * A task waiting to try again says that and when in place of its last activity, which would read
 * as a task gone quiet. `now` is the card's clock, so the line and the card change together.
 */
function TaskTimes({
  task,
  state,
  now,
}: {
  task: BotTask;
  state: CardState;
  now: number;
}) {
  const working = state === "working";
  const since =
    working && task.workingSince ? Date.parse(task.workingSince) : NaN;
  const at = task.lastActivityAt;
  const lead = state === "done" ? "Finished" : "Last activity";
  const retryAt = tryingAgainAt(task, state, now);
  return (
    <>
      {Number.isFinite(since) ? (
        <span data-slot="task-elapsed">
          {" · "}
          <time
            className="tabular-nums"
            dateTime={task.workingSince ?? undefined}
          >
            {elapsed(Math.max(0, Math.floor((now - since) / 1000)))}
          </time>
        </span>
      ) : null}
      {retryAt !== undefined ? (
        <span
          className="block font-normal text-muted-foreground"
          data-slot="task-trying-again"
        >
          {tryingAgain(retryAt, now)}
        </span>
      ) : at ? (
        <span
          className="block font-normal text-muted-foreground"
          data-slot="task-last-activity"
        >
          {lead}{" "}
          <time dateTime={at} title={new Date(at).toLocaleString()}>
            {relativeTime(at)}
          </time>
        </span>
      ) : null}
    </>
  );
}

/** The way into a task's thread. */
function OpenThread({
  channelId,
  primary,
  children = "Open thread",
}: {
  channelId: string;
  primary?: boolean;
  children?: ReactNode;
}) {
  return (
    <Button
      render={<Link params={{ channelId }} to="/channel/$channelId" />}
      size="sm"
      variant={primary ? "default" : "outline"}
    >
      {children}
      <IconArrowUpRight data-icon="inline-end" />
    </Button>
  );
}

/**
 * Stop, on a task that is working or waiting on the person: the same stop as Stop in its thread.
 * The card reads Stopped as soon as the answer comes back, and the line saying how far it got
 * follows in the conversation.
 */
function StopTask({
  taskId,
  onError,
}: {
  taskId: string;
  onError: (message: string | null) => void;
}) {
  const stop = useMutation({
    ...stopTaskMutationOptions(queryClient),
    onMutate: () => onError(null),
    onError: (error) => onError(error.message),
  });
  return (
    <Button
      disabled={stop.isPending}
      onClick={() => stop.mutate(taskId)}
      size="sm"
      variant="ghost"
    >
      <IconPlayerStop data-icon="inline-start" />
      {stop.isPending ? "Stopping…" : "Stop"}
    </Button>
  );
}

/** A task's icon, with the dot that says it is moving, waiting or done. */
function StateIcon({ state }: { state: CardState }) {
  const { icon: Icon, dot } = STATE[state];
  return (
    <span className="relative flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground/80">
      <Icon className="size-4" />
      <span
        aria-hidden="true"
        className={cn(
          "absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-card",
          dot,
        )}
      />
    </span>
  );
}

/**
 * Which agent the Bot handed the task to, in one quiet line under the card's state: who is on it
 * while it works, who did it once it is done, and who it was handed to otherwise. Nothing for a task
 * the Bot does itself.
 */
export function agentLine(
  state: CardState,
  agent: BotTask["agent"],
): string | null {
  if (!agent?.name) return null;
  if (state === "working") return `${agent.name} is on it`;
  if (state === "done") return `Done by ${agent.name}`;
  return `Handed to ${agent.name}`;
}

/**
 * The card a task starts with in the conversation that asked for it, drawn from the Bot's
 * `delegate` call. It reads the task while it works, so it turns Needs you, Done or Couldn't finish
 * in place, and after a reload it shows where the task stands now.
 */
export function TaskCard({
  taskId,
  channelId,
  title,
  brief,
  refusal,
  children,
}: {
  /** Absent while the call is still on its way, or when it was refused. */
  taskId?: string;
  channelId?: string;
  title: string;
  brief?: string;
  /** Why no task was started, when the server said no. */
  refusal?: string;
  /** What sits directly under the card and belongs to it, such as the last thing the person told it. */
  children?: ReactNode;
}) {
  const task = useQuery({
    ...taskQueryOptions(taskId ?? ""),
    enabled: Boolean(taskId),
  });
  const state = cardState(taskId ? task.data : undefined);
  const [stopError, setStopError] = useState<string | null>(null);
  // The card's clock, once there is a task to time: every second while it works, and every half
  // minute otherwise.
  const now = useNow(
    state === "working" ? 1_000 : 30_000,
    task.data !== undefined,
  );
  if (refusal)
    return (
      <TaskFrame state="failed" title={title}>
        <p className="text-muted-foreground text-sm">{refusal}</p>
      </TaskFrame>
    );
  /*
   * What it waits for is said once, on the needs-you line the task posts, not here as well: the
   * card says only that it needs the person, and leads into the thread. Why it couldn't finish is
   * said once too, on the line it reports under the card, which also says what to do about it: the
   * card said the same reason a second time just above it.
   */
  const next =
    state === "stopped"
      ? TASK_STOPPED
      : state === "working" && !taskId
        ? "Starting…"
        : null;
  return (
    <TaskFrame
      below={children}
      times={
        task.data ? (
          <TaskTimes now={now} state={state} task={task.data} />
        ) : null
      }
      waiting={
        tryingAgainAt(task.data, state, now) !== undefined ? "retry" : undefined
      }
      action={
        channelId ? (
          <>
            {taskId && (state === "working" || state === "needs") ? (
              <StopTask onError={setStopError} taskId={taskId} />
            ) : null}
            <OpenThread channelId={channelId} primary={state === "needs"}>
              {state === "needs" ? "Go to thread" : "Open thread"}
            </OpenThread>
          </>
        ) : null
      }
      state={state}
      title={task.data?.title ?? title}
    >
      {taskId && agentLine(state, task.data?.agent) ? (
        <p className="text-muted-foreground text-xs" data-slot="task-agent">
          {agentLine(state, task.data?.agent)}
        </p>
      ) : null}
      {next ? (
        <p
          className={cn(
            "text-sm",
            state === "needs" ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {next}
        </p>
      ) : null}
      {brief && state === "working" ? (
        <p className="line-clamp-2 text-muted-foreground text-xs">{brief}</p>
      ) : null}
      {stopError ? (
        <p className="text-destructive text-xs" role="alert">
          {stopError}
        </p>
      ) : null}
    </TaskFrame>
  );
}

/** The frame every task card shares: icon and title, its state, what it says, and the way in. */
function TaskFrame({
  state,
  title,
  action,
  times,
  waiting,
  below,
  children,
}: {
  state: CardState;
  title: string;
  action?: ReactNode;
  /** Set while a working task waits to try again, so the card can be found as waiting. */
  waiting?: "retry";
  /** How long it has worked and when it last did something, after and under its state. */
  times?: ReactNode;
  /** What sits directly under the card, in the card's own column. */
  below?: ReactNode;
  children?: ReactNode;
}) {
  const { label, text } = STATE[state];
  return (
    <div className="my-2 w-full max-w-md space-y-1.5" data-slot="task">
      <section
        aria-label={`Task: ${title}`}
        className="w-full rounded-xl border border-border bg-card p-3 dark:border-transparent"
        data-slot="task-card"
        data-state={state}
        data-waiting={waiting}
      >
        <div className="flex items-start gap-3">
          <StateIcon state={state} />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-medium text-sm leading-snug">{title}</p>
            <p className={cn("font-medium text-xs", text)}>
              <span
                className={
                  state === "working" ? "tool-line-running" : undefined
                }
              >
                {label}
              </span>
              {times}
            </p>
            {children}
          </div>
        </div>
        {action ? (
          <div className="mt-3 flex flex-wrap justify-end gap-2">{action}</div>
        ) : null}
      </section>
      {below}
    </div>
  );
}

/**
 * What a task said in the conversation that asked for it: its result, that it needs the person, or
 * that it couldn't finish. The words are the Bot's own, drawn by the transcript; this frames them
 * with the task they are about and the way into its thread.
 */
export function TaskReport({
  taskId,
  kind,
  words,
  underCard = false,
  children,
}: {
  taskId: string;
  kind: DrawnTaskReportKind;
  /** What the report said, as text, to tell a request still waiting from one answered since. */
  words?: string;
  /**
   * A result drawn directly under its own task's card (`reportsUnderTheirCards`), which already
   * says which task it is and leads into its thread.
   */
  underCard?: boolean;
  children: ReactNode;
}) {
  const task = useQuery(taskQueryOptions(taskId));
  const title = task.data?.title;
  const channelId = task.data?.channelId;
  const live = cardState(task.data);
  if (kind === "result") {
    /*
     * A result that left the task waiting on the person (an app's Request access card drawn under
     * it) is not finished: its link reads as needing them, as the task's card does, not as done.
     */
    const waiting = live === "needs";
    /*
     * A result whose task then couldn't finish (an admin dismissed the Request access it waited on)
     * has no failed line under it, and the card says only that it couldn't finish: why is said here,
     * once, and the link doesn't read as done.
     */
    const failedSince = live === "failed";
    // A task the person stopped since: its link reads stopped, as its card does, not done.
    const stoppedSince = live === "stopped";
    const reason =
      failedSince && task.data?.failure
        ? failureSentence(task.data.failure)
        : null;
    const ResultIcon = waiting
      ? IconHandStop
      : failedSince
        ? IconAlertTriangle
        : stoppedSince
          ? IconPlayerStop
          : IconCircleCheck;
    return (
      <div
        className="w-full space-y-2"
        data-slot="task-report"
        data-kind={kind}
      >
        {/*
         * Which task this is, above what it found, and the way into its thread: the words and
         * anything the work drew follow, so the link never lands between a table and a chart.
         * Directly under the task's own card the card says both, so the task shows once.
         */}
        {channelId && !underCard ? (
          <Link
            className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-muted-foreground text-xs transition-colors hover:bg-muted/70 hover:text-foreground"
            data-state={
              waiting
                ? "needs"
                : failedSince
                  ? "failed"
                  : stoppedSince
                    ? "stopped"
                    : "done"
            }
            params={{ channelId }}
            to="/channel/$channelId"
          >
            <ResultIcon
              className={cn(
                "size-3.5 shrink-0",
                waiting
                  ? STATE.needs.text
                  : failedSince
                    ? STATE.failed.text
                    : stoppedSince
                      ? STATE.stopped.text
                      : "text-emerald-600 dark:text-emerald-400",
              )}
            />
            <span className="truncate">{title ?? "Task"}</span>
            <IconArrowUpRight className="size-3.5 shrink-0" />
          </Link>
        ) : null}
        {reason ? (
          <p className="text-sm">
            <span className={cn("font-medium text-xs", STATE.failed.text)}>
              {TASK_FAILED_LABEL}
            </span>
            <span className="text-muted-foreground"> · {reason}</span>
          </p>
        ) : null}
        {children}
      </div>
    );
  }
  // A task the person stopped says so here too: it did not fail, and its line is not an alarm.
  const stopped = kind === "failed" && live === "stopped";
  const state: CardState =
    kind === "needs" ? "needs" : stopped ? "stopped" : "failed";
  /*
   * A request answered since changes in place: it says it was answered and where the task is now,
   * and no longer asks. The task waiting on something else now is this one answered too.
   */
  const waitingNow = task.data?.next?.trim();
  const answered =
    kind === "needs" &&
    task.data !== undefined &&
    (live !== "needs" ||
      (waitingNow !== undefined &&
        words !== undefined &&
        waitingNow !== words.trim()));
  return (
    <section
      aria-label={
        kind === "needs"
          ? "This needs you"
          : stopped
            ? "A task was stopped"
            : "A task couldn't finish"
      }
      className={cn(
        "w-full max-w-md rounded-xl border p-3",
        kind === "needs"
          ? "border-amber-500/30 bg-amber-500/5"
          : stopped
            ? "border-border bg-card dark:border-transparent"
            : "border-destructive/30 bg-destructive/5",
        answered && "border-border bg-card opacity-80 dark:border-transparent",
      )}
      data-kind={kind}
      data-slot="task-report"
    >
      <div className="flex items-start gap-3">
        <StateIcon state={answered ? live : state} />
        <div className="min-w-0 flex-1 space-y-1">
          <p className={cn("font-medium text-xs", STATE[state].text)}>
            {kind === "needs"
              ? answered
                ? "Needed you"
                : "Needs you"
              : STATE[state].label}
            {title ? (
              <span className="text-muted-foreground"> · {title}</span>
            ) : null}
          </p>
          <div className="text-sm">
            {answered ? (
              <p className="text-muted-foreground">{ANSWERED[live]}</p>
            ) : (
              children
            )}
          </div>
        </div>
      </div>
      {channelId ? (
        <div className="mt-3 flex justify-end">
          <OpenThread
            channelId={channelId}
            primary={kind === "needs" && !answered}
          >
            {kind === "needs" && !answered ? "Go to thread" : "Open thread"}
          </OpenThread>
        </div>
      ) : null}
    </section>
  );
}

/**
 * What a needs-you line says once the person has answered, by where the task is now. Never where
 * they answered: the thread, the Bots page's Needs you board and the inbox all answer it, and the
 * line can't tell which. A task they stopped is the one exception: Stop withdraws what it waited
 * for, answered or not, so that line says only the stop.
 */
const ANSWERED: Record<CardState, string> = {
  working: "You answered this. It's carrying on.",
  needs: "You answered this. It needs you again in its thread.",
  done: "You answered this, and it's done.",
  failed: "You answered this, but it couldn't finish.",
  stopped: "You stopped this task, so it no longer needs this.",
};

/**
 * The task threads the Bot found when the person asked for a link, each with the way in.
 *
 * Each row reads its task as it is now, as the card does. The list is drawn from what the Bot was
 * told when it looked, and a task that needed the person then and has finished since read "Needs
 * you" under a card that said Done.
 */
export function ThreadLinks({ threads }: { threads: LinkedThread[] }) {
  return (
    <ul
      aria-label="Task threads"
      className="my-2 w-full max-w-md divide-y divide-border overflow-hidden rounded-xl border border-border bg-card dark:border-transparent"
    >
      {threads.map((thread) => (
        <ThreadLink key={thread.taskId} thread={thread} />
      ))}
    </ul>
  );
}

function ThreadLink({ thread }: { thread: LinkedThread }) {
  const task = useQuery(taskQueryOptions(thread.taskId));
  const state = cardState(task.data ?? { status: thread.status as TaskStatus });
  return (
    <li data-state={state}>
      <Link
        className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted"
        params={{ channelId: thread.channelId }}
        to="/channel/$channelId"
      >
        <StateIcon state={state} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-sm">
            {thread.title}
          </span>
          <span className={cn("block text-xs", STATE[state].text)}>
            {STATE[state].label}
          </span>
        </span>
        <IconArrowUpRight className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}

/**
 * The Bot's brief at the top of a task's thread: the work it was handed, said by the Bot, so the
 * thread reads as the Bot's and not as something the person typed.
 */
export function SentFromBot({
  threadId,
  brief,
}: {
  /** The task's thread, which names the task and so the Bot that sent it. */
  threadId: string | undefined;
  brief: string;
}) {
  const { data: bots } = useQuery(agentListQueryOptions());
  const { data: tasks } = useQuery(taskListQueryOptions());
  const task = tasks?.find((task) => task.threadId === threadId);
  const name = bots?.find((bot) => bot.id === task?.agentId)?.name;
  const label = `Sent from ${name ?? "your Bot"}`;
  // The agent the Bot handed it to, when it handed it to one: said after the link, as plain words.
  const to = task?.agent?.name ? ` to ${task.agent.name}` : "";
  return (
    <div
      className="flex w-full flex-col items-end gap-1"
      data-slot="task-brief"
    >
      <p className="text-muted-foreground text-xs">
        {/* The way back to the conversation that asked for the task. A check-in's task has none. */}
        {task?.originChannelId ? (
          <Link
            className="rounded-sm underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            params={{ channelId: task.originChannelId }}
            to="/channel/$channelId"
          >
            {label}
          </Link>
        ) : (
          label
        )}
        {to ? <span data-slot="task-agent">{to}</span> : null}
      </p>
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-muted px-4 py-2.5 text-sm">
        {brief}
      </div>
    </div>
  );
}

/** The reactions on one of the person's messages, read with the rest of its conversation's. */
export function MessageReactions(props: {
  threadId: string;
  messageId: string;
}) {
  /*
   * The transcript is drawn without the app's query client in places (a preview, a test of how it
   * scrolls), as it is without CopilotKit's. With none there is nothing to read reactions with.
   */
  const client = useContext(QueryClientContext);
  return client ? <ReadReactions {...props} /> : null;
}

function ReadReactions({
  threadId,
  messageId,
}: {
  threadId: string;
  messageId: string;
}) {
  const { data: reactions } = useQuery({
    ...reactionsQueryOptions(threadId),
    select: (all) => all.filter((reaction) => reaction.messageId === messageId),
  });
  return reactions?.length ? <ReactionChips reactions={reactions} /> : null;
}

/** A Bot's reactions under the person's message: the acknowledgement it gave in place of a line. */
export function ReactionChips({ reactions }: { reactions: Reaction[] }) {
  const { data: bots } = useQuery(agentListQueryOptions());
  if (reactions.length === 0) return null;
  return (
    <div className="mt-1 flex justify-end gap-1" data-slot="reactions">
      {reactions.map((reaction) => {
        const name =
          bots?.find((bot) => bot.id === reaction.agentId)?.name ?? "Your Bot";
        return (
          <span
            aria-label={`${name} reacted ${reaction.emoji}`}
            className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-card px-2 text-sm leading-none dark:border-transparent dark:bg-muted"
            key={`${reaction.agentId}:${reaction.emoji}`}
            role="img"
            title={`${name} reacted`}
          >
            {reaction.emoji}
          </span>
        );
      })}
    </div>
  );
}

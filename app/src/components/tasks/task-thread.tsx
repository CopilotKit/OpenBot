import type {
  LinkedThread,
  TaskReportKind,
} from "@openbot/shared/orchestration";
import {
  IconAlertTriangle,
  IconArrowUpRight,
  IconCircleCheck,
  IconHandStop,
  IconProgress,
} from "@tabler/icons-react";
import { QueryClientContext, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useContext } from "react";
import { Button } from "@/components/ui/button";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type Reaction,
  reactionsQueryOptions,
  type TaskStatus,
  taskListQueryOptions,
  taskQueryOptions,
} from "@/lib/tasks/queries";
import { cn } from "@/lib/utils";

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
type CardState = "working" | "needs" | "done" | "failed";

function cardState(status: TaskStatus | undefined): CardState {
  if (status === "needs_input") return "needs";
  if (status === "failed") return "failed";
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
    label: "Done",
    icon: IconCircleCheck,
    dot: "bg-emerald-500",
    text: "text-emerald-700 dark:text-emerald-400",
  },
  failed: {
    label: "Couldn't finish",
    icon: IconAlertTriangle,
    dot: "bg-destructive",
    text: "text-destructive",
  },
};

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
}: {
  /** Absent while the call is still on its way, or when it was refused. */
  taskId?: string;
  channelId?: string;
  title: string;
  brief?: string;
  /** Why no task was started, when the server said no. */
  refusal?: string;
}) {
  const task = useQuery({
    ...taskQueryOptions(taskId ?? ""),
    enabled: Boolean(taskId),
  });
  if (refusal)
    return (
      <TaskFrame state="failed" title={title}>
        <p className="text-muted-foreground text-sm">{refusal}</p>
      </TaskFrame>
    );
  const state = cardState(taskId ? task.data?.status : undefined);
  /*
   * What it waits for is said once, on the needs-you line the task posts, not here as well: the
   * card says only that it needs the person, and leads into the thread.
   */
  const next =
    state === "failed"
      ? (task.data?.failure ?? null)
      : state === "working" && !taskId
        ? "Starting…"
        : null;
  return (
    <TaskFrame
      action={
        channelId ? (
          <OpenThread channelId={channelId} primary={state === "needs"}>
            {state === "needs" ? "Go to thread" : "Open thread"}
          </OpenThread>
        ) : null
      }
      state={state}
      title={task.data?.title ?? title}
    >
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
    </TaskFrame>
  );
}

/** The frame every task card shares: icon and title, its state, what it says, and the way in. */
function TaskFrame({
  state,
  title,
  action,
  children,
}: {
  state: CardState;
  title: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  const { label, text } = STATE[state];
  return (
    <section
      aria-label={`Task: ${title}`}
      className="my-2 w-full max-w-md rounded-xl border border-border bg-card p-3 dark:border-transparent"
      data-slot="task-card"
      data-state={state}
    >
      <div className="flex items-start gap-3">
        <StateIcon state={state} />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium text-sm leading-snug">{title}</p>
          <p className={cn("font-medium text-xs", text)}>
            <span
              className={state === "working" ? "tool-line-running" : undefined}
            >
              {label}
            </span>
          </p>
          {children}
        </div>
      </div>
      {action ? <div className="mt-3 flex justify-end">{action}</div> : null}
    </section>
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
  children,
}: {
  taskId: string;
  kind: TaskReportKind;
  /** What the report said, as text, to tell a request still waiting from one answered since. */
  words?: string;
  children: ReactNode;
}) {
  const task = useQuery(taskQueryOptions(taskId));
  const title = task.data?.title;
  const channelId = task.data?.channelId;
  if (kind === "result")
    return (
      <div
        className="w-full space-y-2"
        data-slot="task-report"
        data-kind={kind}
      >
        {/*
         * Which task this is, above what it found, and the way into its thread: the words and
         * anything the work drew follow, so the link never lands between a table and a chart.
         */}
        {channelId ? (
          <Link
            className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-muted-foreground text-xs transition-colors hover:bg-muted/70 hover:text-foreground"
            params={{ channelId }}
            to="/channel/$channelId"
          >
            <IconCircleCheck className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span className="truncate">{title ?? "Task"}</span>
            <IconArrowUpRight className="size-3.5 shrink-0" />
          </Link>
        ) : null}
        {children}
      </div>
    );
  const state: CardState = kind === "needs" ? "needs" : "failed";
  const live = cardState(task.data?.status);
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
        kind === "needs" ? "This needs you" : "A task couldn't finish"
      }
      className={cn(
        "w-full max-w-md rounded-xl border p-3",
        kind === "needs"
          ? "border-amber-500/30 bg-amber-500/5"
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
              : "Couldn't finish"}
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

/** What a needs-you line says once the person has answered, by where the task is now. */
const ANSWERED: Record<CardState, string> = {
  working: "You answered this in its thread. It's carrying on.",
  needs: "You answered this in its thread. It needs you again there.",
  done: "You answered this in its thread, and it's done.",
  failed: "You answered this in its thread, but it couldn't finish.",
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
  const state = cardState(task.data?.status ?? (thread.status as TaskStatus));
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
  const agentId = tasks?.find((task) => task.threadId === threadId)?.agentId;
  const name = bots?.find((bot) => bot.id === agentId)?.name;
  return (
    <div
      className="flex w-full flex-col items-end gap-1"
      data-slot="task-brief"
    >
      <p className="text-muted-foreground text-xs">
        Sent from {name ?? "your Bot"}
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

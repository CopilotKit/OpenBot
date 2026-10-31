import { IconChevronRight, IconListCheck } from "@tabler/icons-react";
import { Link, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { TASK_STATUS_LABEL, type TaskStatus } from "@/lib/tasks/queries";
import { useTask } from "@/lib/tasks/use-task";
import { cn } from "@/lib/utils";
import { STATUS_TONE, TaskStatusMark } from "./task-status";

/** What a Bot's `start_task` answered with: the task it opened (server/src/tasks/tools.ts). */
export type StartedTask = { taskId: string; channelId: string; title: string };

const CARD =
  "group flex w-full max-w-md items-center gap-3 rounded-xl bg-card px-3.5 py-3 text-left shadow-(--shadow-card) outline-none transition-shadow duration-150 hover:shadow-(--shadow-raised) focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:transition-none";

/**
 * Where the task stands, as the card says it. It reads on from the Bot's "On it. I'll put the result
 * in Tasks.", so while the Bot works it says where: "Working in Tasks".
 */
export function cardStatusLine(status: TaskStatus | null): string {
  if (status === null || status === "working") return "Working in Tasks";
  return TASK_STATUS_LABEL[status];
}

/**
 * The card a conversation draws under the Bot's "On it": the task it started, where the task stands
 * now, and a way into it. Once there is something to read, the card says so louder: "Ready for
 * review · Open", in the done colour, with a ring of it. The work happens in the task's own conversation, so this card is all the
 * conversation shows of it. Its status is read from the person's tasks and kept live, so it moves
 * from Working to Ready for review, or to Needs you, while the card sits in the thread.
 */
export function ChatTaskCard({ started }: { started: StartedTask }) {
  const router = useRouter({ warn: false });
  const { task, status } = useTask(started.taskId);
  const title = task?.title ?? started.title;
  const ready = status === "ready_for_review";
  const className = cn(CARD, ready && "ring-1 ring-status-done/40");
  const body: ReactNode = (
    <>
      <span
        aria-hidden
        className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
      >
        <IconListCheck className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="type-sub block truncate font-medium">{title}</span>
        <span className="type-caption mt-0.5 flex items-center gap-1.5 text-muted-foreground">
          <TaskStatusMark status={status} />
          <span
            className={cn(
              status && status !== "working" && STATUS_TONE[status],
              (status === null || status === "working") && "tool-line-running",
              ready && "font-medium",
            )}
            data-status={status ?? undefined}
          >
            {cardStatusLine(status)}
            {ready ? <span className="text-foreground"> · Open</span> : null}
          </span>
        </span>
      </span>
      <IconChevronRight
        aria-hidden
        className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transition-none"
      />
    </>
  );
  // A conversation drawn on its own, as tests do, has no router to open the task with.
  return router ? (
    <Link
      className={className}
      params={{ taskId: started.taskId }}
      to="/tasks/$taskId"
    >
      {body}
    </Link>
  ) : (
    <a
      className={className}
      href={`/tasks/${encodeURIComponent(started.taskId)}`}
    >
      {body}
    </a>
  );
}

import { IconChevronRight, IconListCheck } from "@tabler/icons-react";
import { Link, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { TASK_STATUS_LABEL } from "@/lib/tasks/queries";
import { useTask } from "@/lib/tasks/use-task";
import { cn } from "@/lib/utils";
import { STATUS_TONE, TaskStatusMark } from "./task-status";

/** What a Bot's `start_task` answered with: the task it opened (server/src/tasks/tools.ts). */
export type StartedTask = { taskId: string; channelId: string; title: string };

const CARD =
  "group flex w-full max-w-md items-center gap-3 rounded-xl bg-card px-3.5 py-3 text-left shadow-(--shadow-card) outline-none transition-shadow duration-150 hover:shadow-(--shadow-raised) focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:transition-none";

/**
 * The card a conversation draws under the Bot's "On it": the task it started, where the task stands
 * now, and a way into it. The work happens in the task's own conversation, so this card is all the
 * conversation shows of it. Its status is read from the person's tasks and kept live, so it moves
 * from Working to Ready for review, or to Needs you, while the card sits in the thread.
 */
export function ChatTaskCard({ started }: { started: StartedTask }) {
  const router = useRouter({ warn: false });
  const { task, status } = useTask(started.taskId);
  const title = task?.title ?? started.title;
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
          {status ? (
            <span
              className={cn(
                status !== "working" && STATUS_TONE[status],
                status === "working" && "tool-line-running",
              )}
              data-status={status}
            >
              {TASK_STATUS_LABEL[status]}
            </span>
          ) : (
            <span>Task</span>
          )}
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
      className={CARD}
      params={{ taskId: started.taskId }}
      to="/tasks/$taskId"
    >
      {body}
    </Link>
  ) : (
    <a className={CARD} href={`/tasks/${encodeURIComponent(started.taskId)}`}>
      {body}
    </a>
  );
}

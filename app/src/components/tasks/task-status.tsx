import { IconCheck, IconX } from "@tabler/icons-react";
import { TASK_STATUS_LABEL, type TaskStatus } from "@/lib/tasks/queries";
import { cn } from "@/lib/utils";

/** The colour each status's words take: the four status colours, and muted for Done. */
export const STATUS_TONE: Record<TaskStatus, string> = {
  needs_input: "text-status-needs",
  working: "text-status-working",
  failed: "text-status-problem",
  ready_for_review: "text-status-done",
  resolved: "text-muted-foreground",
};

/**
 * Where a task stands, as a small mark: a turning ring while it works, a dot while it needs the
 * person, a check once there is something to read, a muted check once done, and a cross when it
 * couldn't finish. A ring, never a guess, before the task has been read.
 */
export function TaskStatusMark({
  status,
  className,
}: {
  status: TaskStatus | null;
  className?: string;
}) {
  if (status === null || status === "working")
    return (
      <span
        aria-hidden
        className={cn(
          "block size-3.5 shrink-0 animate-spin rounded-full border-[1.75px] border-status-working/25 border-t-status-working motion-reduce:animate-none",
          className,
        )}
        data-mark="working"
      />
    );
  if (status === "needs_input")
    return (
      <span
        aria-hidden
        className={cn("grid size-3.5 shrink-0 place-items-center", className)}
        data-mark="needs_input"
      >
        <span className="block size-2 rounded-full bg-status-needs" />
      </span>
    );
  const Glyph = status === "failed" ? IconX : IconCheck;
  return (
    <Glyph
      aria-hidden
      className={cn("size-3.5 shrink-0", STATUS_TONE[status], className)}
      data-mark={status}
      stroke={2.6}
    />
  );
}

/** The status in words, in its colour. */
export function TaskStatusWord({ status }: { status: TaskStatus }) {
  return (
    <span
      className={cn(
        "font-medium",
        STATUS_TONE[status],
        status === "working" && "tool-line-running",
      )}
      data-status={status}
    >
      {TASK_STATUS_LABEL[status]}
    </span>
  );
}

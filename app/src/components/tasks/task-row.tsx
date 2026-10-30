import {
  IconAlertTriangle,
  IconCircleCheck,
  IconFileCheck,
  IconHandStop,
  IconProgress,
} from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { relativeTime } from "@/lib/relative-time";
import type { ListedTask } from "@/lib/tasks/groups";
import {
  resolveTaskMutationOptions,
  tryTaskAgainMutationOptions,
} from "@/lib/tasks/mutations";
import {
  couldNotFinish,
  TASK_STATUS_LABEL,
  type TaskStatus,
} from "@/lib/tasks/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

const ICONS: Record<TaskStatus, typeof IconProgress> = {
  ready_for_review: IconFileCheck,
  needs_input: IconHandStop,
  failed: IconAlertTriangle,
  working: IconProgress,
  resolved: IconCircleCheck,
};

/**
 * The dot on a task's icon, as Activity draws one on work under way: green and pulsing while it
 * runs, amber while it waits on the person, red when it couldn't finish. A resolved task has none.
 */
const DOT: Partial<Record<TaskStatus, string>> = {
  working: "animate-pulse bg-emerald-500",
  needs_input: "bg-amber-500",
  ready_for_review: "bg-amber-500",
  failed: "bg-destructive",
};

/**
 * What a task needs next, after its status: why it couldn't finish, or the last thing its Bot said.
 * Before the Bot has said anything, a working task has just started.
 */
function nextLine({ task, status }: ListedTask): string | null {
  if (status === "failed") return couldNotFinish(task.failure);
  const said = task.next?.trim();
  if (said) return said;
  return status === "working" ? "Just started." : null;
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
}: {
  listed: ListedTask;
  botName: string;
}) {
  const { task, status } = listed;
  const resolve = useMutation(resolveTaskMutationOptions(queryClient));
  const again = useMutation(tryTaskAgainMutationOptions(queryClient));
  const Icon = ICONS[status];
  const dot = DOT[status];
  const next = nextLine(listed);
  const busy = resolve.isPending || again.isPending;
  const error = resolve.error ?? again.error;
  const openFirst = status === "ready_for_review" || status === "needs_input";
  return (
    <Item size="sm">
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
          {[TASK_STATUS_LABEL[status], botName, relativeTime(task.updatedAt)]
            .filter(Boolean)
            .join(" · ")}
        </ItemDescription>
        {next ? (
          <ItemDescription className="text-foreground">{next}</ItemDescription>
        ) : null}
        <ItemFooter className="mt-2 flex-wrap justify-start">
          {status === "failed" ? (
            <Button
              disabled={busy}
              onClick={() => again.mutate(task.id)}
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
          {status === "resolved" ? (
            <Button
              disabled={busy}
              onClick={() => resolve.mutate({ id: task.id, done: false })}
              size="sm"
              variant="outline"
            >
              {resolve.isPending ? "Reopening…" : "Reopen"}
            </Button>
          ) : (
            <Button
              disabled={busy}
              onClick={() => resolve.mutate({ id: task.id, done: true })}
              size="sm"
              variant="ghost"
            >
              {resolve.isPending ? "Saving…" : "Mark done"}
            </Button>
          )}
        </ItemFooter>
        {error ? (
          <p className="mt-1 text-destructive text-sm" role="alert">
            {error.message}
          </p>
        ) : null}
      </ItemContent>
    </Item>
  );
}

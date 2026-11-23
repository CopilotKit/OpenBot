import { IconCornerDownRight } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { relativeTimeShort } from "@/lib/relative-time";
import { taskKeys, taskQueryOptions } from "@/lib/tasks/queries";
import { queryClient } from "@/query-client";

/*
 * What the person told a task directly in its thread, said back in the conversation that started
 * it: one short line under the task's card.
 *
 * A person can open a task's thread and type into it, and the conversation that asked for the work
 * would otherwise go on describing the task as it was briefed. So the latest thing they told it is
 * quoted here, in their own words. One line, replaced by the next thing they tell it, never a line
 * for each. Only a steer is shown: an answer to the task's own question, approval or sign-in
 * request is the task being answered, which its needs-you line already says.
 *
 * Read from the task, with the card above it and from the same query, so it is there after a
 * reload and never on a task with no conversation behind it.
 */

/** The line under a task's card, or nothing while the person has told the task nothing. */
export function TaskSteer({ taskId }: { taskId: string }) {
  const { data: task } = useQuery(taskQueryOptions(taskId));
  const steer = task?.steer;
  // Only a task a conversation started has a conversation to say this in.
  if (!steer?.text || !task?.originChannelId) return null;
  return (
    <p
      className="-mt-1 mb-2 flex w-full max-w-md items-start gap-1.5 pr-1 pl-3 text-muted-foreground text-xs leading-relaxed"
      data-slot="task-steer"
    >
      <IconCornerDownRight
        aria-hidden="true"
        className="mt-0.5 size-3.5 shrink-0"
      />
      <span className="line-clamp-2 min-w-0 flex-1">
        <span className="font-medium text-foreground/80">You told it:</span>{" "}
        <q className="text-foreground/80">{steer.text}</q>
      </span>
      <time
        className="shrink-0 tabular-nums"
        dateTime={steer.at}
        title={new Date(steer.at).toLocaleString()}
      >
        {relativeTimeShort(steer.at)}
      </time>
    </p>
  );
}

/**
 * A steer landed in this conversation: its task is read again, so the card and the line under it
 * say what the person just told it. Draws nothing. The words are on the line under the card, once,
 * not in the transcript a second time.
 */
export function SteerLanded({ taskId }: { taskId: string }) {
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: taskKeys.one(taskId) });
  }, [taskId]);
  return null;
}

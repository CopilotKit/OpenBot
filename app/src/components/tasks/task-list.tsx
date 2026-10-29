import { IconListCheck } from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type KeyboardEvent, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { PageEmpty } from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { approvalInboxOptions } from "@/lib/approvals";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { type TaskItem, taskGroups } from "@/lib/tasks/groups";
import { taskListQueryOptions } from "@/lib/tasks/queries";
import { conversationFacts } from "@/lib/tasks/use-task";
import { cn } from "@/lib/utils";
import { STATUS_TONE } from "./task-status";
import { TaskSection } from "./task-section";

/** What marks a task's row, so the keyboard can find the rows in the order they are drawn. */
export const TASK_ROW = "data-task-row";

const agoFormat = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
  style: "narrow",
});
const UNITS = [
  { below: 60_000, size: 1_000, unit: "second" },
  { below: 3_600_000, size: 60_000, unit: "minute" },
  { below: 86_400_000, size: 3_600_000, unit: "hour" },
  { below: 604_800_000, size: 86_400_000, unit: "day" },
  { below: Number.POSITIVE_INFINITY, size: 604_800_000, unit: "week" },
] as const;

/** How long ago, in as few letters as the locale has: "5 min. ago", "yesterday". */
export function shortAgo(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const elapsed = Math.max(0, now - at);
  const scale = UNITS.find(({ below }) => elapsed < below) ?? UNITS[4];
  return agoFormat.format(-Math.round(elapsed / scale.size), scale.unit);
}

/** The row before or after the focused one, by the keys the list moves on. */
const STEP: Record<string, 1 | -1> = {
  ArrowDown: 1,
  j: 1,
  ArrowUp: -1,
  k: -1,
};

/** Every task row in `root`, in the order drawn. */
export function taskRows(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(`[${TASK_ROW}]`)];
}

/**
 * Moves focus through the list: down with ↓ or j, up with ↑ or k. Enter opens the focused row, as
 * any link does. Only while focus is on a row, so a key typed anywhere else is never taken.
 */
export function moveThroughRows(event: KeyboardEvent<HTMLElement>) {
  const step = STEP[event.key];
  if (!step || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement;
  if (!target.hasAttribute(TASK_ROW)) return;
  const rows = taskRows(event.currentTarget);
  const at = rows.indexOf(target);
  const next = rows[at + step];
  event.preventDefault();
  next?.focus();
}

/**
 * The Tasks list: every task, grouped by what it needs from the person (`taskGroups`).
 * Needs you comes first, then Working, Failed and Ready for review, each headed with how many. Done
 * starts folded. Each row is the Bot's orb, the task's title and the one line of what it needs next,
 * and opens the task beside the list.
 */
export function TaskList({ openTaskId }: { openTaskId?: string }) {
  const tasks = useQuery(taskListQueryOptions());
  const inbox = useQuery(approvalInboxOptions());
  const roster = useInfiniteQuery(channelListQueryOptions());
  const bots = useQuery(agentListQueryOptions());
  const [doneOpen, setDoneOpen] = useState(false);

  if (tasks.isPending) return null;
  // A refresh that fails keeps the tasks already read on screen.
  if (!tasks.data)
    return (
      <p className="px-4 py-3 text-destructive text-sm" role="alert">
        Couldn't load your tasks. Reload the page.
      </p>
    );

  const rows = new Map(
    (roster.data ?? []).map((channel) => [channel.id, channel]),
  );
  const groups = taskGroups({
    tasks: tasks.data,
    conversation: (channelId) => conversationFacts(rows.get(channelId)),
    requests: inbox.data?.requests,
    questions: inbox.data?.questions,
  });
  const botOf = (id: string) => bots.data?.find((bot) => bot.id === id);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the keys move focus between the links inside.
    <div
      className="flex flex-col gap-4 px-2 pt-2 pb-6"
      onKeyDown={moveThroughRows}
    >
      {tasks.isRefetchError ? (
        <p className="px-2 text-muted-foreground text-sm" role="status">
          Couldn't refresh your tasks. Reload the page.
        </p>
      ) : null}
      {groups.length === 0 ? (
        <div className="px-2">
          <PageEmpty icon={IconListCheck} title="No tasks yet">
            Bots move bigger work into tasks of their own. Start one with New
            task.
          </PageEmpty>
        </div>
      ) : (
        groups.map((group) => {
          const done = group.id === "resolved";
          // The open task is never folded away out of sight.
          const open =
            !done ||
            doneOpen ||
            group.items.some((item) => item.task.id === openTaskId);
          return (
            <TaskSection
              count={group.items.length}
              key={group.id}
              label={group.label}
              {...(done
                ? { onToggle: () => setDoneOpen((shown) => !shown), open }
                : {})}
            >
              <ul className="flex flex-col gap-px">
                {group.items.map((item) => (
                  <li key={item.task.id}>
                    <TaskRow bot={botOf(item.task.botId)} item={item} />
                  </li>
                ))}
              </ul>
            </TaskSection>
          );
        })
      )}
    </div>
  );
}

/**
 * One task: the Bot's orb, the title, and under it what the task needs next, in its status's colour
 * while it needs the person or couldn't finish. The whole row opens the task, and is lit while it is
 * the one open.
 */
function TaskRow({
  item,
  bot,
}: {
  item: TaskItem;
  bot: { name: string; avatarSeed: string } | undefined;
}) {
  const { task, status, next } = item;
  const name = bot?.name ?? "Bot";
  return (
    <Item
      className={cn(
        "px-3 py-2.5 [a]:hover:bg-card [a]:hover:shadow-(--shadow-card)",
        "aria-[current=page]:bg-card aria-[current=page]:shadow-(--shadow-card)",
      )}
      render={
        <Link
          data-status={status}
          data-task-id={task.id}
          data-task-row
          params={{ taskId: task.id }}
          to="/tasks/$taskId"
        />
      }
      size="sm"
    >
      <ItemMedia>
        <AbstractAvatar
          name={name}
          seed={bot?.avatarSeed ?? task.botId}
          size={32}
        />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="type-sub line-clamp-2 font-medium [overflow-wrap:anywhere]">
          {task.title}
        </ItemTitle>
        <ItemDescription
          className={cn(
            "type-caption line-clamp-1",
            (status === "needs_input" || status === "failed") &&
              STATUS_TONE[status],
            status === "working" && "tool-line-running",
          )}
        >
          {next}
        </ItemDescription>
      </ItemContent>
      {item.at ? (
        <ItemActions className="type-caption self-start text-muted-foreground">
          {shortAgo(item.at)}
        </ItemActions>
      ) : null}
    </Item>
  );
}

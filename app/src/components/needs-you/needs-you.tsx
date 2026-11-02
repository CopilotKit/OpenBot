import { IconChevronDown } from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Fragment, type ReactNode, useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { SuggestionRow } from "@/components/suggestions/suggestion-row";
import { TaskRow } from "@/components/tasks/task-row";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { botAttentionQueryOptions } from "@/lib/bot-lifecycle/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  type ProactiveSuggestion,
  proactiveSuggestionsQueryOptions,
} from "@/lib/proactive";
import { type ListedTask, orderTasks } from "@/lib/tasks/groups";
import { taskListQueryOptions } from "@/lib/tasks/queries";

/** How many items show before the rest fold behind "Show more". */
const ITEMS_SHOWN = 3;

/**
 * The Bot a row came from, by name: the roster's name, else the attention list's, which also names
 * a Bot the person hid from their roster.
 */
export function useBotName() {
  const bots = useQuery(agentListQueryOptions());
  const attention = useQuery(botAttentionQueryOptions());
  return (agentId: string) =>
    bots.data?.find((bot) => bot.id === agentId)?.name ??
    attention.data?.find((bot) => bot.agentId === agentId)?.name ??
    "Your Bot";
}

/**
 * What the person's check-ins and tasks put in front of them, for one Bot or across all of them.
 *
 * - `tasks`: every task not yet resolved, in OpenDuet's order (ready for review, needs input,
 *   failed, working). A working task stays beside the ones that need the person, because it is the
 *   item they just started and it comes back here when it is ready.
 * - `done`: tasks marked done this week, for Reopen.
 * - `items`: open items, newest first.
 *
 * A task's conversation that is running a turn reads Working: the busy signal comes from the
 * conversations list the sidebar keeps live over the socket.
 */
export function useNeedsYou(agentId?: string) {
  const suggestions = useQuery(proactiveSuggestionsQueryOptions());
  const taskList = useQuery(taskListQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const busy = (channelId: string) =>
    channels.data?.find((channel) => channel.id === channelId)?.busy === true;
  const mine = <Row extends { agentId: string }>(row: Row) =>
    agentId === undefined || row.agentId === agentId;
  const listed = orderTasks(
    (taskList.data ?? []).filter(mine),
    busy,
    Date.now(),
  );
  return {
    pending: suggestions.isPending || taskList.isPending,
    error: suggestions.error ?? taskList.error,
    tasks: listed.filter(({ status }) => status !== "resolved"),
    done: listed.filter(({ status }) => status === "resolved"),
    items: (suggestions.data ?? []).filter(mine),
  };
}

/**
 * The rows of a Needs you card: whatever the page leads with (`lead`, already rows), then the tasks,
 * then the items, the newest few with the rest a click away. Each row says which Bot it came from,
 * since one ping folds several Bots' items.
 *
 * Renders the card, or nothing when there is nothing to list.
 */
export function NeedsYouRows({
  lead = [],
  tasks,
  items,
}: {
  lead?: ReactNode[];
  tasks: ListedTask[];
  items: ProactiveSuggestion[];
}) {
  const botName = useBotName();
  const [expanded, setExpanded] = useState(false);
  /*
   * A Bot that piled up items would otherwise make its own page a wall of them with its settings
   * somewhere underneath, so the newest few show and the rest open in place. The list arrives
   * newest first.
   */
  const folded = expanded ? 0 : Math.max(0, items.length - ITEMS_SHOWN);
  const shown = folded ? items.slice(0, ITEMS_SHOWN) : items;
  const rows: { key: string; row: ReactNode }[] = [
    ...lead.map((row, index) => ({ key: `lead-${index}`, row })),
    ...tasks.map((listed) => ({
      key: `task-${listed.task.id}`,
      row: <TaskRow botName={botName(listed.task.agentId)} listed={listed} />,
    })),
    ...shown.map((item) => ({
      key: `item-${item.id}`,
      row: <SuggestionRow botName={botName(item.agentId)} suggestion={item} />,
    })),
  ];
  if (rows.length === 0) return null;
  return (
    <PageRows>
      {rows.map(({ key, row }, index) => (
        <Fragment key={key}>
          {index > 0 ? <Separator /> : null}
          {row}
        </Fragment>
      ))}
      {folded ? (
        <>
          <Separator />
          <Item
            onClick={() => setExpanded(true)}
            render={<button type="button" />}
            size="sm"
          >
            <ItemContent>
              <ItemTitle className="text-muted-foreground">
                Show {folded} more
              </ItemTitle>
            </ItemContent>
            <ItemActions>
              <IconChevronDown className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
        </>
      ) : null}
    </PageRows>
  );
}

/**
 * Tasks the person marked done this week, folded until asked for: a way back to Reopen one, not a
 * list everybody reads past. Not drawn when there are none.
 */
export function DoneTasks({ done }: { done: ListedTask[] }) {
  const botName = useBotName();
  const [open, setOpen] = useState(false);
  if (done.length === 0) return null;
  return (
    <PageSection
      action={
        <Button onClick={() => setOpen(!open)} size="sm" variant="ghost">
          {open ? "Hide" : "Show"}
        </Button>
      }
      description={`${done.length} ${done.length === 1 ? "task" : "tasks"} you marked done this week.`}
      title="Done"
    >
      {open ? (
        <PageRows>
          {done.map((listed, index) => (
            <Fragment key={listed.task.id}>
              {index > 0 ? <Separator /> : null}
              <TaskRow botName={botName(listed.task.agentId)} listed={listed} />
            </Fragment>
          ))}
        </PageRows>
      ) : null}
    </PageSection>
  );
}

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { TaskStatusMark } from "@/components/tasks/task-status";
import {
  SidebarGroupLabel,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { matchingTasks } from "@/lib/tasks/groups";
import {
  TASK_STATUS_LABEL,
  type TaskRecord,
  taskListQueryOptions,
} from "@/lib/tasks/queries";

/** As many tasks as a search shows under the conversations; Tasks has its own search for more. */
const SHOWN = 5;

/** The tasks a sidebar search finds, newest first. Read from the list Tasks keeps. */
export function useTaskMatches(query: string): readonly TaskRecord[] {
  const tasks = useQuery(taskListQueryOptions());
  if (!query.trim()) return [];
  return matchingTasks(tasks.data ?? [], query);
}

/**
 * The tasks a sidebar search found, under a heading of their own, each opening its task. A task's
 * conversation is not in the conversation list, so this is how a search reaches one. Each row says
 * where the task stands, in its mark and in its name.
 */
export function TaskMatches({ tasks }: { tasks: readonly TaskRecord[] }) {
  if (tasks.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-px" data-slot="task-matches">
      <SidebarGroupLabel render={(props) => <h2 {...props} />}>
        Tasks
      </SidebarGroupLabel>
      {tasks.slice(0, SHOWN).map((task) => (
        <SidebarMenuItem key={task.id}>
          <SidebarMenuButton
            aria-label={`${task.title}, ${TASK_STATUS_LABEL[task.status]}`}
            className="h-9 hover:bg-sidebar-accent hover:shadow-(--shadow-card)"
            render={<Link params={{ taskId: task.id }} to="/tasks/$taskId" />}
          >
            <TaskStatusMark status={task.status} />
            <span className="type-sub truncate">{task.title}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </div>
  );
}

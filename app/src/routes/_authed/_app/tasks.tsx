import { IconPlus } from "@tabler/icons-react";
import {
  createFileRoute,
  Outlet,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { NewTaskDialog } from "@/components/tasks/new-task-dialog";
import { TaskList, taskRows } from "@/components/tasks/task-list";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authed/_app/tasks")({
  component: TasksLayout,
});

/** Whether a key pressed here is someone typing, which the list's keys must leave alone. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

/** A dialog, a menu or a list box is open, and the key is its own. */
const somethingOpen = () =>
  document.querySelector(
    '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
  ) !== null;

/**
 * Tasks: the list in a column beside the open task. On a narrow screen the list has the screen to
 * itself, and opening a task gives the task the screen, with Back to return.
 *
 * Measured on the column Tasks is given, not the window, so the app's own sidebar being open or
 * closed decides it too: the two sit side by side once there are 56rem to share (a 360px list and a
 * conversation a comfortable width beside it).
 *
 * From the keyboard: ↓ and ↑, or j and k, move through the list, Enter opens a task, and Escape closes
 * it again with the focus back on its row. With nothing focused, j or k puts the focus in the list.
 */
function TasksLayout() {
  const { taskId } = useParams({ strict: false }) as { taskId?: string };
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey) return;
      if (event.altKey || typing(event.target) || somethingOpen()) return;
      const rows = () => (list.current ? taskRows(list.current) : []);
      if (event.key === "Escape" && taskId) {
        event.preventDefault();
        void navigate({ to: "/tasks" }).then(() =>
          // Back on the row it was opened from, once a narrow screen shows the list again.
          requestAnimationFrame(() =>
            rows()
              .find((row) => row.dataset.taskId === taskId)
              ?.focus(),
          ),
        );
        return;
      }
      const idle =
        event.target === document.body ||
        event.target === document.documentElement;
      if (idle && (event.key === "j" || event.key === "k")) {
        event.preventDefault();
        const shown = rows();
        (
          shown.find((row) => row.dataset.taskId === taskId) ?? shown[0]
        )?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navigate, taskId]);

  return (
    <div className="@container flex min-h-0 flex-1">
      <div
        className={cn(
          "min-h-0 w-full flex-col @4xl:flex @4xl:w-90 @4xl:shrink-0 @4xl:border-border @4xl:border-r",
          taskId ? "hidden" : "flex",
        )}
        data-slot="task-list-column"
      >
        <div className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-border border-b px-3 py-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <SidebarToggle />
            <h1 className="type-sub truncate pl-1 font-semibold">Tasks</h1>
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="New task"
                  onClick={() => setAdding(true)}
                  size="icon"
                  variant="ghost"
                />
              }
            >
              <IconPlus />
            </TooltipTrigger>
            <TooltipContent side="bottom">New task</TooltipContent>
          </Tooltip>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto" ref={list}>
          <TaskList openTaskId={taskId} />
        </div>
      </div>
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col @4xl:flex",
          taskId ? "flex" : "hidden",
        )}
        data-slot="task-pane"
      >
        <Outlet />
      </div>
      {adding ? (
        <NewTaskDialog
          onClose={() => setAdding(false)}
          onStarted={(task) => {
            setAdding(false);
            void navigate({
              to: "/tasks/$taskId",
              params: { taskId: task.id },
            });
          }}
        />
      ) : null}
    </div>
  );
}

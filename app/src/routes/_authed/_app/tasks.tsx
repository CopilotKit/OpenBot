import { IconPlus, IconSearch } from "@tabler/icons-react";
import {
  createFileRoute,
  Outlet,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import {
  EMPTY_DRAFT,
  NewTaskDialog,
  type TaskDraft,
} from "@/components/tasks/new-task-dialog";
import { TaskList, taskRows } from "@/components/tasks/task-list";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
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
 * While the open task's computer is open beside it, the list folds away to give the two the room.
 *
 * From the keyboard: ↓ and ↑, or j and k, move through the list, Enter opens a task, and Escape closes
 * it again with the focus back on its row. With nothing focused, j or k puts the focus in the list.
 */
function TasksLayout() {
  const { taskId } = useParams({ strict: false }) as { taskId?: string };
  const watching = useSearch({
    strict: false,
    select: (search) => (search as { watch?: boolean }).watch === true,
  });
  const folded = Boolean(taskId) && watching;
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  // Kept here, so closing New task without starting it keeps what was typed.
  const [draft, setDraft] = useState<TaskDraft>(EMPTY_DRAFT);
  const [filter, setFilter] = useState("");
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
          "min-h-0 w-full flex-col @4xl:w-90 @4xl:shrink-0 @4xl:border-border @4xl:border-r",
          taskId ? "hidden" : "flex",
          !folded && "@4xl:flex",
        )}
        data-folded={folded ? "" : undefined}
        data-slot="task-list-column"
      >
        <div className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-border border-b px-3 py-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <SidebarToggle />
            <h1 className="type-sub truncate pl-1 font-semibold">Tasks</h1>
          </div>
          {/*
           * Labelled, unlike the sidebar's + beside it, which starts a conversation: two bare +
           * side by side read as one control.
           */}
          <Button
            data-slot="new-task"
            onClick={() => setAdding(true)}
            size="sm"
            variant="outline"
          >
            <IconPlus />
            New task
          </Button>
        </div>
        {/* The list's own search, on a row of its own above the list, as the sidebar's is. */}
        <div className="shrink-0 px-2 pt-2">
          <InputGroup className="h-9 rounded-lg bg-muted text-sm">
            <InputGroupInput
              aria-label="Search tasks"
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Search tasks…"
              value={filter}
            />
            <InputGroupAddon>
              <IconSearch />
            </InputGroupAddon>
          </InputGroup>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto" ref={list}>
          <TaskList openTaskId={taskId} query={filter} />
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
          draft={draft}
          onCancel={() => {
            setDraft(EMPTY_DRAFT);
            setAdding(false);
          }}
          onClose={() => setAdding(false)}
          onDraftChange={setDraft}
          onStarted={(task) => {
            setDraft(EMPTY_DRAFT);
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

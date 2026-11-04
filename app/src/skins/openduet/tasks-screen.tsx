import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { useWaitingRows } from "@/components/approvals/waiting";
import { NeedsYouRows, useNeedsYou } from "@/components/needs-you/needs-you";
import { BotResponsibilities } from "@/components/responsibilities/responsibilities";
import { RoutinesList } from "@/components/routines/routines-list";
import { SuggestionsInbox } from "@/components/suggestions/proactive-panel";
import { routinesQueryOptions } from "@/lib/routines/queries";
import { TASK_ORDER } from "@/lib/tasks/groups";
import { TASK_STATUS_LABEL } from "@/lib/tasks/queries";
import { cn } from "@/lib/utils";
import { FOCUS } from "./kit";

/** Which list Tasks shows: what waits on you and what your Bots carry, or what to start next. */
export type TasksView = "active" | "up_next";

/** Which list was open last, kept in this browser between visits. */
export const TASKS_VIEW_STORAGE_KEY = "openduet.tasks-view";

function rememberedView(): TasksView {
  try {
    return window.localStorage.getItem(TASKS_VIEW_STORAGE_KEY) === "up_next"
      ? "up_next"
      : "active";
  } catch {
    return "active";
  }
}

function rememberView(view: TasksView) {
  try {
    window.localStorage.setItem(TASKS_VIEW_STORAGE_KEY, view);
  } catch {
    // Storage can be refused. The list still switches; it opens on Active next time.
  }
}

/**
 * OpenDuet's Tasks: its two big words, Active and Up next, over OpenBot's own screens.
 *
 * Every row here is OpenBot's own: its task rows and its approval and question rows, then
 * `BotResponsibilities` for responsibilities, `RoutinesList` for routines and `SuggestionsInbox` for
 * what check-ins found. So every choice, field and confirmation OpenBot offers is here, and a new
 * one arrives without this screen changing. The skin adds only the switch, the headings and the
 * layout around them.
 */
export function TasksScreen() {
  const [view, setView] = useState<TasksView>(rememberedView);
  const show = (next: TasksView) => {
    setView(next);
    rememberView(next);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-[100px] pb-[calc(var(--openduet-tab-space,86px)+32px)]">
        <TasksSwitch onView={show} view={view} />
        <div
          aria-labelledby={`openduet-tasks-tab-${view}`}
          id="openduet-tasks-panel"
          role="tabpanel"
        >
          {view === "active" ? <ActiveView /> : <SuggestionsInbox />}
        </div>
      </div>
    </div>
  );
}

/**
 * Active and Up next as two large words, the one showing in ink and the other grey. It sticks
 * under the header while the list scrolls, solid up to the discs and fading under.
 */
function TasksSwitch({
  view,
  onView,
}: {
  view: TasksView;
  onView: (view: TasksView) => void;
}) {
  return (
    <div
      className={cn(
        "sticky top-[-20px] z-30 -mx-4 mb-3 bg-openduet-surface px-5 pt-1 pb-2",
        "before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-[14px] before:bg-openduet-surface before:content-['']",
        "after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-4 after:bg-[linear-gradient(var(--openduet-surface),transparent)] after:content-['']",
      )}
    >
      <div
        aria-label="Tasks"
        className="flex min-h-11 min-w-0 flex-wrap items-center gap-x-4"
        role="tablist"
      >
        <SwitchTab id="active" onView={onView} view={view}>
          Active
        </SwitchTab>
        <SwitchTab id="up_next" onView={onView} view={view}>
          Up next
        </SwitchTab>
      </div>
    </div>
  );
}

function SwitchTab({
  id,
  view,
  onView,
  children,
}: {
  id: TasksView;
  view: TasksView;
  onView: (view: TasksView) => void;
  children: ReactNode;
}) {
  const on = id === view;
  return (
    <button
      aria-controls="openduet-tasks-panel"
      aria-selected={on}
      className={cn(
        "openduet-type-display rounded-lg font-semibold transition-colors motion-reduce:transition-none",
        FOCUS,
        on
          ? "text-openduet-ink"
          : "text-openduet-ink-3 hover:text-openduet-ink-2",
      )}
      id={`openduet-tasks-tab-${id}`}
      onClick={() => onView(id)}
      role="tab"
      type="button"
    >
      {children}
    </button>
  );
}

/**
 * Active: the person's tasks grouped by what each needs from them, in OpenDuet's order (Ready for
 * review, Needs input, Failed, Working, Resolved this week), then the responsibilities and routines
 * their Bots carry, in OpenBot's own lists. Needs input also holds the approvals and questions
 * waiting outside any task, decided in OpenBot's own rows. A group with nothing in it is left out.
 */
function ActiveView() {
  const routines = useQuery(routinesQueryOptions());
  const waiting = useWaitingRows(undefined);
  const { tasks, done } = useNeedsYou();
  const listed = [...tasks, ...done];

  return (
    <div className="flex flex-col gap-9">
      {TASK_ORDER.map((status) => {
        const group = listed.filter((entry) => entry.status === status);
        const lead = status === "needs_input" ? waiting.rows : [];
        if (group.length + lead.length === 0) return null;
        return (
          <Section
            count={group.length + lead.length}
            key={status}
            label={TASK_STATUS_LABEL[status]}
          >
            <NeedsYouRows items={[]} lead={lead} tasks={group} />
          </Section>
        );
      })}
      {waiting.error ? (
        <p className="text-destructive text-sm" role="alert">
          {waiting.error.message}
        </p>
      ) : null}
      <BotResponsibilities />
      <Section count={routines.data?.routines.length} label="Routines">
        <RoutinesList embedded />
      </Section>
    </div>
  );
}

/** A section heading in OpenDuet's grey, with how many, over an OpenBot list. */
function Section({
  label,
  count,
  children,
}: {
  label: string;
  /** Left off until the list has loaded, so the heading never states a wrong number. */
  count: number | undefined;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="flex flex-col">
      <h2 className="openduet-type-body flex min-h-11 items-center px-1 font-normal text-openduet-ink-2">
        {label}
        {count === undefined ? null : (
          <span className="ml-1.5 tabular-nums">{count}</span>
        )}
      </h2>
      {children}
    </section>
  );
}

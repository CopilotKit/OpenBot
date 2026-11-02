import {
  IconMessage,
  IconShieldCheck,
  IconSparkles,
  IconX,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { describeApproval } from "@/lib/approval-view";
import type {
  ReportDecision,
  ReportEntry,
  TaskReport,
} from "@/lib/tasks/queries";
import { cn } from "@/lib/utils";

/*
 * A task's report: what the person decided, what the Bot said as each turn ended, and the person's
 * replies, in the order they happened. Drawn above the task's conversation, so the page reads as
 * what happened first and the whole conversation after.
 */

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const dayFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** "today at 9:41 AM", "yesterday at 9:41 AM", or "on Oct 20". Empty for a time that is not one. */
export function whenLine(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  if (sameDay(at, now)) return `today at ${timeFormat.format(at)}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(at, yesterday)) return `yesterday at ${timeFormat.format(at)}`;
  return `on ${dayFormat.format(at)}`;
}

type Opened = { origin: "asked" | "suggestion"; createdAt: string };

const howOf = (task: Opened) =>
  task.origin === "asked" ? "You asked" : "Suggested";

/** How a task began and when: "You asked today at 9:41 AM", or "Suggested today at 9:41 AM". */
export function beganLine(task: Opened, now = new Date()): string {
  const when = whenLine(task.createdAt, now);
  return when ? `${howOf(task)} ${when}` : howOf(task);
}

/**
 * How a task began, from its report: "You asked: “…”" in the person's words, when, and for a task
 * started from a suggestion, why. The why is the report's, which only a suggestion has; a task the
 * person asked for is explained by their own words. Before the report arrives, how and when alone.
 * `clamped` holds the ask to one line, for a report folded away.
 */
export function TaskOpening({
  task,
  report,
  clamped = false,
  now,
}: {
  task: Opened;
  report: TaskReport | undefined;
  clamped?: boolean;
  now?: Date;
}) {
  if (!report)
    return (
      <p className="type-caption text-muted-foreground">
        {beganLine(task, now)}
      </p>
    );
  const when = whenLine(task.createdAt, now);
  const why = report.why?.trim();
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-slot="task-opening">
      <p
        className={cn(
          "type-sub [overflow-wrap:anywhere]",
          clamped && "line-clamp-1",
        )}
      >
        <span className="font-medium">{howOf(task)}:</span> “{report.ask}”
      </p>
      {clamped ? null : (
        <>
          {when ? (
            <p className="type-caption text-muted-foreground">
              {when.charAt(0).toUpperCase() + when.slice(1)}
            </p>
          ) : null}
          {why ? (
            <p className="type-caption text-muted-foreground [overflow-wrap:anywhere]">
              <span className="font-medium">Why:</span> {why}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** A stamp on a report row: the time today, the day before that. Empty when no ledger saw it. */
export function stampOf(iso: string | null, now = new Date()): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  return sameDay(at, now) ? timeFormat.format(at) : dayFormat.format(at);
}

const VERDICT: Record<ReportDecision["decision"], string> = {
  allow_once: "Allowed once",
  allow_always: "Always allowed",
  deny: "Declined",
  handled: "You did it yourself",
};

/** "Allowed once: Send your email to ana@hearth.example", named the way the approval card names it. */
export function decisionLine(entry: ReportDecision): string {
  const view = describeApproval({
    // The card's words come from the action alone; whose and where are not part of them.
    action: { target: null, ...entry.action, botId: "", threadId: "" },
  });
  const to = view.fields.find((field) => field.label === "To")?.value;
  return `${VERDICT[entry.decision]}: ${view.title}${to ? ` to ${to}` : ""}`;
}

const LOOK = {
  allowed: {
    Icon: IconShieldCheck,
    tone: "bg-status-done-soft text-status-done",
  },
  declined: { Icon: IconX, tone: "bg-status-problem-soft text-status-problem" },
  reply: { Icon: IconMessage, tone: "bg-muted text-muted-foreground" },
  update: { Icon: IconSparkles, tone: "bg-brand/10 text-brand" },
} as const;

function lookOf(entry: ReportEntry) {
  if (entry.kind === "decision")
    return LOOK[entry.decision === "deny" ? "declined" : "allowed"];
  return LOOK[entry.kind];
}

/**
 * The report's rows on a thin line, each with a mark for what it is, what happened, and when.
 * Nothing while it loads or before anything happened: the conversation under it says the same.
 */
export function TaskReportView({
  report,
  error,
  onReload,
  now,
}: {
  report: TaskReport | undefined;
  error: Error | null;
  /** Reads the report again, offered when it came back without the conversation. */
  onReload?: () => void;
  now?: Date;
}) {
  // A refresh that fails keeps the report already read, as the task's page keeps the task.
  if (!report)
    return error ? (
      <p className="text-destructive text-sm" role="alert">
        Couldn't load this task's report. Reload the page.
      </p>
    ) : null;
  // The conversation wasn't read in time: only the decisions came back, and the person is told so.
  const partial = report.partial ? (
    <p
      className="type-sub flex flex-wrap items-center gap-x-2 text-muted-foreground"
      role="status"
    >
      Couldn't read this task's conversation in time. Only your decisions show
      here.
      {onReload ? (
        <Button
          className="h-auto px-0"
          onClick={onReload}
          size="sm"
          variant="link"
        >
          Reload
        </Button>
      ) : null}
    </p>
  ) : null;
  if (report.entries.length === 0) return partial;
  return (
    <section aria-labelledby="task-report-heading">
      {partial ? <div className="mb-3">{partial}</div> : null}
      <h2
        className="type-caption mb-2 font-medium text-muted-foreground"
        id="task-report-heading"
      >
        Decisions and updates
      </h2>
      <ol aria-labelledby="task-report-heading" className="flex flex-col">
        {report.entries.map((entry, index) => {
          const { Icon, tone } = lookOf(entry);
          const stamp = stampOf(entry.at, now);
          const last = index === report.entries.length - 1;
          return (
            <li
              className="relative flex gap-3 pb-3 last:pb-0"
              data-entry={entry.kind}
              key={`${entry.kind}:${entry.id}`}
            >
              {last ? null : (
                <span
                  aria-hidden
                  className="absolute top-7 bottom-0 left-3 w-px bg-border"
                />
              )}
              <span
                aria-hidden
                className={cn(
                  "relative grid size-6 shrink-0 place-items-center rounded-full",
                  tone,
                )}
              >
                <Icon className="size-3.5" stroke={2.1} />
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <p className="type-sub [overflow-wrap:anywhere]">
                  {entry.kind === "decision" ? (
                    <span className="font-medium">{decisionLine(entry)}</span>
                  ) : entry.kind === "reply" ? (
                    <>
                      <span className="font-medium">You:</span>{" "}
                      <span className="text-muted-foreground">
                        {entry.text}
                      </span>
                    </>
                  ) : (
                    entry.text
                  )}
                </p>
                {entry.kind === "decision" || stamp ? (
                  <p className="type-caption mt-0.5 text-muted-foreground">
                    {entry.kind === "decision"
                      ? stamp
                        ? `By you · ${stamp}`
                        : "By you"
                      : stamp}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

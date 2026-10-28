/**
 * Everything the Bot has done on its computer, oldest first and newest last, under the screen.
 *
 * Two sources, one list. Browser steps come from the conversation's messages, through the route's
 * presence (`useConversationSteps`): a click the person approves runs on the server once they allow
 * it and never reaches a browser handler, so the conversation is the only place that sees every
 * step. Commands and files come from this session's command log (`lib/computers/activity.ts`), which
 * has what they printed. Each is placed by when this tab first saw it.
 *
 * Every step is named in the words its own line in the conversation uses, and says how it went in
 * the status colours: done in green, waiting for you in amber, didn't work or blocked in red. The
 * rest (running, cut off, declined) stay grey, since none of them is something to act on here.
 *
 * Outside a conversation route there are no browser steps to read, and the log is the command log.
 */
import { IconCircleCheck, IconClock, IconX } from "@tabler/icons-react";
import { type ReactNode, useSyncExternalStore } from "react";
import { browserOutcome } from "@/components/channels/browser-activity";
import {
  type ConversationStep,
  useConversationStatus,
  useConversationSteps,
} from "@/components/channels/conversation-presence";
import {
  STEP_STATUS,
  stepDetails,
  useHeldForPerson,
} from "@/components/channels/tool-activity";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  activityFor,
  type ComputerActivity,
  subscribeToActivity,
} from "@/lib/computers/activity";
import { cn } from "@/lib/utils";
import {
  ACTIVITY_LABELS,
  ActivityOutput,
  activityStatus,
  timeOf,
} from "./activity-log";

/** How a step stands. Only `done` goes unsaid: its mark says it. */
export type StepState =
  | "done"
  | "running"
  | "waiting"
  | "stopped"
  | "notYet"
  | "declined"
  | "blocked"
  | "failed";

export type StepLogEntry =
  | {
      kind: "browser";
      id: string;
      at: number;
      status: StepState;
      /** "Opened page", "Clicked on page": the conversation's words for it. */
      label: string;
      /** The page it opened, named. */
      detail?: string;
      href?: string;
      /** Why a step that was tried did not work. */
      reason?: string;
    }
  | {
      kind: "activity";
      id: string;
      at: number;
      status: StepState;
      activity: ComputerActivity;
    };

/**
 * A browser step's state. One held on its approval card is waiting for the person, whatever its
 * result says yet. One with no result, or only the note that it went to the card, is running while
 * the Bot is on the turn it belongs to, and otherwise was cut off. One with a result is read by
 * `browserOutcome`, the same reading its line in the conversation uses: the person declined it,
 * somebody pressed Stop, a boundary refused it, the computer was still starting, it did not work,
 * or it worked.
 */
function browserState(
  step: ConversationStep,
  { working, held }: { working: boolean; held: ReadonlySet<string> },
): StepState {
  if (held.has(step.item.toolCall.id)) return "waiting";
  const outcome = browserOutcome(step.item);
  if (outcome === "pending")
    return working && step.latest ? "running" : "stopped";
  return outcome;
}

/**
 * The browser steps and the command log as one list, oldest first. Stable, so steps seen at the
 * same moment, such as a conversation's history arriving at once, keep the conversation's order.
 */
export function stepLogEntries(
  steps: readonly ConversationStep[],
  activity: readonly ComputerActivity[],
  context: { working: boolean; held: ReadonlySet<string> },
): StepLogEntry[] {
  const browser = steps.map((step): StepLogEntry => {
    const status = browserState(step, context);
    const details = stepDetails(step.item);
    return {
      kind: "browser",
      id: step.item.id,
      at: step.at,
      status,
      label: details.label,
      ...(details.detail ? { detail: details.detail } : {}),
      ...(details.href ? { href: details.href } : {}),
      ...(status === "failed"
        ? { reason: details.reason ?? "Couldn't finish this step." }
        : {}),
    };
  });
  const commands = activity.map(
    (entry): StepLogEntry => ({
      kind: "activity",
      id: entry.id,
      at: entry.at,
      status: activityStatus(entry),
      activity: entry,
    }),
  );
  return [...browser, ...commands].sort((a, b) => a.at - b.at);
}

const MARKS = {
  done: { Icon: IconCircleCheck, tone: "text-status-done" },
  waiting: { Icon: IconClock, tone: "text-status-needs" },
  running: { Icon: IconClock, tone: "text-muted-foreground" },
  stopped: { Icon: IconClock, tone: "text-muted-foreground" },
  notYet: { Icon: IconClock, tone: "text-muted-foreground" },
  declined: { Icon: IconX, tone: "text-muted-foreground" },
  blocked: { Icon: IconX, tone: "text-status-problem" },
  failed: { Icon: IconX, tone: "text-status-problem" },
} as const;

/** The colour a state's words take: amber for the person's turn, red for a problem, else grey. */
function toneOf(status: StepState): string {
  if (status === "waiting") return "text-status-needs";
  if (status === "blocked" || status === "failed") return "text-status-problem";
  return "text-muted-foreground";
}

function StepRow({
  entry,
  children,
}: {
  entry: StepLogEntry;
  /** What the step was done to, after its words. */
  children?: ReactNode;
}) {
  const { Icon, tone } = MARKS[entry.status];
  const label =
    entry.kind === "browser"
      ? entry.label
      : ACTIVITY_LABELS[entry.activity.kind];
  return (
    <li
      className="border-border/60 border-b py-2.5 last:border-b-0"
      data-step={entry.id}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <Icon
          aria-hidden
          className={cn("size-4 shrink-0 translate-y-[3px]", tone)}
          stroke={2.2}
        />
        <span
          className={cn(
            "type-sub shrink-0 font-medium",
            entry.status === "running" && "tool-line-running",
          )}
        >
          {label}
        </span>
        {children}
        <span className="type-caption ml-auto flex shrink-0 items-baseline gap-2">
          {entry.status === "done" ? null : (
            <span className={cn("font-medium", toneOf(entry.status))}>
              {STEP_STATUS[entry.status]}
            </span>
          )}
          {/*
            A command's time is when it ran. A browser step's is only when this tab first saw it,
            which for a conversation opened later is not when it happened, so it is not shown.
          */}
          {entry.kind === "activity" ? (
            <span className="text-muted-foreground tabular-nums">
              {timeOf(entry.at)}
            </span>
          ) : null}
        </span>
      </div>
      {entry.kind === "browser" && entry.reason ? (
        <p className="type-caption mt-1 pl-6 text-status-problem">
          {entry.reason}
        </p>
      ) : null}
      {entry.kind === "activity" ? (
        <div className="mt-1 pl-6">
          <ActivityOutput entry={entry.activity} />
        </div>
      ) : null}
    </li>
  );
}

function BrowserSubject({
  entry,
}: {
  entry: Extract<StepLogEntry, { kind: "browser" }>;
}) {
  if (entry.href)
    return (
      <a
        className="type-sub min-w-0 truncate rounded-sm text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 outline-none hover:decoration-current focus-visible:ring-2 focus-visible:ring-ring"
        href={entry.href}
        rel="noopener noreferrer"
        target="_blank"
      >
        {entry.detail ?? entry.href}
      </a>
    );
  return entry.detail ? (
    <span className="type-sub min-w-0 truncate text-muted-foreground">
      {entry.detail}
    </span>
  ) : null;
}

export function StepLog({ computerId }: { computerId: string }) {
  const steps = useConversationSteps();
  const activity = useSyncExternalStore(
    subscribeToActivity,
    () => activityFor(computerId),
    () => activityFor(computerId),
  );
  const working = useConversationStatus().kind === "working";
  const held = useHeldForPerson();
  const entries = stepLogEntries(steps, activity, { working, held });

  if (entries.length === 0) {
    return (
      <Empty className="h-[180px] border border-dashed">
        <EmptyHeader>
          <EmptyTitle className="text-muted-foreground">
            Nothing yet. Pages the Bot opens and commands it runs appear here.
          </EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ol className="min-w-0">
      {entries.map((entry) =>
        entry.kind === "browser" ? (
          <StepRow entry={entry} key={entry.id}>
            <BrowserSubject entry={entry} />
          </StepRow>
        ) : (
          <StepRow entry={entry} key={entry.id}>
            {/*
              The command wraps rather than truncating. In the transcript one line per call is what
              keeps it readable; here the whole point is to see exactly what ran, and a long command
              with its middle cut out is the one thing this pane must not do.
            */}
            <code className="min-w-0 break-all font-mono text-xs">
              {entry.activity.subject}
            </code>
          </StepRow>
        ),
      )}
    </ol>
  );
}

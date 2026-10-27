import type { ApprovalInboxData } from "@/lib/approvals";
import type { ProactiveSuggestion } from "@/lib/proactive";
import type { ResponsibilityRecord } from "@/lib/responsibilities";
import type { RoutineRecord } from "@/lib/routines/queries";

/*
 * What OpenDuet's Tasks shows, worked out from OpenBot's own data and nothing else. Every section
 * here is something OpenBot already keeps: what waits on the person in the approval inbox, the
 * responsibilities and routines their Bots carry, and the next steps background research suggested.
 * OpenDuet's own tasks, pages and morning brief have no OpenBot behind them, so they are not here.
 */

export type ApprovalRequest = ApprovalInboxData["requests"][number];
export type PersonQuestion = ApprovalInboxData["questions"][number];

export type SortOrder = "newest" | "oldest";

/** Whether `text` holds what the person typed into search, ignoring case. An empty search holds. */
export function matchesSearch(text: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || text.toLowerCase().includes(needle);
}

function byTime<T>(rows: T[], at: (row: T) => string, order: SortOrder): T[] {
  const sign = order === "newest" ? -1 : 1;
  return [...rows].sort((a, b) => sign * at(a).localeCompare(at(b)));
}

/** The actions still waiting on a decision. A decided one has already gone its way. */
export function pendingRequests(inbox: ApprovalInboxData | undefined) {
  return (inbox?.requests ?? []).filter(
    (request) => request.status === "pending",
  );
}

/**
 * How many things wait on the person: pending approvals and unanswered questions. The Tasks badge
 * and Needs input's own count are both this number.
 */
export function waitingCount(inbox: ApprovalInboxData | undefined): number {
  return pendingRequests(inbox).length + (inbox?.questions.length ?? 0);
}

/**
 * What a waiting action is, in a few words, from the tool it would call: the tool's own name, after
 * the app it belongs to (`mcp/gmail/send_email`), the host (`host/run_command`) or the computer
 * (`computer_click`).
 */
export function actionName(toolRef: string): string {
  const tool = toolRef.split("/").pop() ?? toolRef;
  return tool
    .replace(/^computer_/, "")
    .replaceAll("_", " ")
    .trim();
}

export type ActionKind = "command" | "file" | "mail" | "browser" | "other";

/**
 * What kind of thing a waiting action is, for the glyph on its card. A command or a file write is
 * named before the computer, because both run on the Bot's computer (`computer_run_command`) and
 * are not browsing.
 */
export function actionKind(toolRef: string): ActionKind {
  const tool = toolRef.split("/").pop() ?? toolRef;
  if (/run_command|command$/.test(tool)) return "command";
  if (/write_file|file$/.test(tool)) return "file";
  if (/mail|message|send/.test(toolRef)) return "mail";
  if (/^computer_|browser|navigate/.test(toolRef)) return "browser";
  return "other";
}

export type TasksModel = {
  /** Needs input: pending approvals, then the Bots' questions. */
  requests: ApprovalRequest[];
  questions: PersonQuestion[];
  /** Responsibilities a Bot is carrying now. Paused and completed ones are not under way. */
  responsibilities: ResponsibilityRecord[];
  /** Routines that will fire. A switched-off one is not active. */
  routines: RoutineRecord[];
  /** Up next: what background research suggested and nobody has started or hidden. */
  suggestions: ProactiveSuggestion[];
};

export function tasksModel({
  inbox,
  responsibilities,
  routines,
  suggestions,
  order = "newest",
  query = "",
}: {
  inbox: ApprovalInboxData | undefined;
  responsibilities: ResponsibilityRecord[] | undefined;
  routines: RoutineRecord[] | undefined;
  suggestions: ProactiveSuggestion[] | undefined;
  order?: SortOrder;
  query?: string;
}): TasksModel {
  return {
    requests: byTime(
      pendingRequests(inbox).filter((request) =>
        matchesSearch(
          `${actionName(request.action.toolRef)} ${request.action.scope}`,
          query,
        ),
      ),
      (request) => request.createdAt,
      order,
    ),
    questions: byTime(
      (inbox?.questions ?? []).filter((question) =>
        matchesSearch(question.question, query),
      ),
      (question) => question.createdAt,
      order,
    ),
    responsibilities: byTime(
      (responsibilities ?? []).filter(
        (row) => row.status === "active" && matchesSearch(row.title, query),
      ),
      (row) => row.updatedAt,
      order,
    ),
    routines: byTime(
      (routines ?? []).filter(
        (row) => row.enabled && matchesSearch(row.instruction, query),
      ),
      (row) => row.nextRunAt,
      // Soonest first reads as "newest" here: what fires next leads.
      order === "newest" ? "oldest" : "newest",
    ),
    suggestions: byTime(
      (suggestions ?? []).filter((row) => matchesSearch(row.title, query)),
      (row) => row.createdAt,
      order,
    ),
  };
}

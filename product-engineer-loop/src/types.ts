export type RunStatus =
  | "awaiting_plan_approval"
  | "implementing"
  | "awaiting_review"
  | "revising"
  | "approved"
  | "failed";

export type TicketRunHistoryEntry = {
  at: string;
  kind:
    | "start"
    | "plan"
    | "approve_plan"
    | "reject_plan"
    | "resume"
    | "status"
    | "approve";
  runId: string | null;
  note?: string;
};

export type TicketRun = {
  ticketId: string;
  linearIssueId: string;
  title: string;
  linearUrl: string;
  agentId: string;
  lastRunId: string | null;
  status: RunStatus;
  repos: string[];
  prUrl: string | null;
  createdAt: string;
  updatedAt: string;
  history: TicketRunHistoryEntry[];
  /** Human-reviewed implementation plan; required before cloud coding starts. */
  plan?: string | null;
  /** Latest assistant / status text while the cloud agent is working. */
  progress?: string | null;
  /** Present when the background job failed after persisting a row. */
  error?: string | null;
};

/** Best-effort: pull a github.com PR URL out of agent text. */
export function extractPrUrl(text: string | undefined | null): string | null {
  if (!text) return null;
  const match = text.match(
    /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/,
  );
  return match?.[0] ?? null;
}

/**
 * Statuses that block starting another run for the same ticket.
 * Includes plan approval so coding cannot be double-queued while a plan waits.
 */
export const BUSY_STATUSES: readonly RunStatus[] = [
  "awaiting_plan_approval",
  "implementing",
  "revising",
  "awaiting_review",
];

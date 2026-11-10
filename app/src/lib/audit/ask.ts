import type { AuditFilters } from "@openbot/shared/audit-filters";
import { client } from "@/lib/client";

/** The names the server resolved for the values in a set of filters, so a chip reads as a name. */
export type AuditFilterLabels = {
  bots: Record<string, string>;
  people: Record<string, string>;
  apps: Record<string, string>;
  rules: Record<string, string>;
};

/**
 * A question about the trail, read by the deployment's model as filters.
 *
 * `filters` are what the page asks the trail for, and the rows they return are the answer. `reading`
 * is those filters read back by a call that never saw the question. `unanswered` says what the
 * trail can't answer, and why: all of the question when `answerable` is `no`, and then `filters` is
 * empty.
 */
export type AuditAnswer = {
  answerable: "yes" | "partly" | "no";
  unanswered: string | null;
  filters: AuditFilters;
  reading: string | null;
  labels: AuditFilterLabels;
};

/**
 * Question in, filters out. A plain function rather than a mutation: nothing is saved and nothing is
 * cached. The server records the question on the trail with the filters it became.
 */
export async function askAuditTrail(question: string): Promise<AuditAnswer> {
  const response = await client("/api/admin/audit-events/ask", {
    method: "POST",
    body: {
      question,
      // So "yesterday" is the admin's yesterday.
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    fallback: "Couldn't answer that. Try again, or set the filters yourself.",
  });
  return (await response.json()) as AuditAnswer;
}

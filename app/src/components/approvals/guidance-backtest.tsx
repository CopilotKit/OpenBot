import type { UseMutationResult } from "@tanstack/react-query";
import type { AuditEvent } from "@/components/audit/audit-cells";
import {
  type ReplayRow,
  ReplayRows,
} from "@/components/boundaries/dry-run-changes";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import type {
  GuidanceBacktest,
  GuidanceBacktestPreview,
  GuidanceBacktestRow,
} from "@/lib/reviewer-guidance/queries";
import { mediaOf } from "./describe-rules";

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** "Agreed with your people on 18 of 22." */
export function agreementHeadline(report: GuidanceBacktest): string {
  if (report.reviewed === 0)
    return "The reviewer couldn't answer for any of them.";
  return `Agreed with your people on ${report.agreed} of ${report.reviewed}.`;
}

/** The two ways it disagreed, kept apart: letting through what was denied costs more than asking. */
export function disagreementLine(report: GuidanceBacktest): string {
  return `Would have let through ${report.letThroughDenied} your people denied, and asked about ${report.askedAllowed} they allowed.`;
}

/** What was replayed and what the reviewer had to go on. */
export function replayedWords(report: GuidanceBacktest): string {
  return [
    `Replayed over the last ${plural(report.sample, "request")} your people decided. The reviewer reads each one as it would live: the person's words in that conversation, and the action.`,
    report.withoutRequest > 0
      ? `${report.withoutRequest} had no words from a person, so the reviewer judged ${report.withoutRequest === 1 ? "it" : "them"} on the action alone.`
      : null,
    report.skippedSafety > 0
      ? `${report.skippedSafety} more ${report.skippedSafety === 1 ? "was" : "were"} decided by built-in safety. Guidance doesn't change ${report.skippedSafety === 1 ? "that" : "those"}.`
      : null,
    report.unreviewed > 0
      ? `The reviewer couldn't answer for ${report.unreviewed}.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
}

const ANSWERS: Record<GuidanceBacktestRow["person"], string> = {
  allow_once: "A person allowed it once.",
  allow_always: "A person always allowed it.",
  deny: "A person denied it.",
};

const WOULD: Record<GuidanceBacktestRow["would"], string> = {
  proceed: "Would let it run",
  ask: "Would ask",
  hand_off: "Would hand off",
  unreviewed: "No answer",
};

const COLOURS: Record<GuidanceBacktestRow["outcome"], string> = {
  let_through_denied: "text-destructive",
  asked_allowed: "text-amber-600 dark:text-amber-500",
  agree: "text-foreground",
  unreviewed: "text-muted-foreground",
};

/** The request as the approval row the trail keeps for it, so Audit's own cells draw it. */
function auditRowOf(row: GuidanceBacktestRow): AuditEvent {
  return {
    id: row.id,
    actorUserId: row.ownerUserId,
    initiatorKind: row.initiator.kind,
    initiatorId: row.initiator.id,
    eventType: "approval.evaluated",
    targetType: "approval",
    targetId: row.toolRef,
    createdAt: row.createdAt,
    payload: {
      bot: row.bot,
      tool: row.toolRef,
      effect: row.effect,
      scope: row.scope,
      ...row.subject,
    },
  };
}

function replayRowOf(row: GuidanceBacktestRow): ReplayRow {
  return {
    id: row.id,
    event: auditRowOf(row),
    media: mediaOf(row.toolRef),
    verdict: WOULD[row.would],
    verdictClassName: COLOURS[row.outcome],
    note: `${ANSWERS[row.person]} ${row.reason ? `The reviewer: “${row.reason}”` : ""}`.trim(),
  };
}

/**
 * The reviewer with this guidance, replayed over the requests people decided, when the admin asks.
 * It costs one model call a request, so how many is said on the button and under the label before
 * anything runs. Then: how often it agreed with people, the two ways it didn't, and each request in
 * Audit's own cells, what it would have let through that a person denied first.
 */
export function GuidanceBacktestField({
  preview,
  run,
  text,
}: {
  preview: GuidanceBacktestPreview | undefined;
  run: UseMutationResult<GuidanceBacktest, Error, string>;
  /** The guidance as it stands now. A replay of other words is not shown as this one's. */
  text: string;
}) {
  if (!preview) return null;
  const current = run.data && run.variables === text ? run.data : null;
  const stale = run.data && run.variables !== text;
  /*
   * The results sit beside the field, not in it: a field holding a horizontal row (the replay rows
   * have them) balances its descriptions, which squeezed the lines above the results to half width.
   */
  return (
    <div aria-live="polite" className="flex flex-col gap-3">
      <Field aria-labelledby="guidance-backtest">
        <FieldLabel id="guidance-backtest">On recent decisions</FieldLabel>
        {preview.calls === 0 ? (
          <FieldDescription>
            No requests your people decided yet. You can test guidance once
            they've answered some.
          </FieldDescription>
        ) : (
          <>
            <FieldDescription>
              Replays the reviewer with this guidance over the last{" "}
              {plural(preview.calls, "request")} your people decided. That's{" "}
              {plural(preview.calls, "model call")}, one for each.
            </FieldDescription>
            <div>
              <Button
                disabled={run.isPending}
                onClick={() => run.mutate(text)}
                size="sm"
                type="button"
                variant="outline"
              >
                {run.isPending
                  ? "Testing…"
                  : `Test on ${plural(preview.calls, "request")}`}
              </Button>
            </div>
          </>
        )}
        {run.error && run.variables === text ? (
          <p className="text-destructive text-sm" role="alert">
            {run.error.message}
          </p>
        ) : null}
        {stale && !run.isPending ? (
          <p className="text-amber-600 text-sm dark:text-amber-500">
            You've changed the guidance since it was tested. Test it again to
            see what your edit changes.
          </p>
        ) : null}
      </Field>
      {current ? (
        <div className="flex flex-col gap-3" data-guidance-results>
          <div>
            <p className="font-medium text-sm">{agreementHeadline(current)}</p>
            <p className="mt-0.5 text-sm">{disagreementLine(current)}</p>
            <FieldDescription className="mt-1">
              {replayedWords(current)}
            </FieldDescription>
          </div>
          {current.rows.length > 0 ? (
            <ReplayRows
              rows={current.rows.map(replayRowOf)}
              total={current.rows.length}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

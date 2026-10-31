import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { personWasAsked } from "@/lib/approval-view";
import {
  type ApprovalRequest,
  approvalInboxCacheOptions,
  decideApprovalMutationOptions,
} from "@/lib/approvals";
import { ApprovalCard } from "./approval-card";

/** A request the person decided on a card, which keeps its folded card in the conversation. */
const decidedByPerson = (request: ApprovalRequest) =>
  request.status !== "pending" &&
  Boolean(request.decision) &&
  personWasAsked(request);

/**
 * An approval, drawn in the conversation where the action it holds would have been.
 *
 * The same request as the Bot's page, read from the same owner-scoped inbox, so a decision made in
 * either place is the one decision. Once decided the server runs the action exactly once and
 * continues the conversation, and this gives the line back to the tool's own renderer, under the
 * folded card saying how it ended and who decided. A request the person was never asked about (a
 * saved rule allowed it) leaves no card behind.
 */
export function InlineApproval({
  toolCallId,
  fallback,
  ran = false,
}: {
  toolCallId?: string;
  fallback: ReactNode;
  /** The step this request held has run and worked, so an approved card reads Done. */
  ran?: boolean;
}) {
  const cache = useQueryClient();
  const inbox = useQuery(approvalInboxCacheOptions());
  const decision = useMutation(decideApprovalMutationOptions(cache));
  const request = toolCallId
    ? inbox.data?.requests.find(
        (candidate) => candidate.action.toolCallId === toolCallId,
      )
    : undefined;
  if (!request) return <>{fallback}</>;
  const waiting = request.status === "pending";
  if (!waiting && !decidedByPerson(request)) return <>{fallback}</>;
  /*
   * One card in one place, waiting or folded, so deciding folds the card the person was on rather
   * than drawing a new one: the card keeps their focus through the fold.
   */
  return (
    <div className="space-y-2">
      <ApprovalCard
        busy={decision.isPending}
        error={decision.error?.message ?? null}
        onDecide={(choice) => decision.mutate({ id: request.id, choice })}
        ran={ran}
        request={request}
      />
      {waiting ? null : fallback}
    </div>
  );
}

/**
 * The approval cards for tool calls a transcript draws itself rather than through each tool's
 * renderer: a run of steps folded into one line, whose cards would never be seen inside the fold,
 * and a server call alone in its turn, which has no renderer to draw one. Drawn beside the line, one
 * card per call the person was asked about: waiting to be decided, or folded once it was. Nothing
 * at all for calls nobody asked about.
 */
export function ToolCallApprovals({
  toolCallIds,
  ran = [],
}: {
  toolCallIds: readonly string[];
  /** The calls among them whose step has run and worked. */
  ran?: readonly string[];
}) {
  const inbox = useQuery(approvalInboxCacheOptions());
  const asked = new Set(
    (inbox.data?.requests ?? [])
      .filter(
        (request) => request.status === "pending" || decidedByPerson(request),
      )
      .flatMap((request) =>
        request.action.toolCallId ? [request.action.toolCallId] : [],
      ),
  );
  const ids = toolCallIds.filter((id) => asked.has(id));
  if (ids.length === 0) return null;
  return (
    <div className="mt-3 space-y-3">
      {ids.map((id) => (
        <InlineApproval
          fallback={null}
          key={id}
          ran={ran.includes(id)}
          toolCallId={id}
        />
      ))}
    </div>
  );
}

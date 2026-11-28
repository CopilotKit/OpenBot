import type {
  LearningEvidence,
  LearningProposalDetail,
} from "@openbot/shared/learning";
import {
  type QueryKey,
  type UseQueryOptions,
  useQuery,
} from "@tanstack/react-query";
import { SkillFiles } from "@/components/learning/skill-files";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { proposalReason, skillTitle } from "@/lib/learning/display";
import { failureSaid } from "@/lib/load-failure";

/** What one Insight was learned from: the messages a conversation was cited for, or a recording. */
function EvidenceList({ evidence }: { evidence: LearningEvidence[] | null }) {
  if (evidence === null)
    return (
      <p className="text-muted-foreground text-sm">
        Couldn't load the evidence for this.
      </p>
    );
  return (
    <ul className="grid gap-3">
      {evidence.map((entry) => (
        <li
          className="grid gap-1.5 rounded-md bg-muted p-3 text-sm"
          key={`${entry.kind}:${entry.id}`}
        >
          {entry.kind === "conversation" ? (
            <>
              <p className="font-medium">
                {entry.title ?? "A conversation"}
                {entry.available ? "" : " (no longer available)"}
              </p>
              {entry.messages.map((message) => (
                <p className="text-pretty" key={message.id}>
                  <span className="text-muted-foreground">
                    {message.role === "user"
                      ? "Person: "
                      : message.role === "assistant"
                        ? "Bot: "
                        : "Tool: "}
                  </span>
                  {message.content}
                </p>
              ))}
            </>
          ) : (
            <>
              <p className="font-medium">
                {entry.title ?? "A recording"}
                {entry.available ? "" : " (no longer available)"}
              </p>
              <p className="text-pretty">
                {entry.events.join(", ") ||
                  `${entry.eventCount} ${entry.eventCount === 1 ? "step" : "steps"}`}
              </p>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * What the dialog says once a proposal is decided. Nothing while it waits, and nothing for a status a
 * newer server sends that this app doesn't know.
 */
export function decidedNote(
  status: string,
  removal: boolean,
  publishedNote: string,
): string | null {
  if (status === "approved")
    return removal
      ? "Removed. Bots stop using it from their next conversation."
      : publishedNote;
  if (status === "rejected")
    return removal
      ? "Rejected. The skill stays."
      : "Rejected. It won't be published.";
  return null;
}

/**
 * One proposed skill: the SKILL.md it publishes, why, and the evidence. With
 * `onDecide` it carries Approve and Reject while the proposal is pending review;
 * without it the dialog is read-only.
 */
export function ProposalDialog<TKey extends QueryKey>({
  load,
  onDecide,
  deciding,
  decided,
  error,
  publishedNote = "Published. Bots on this container use it from their next conversation.",
  onClose,
}: {
  load: UseQueryOptions<
    LearningProposalDetail,
    Error,
    LearningProposalDetail,
    TKey
  >;
  onDecide?: (decision: "approve" | "reject") => void;
  deciding: boolean;
  /** The status the decision left it in, as the server answered it. */
  decided?: string;
  error?: Error | null;
  /** What the dialog says once the skill is published; the default is written for Admin. */
  publishedNote?: string;
  onClose: () => void;
}) {
  const detail = useQuery(load);
  const proposal = detail.data;
  const status = decided ?? proposal?.status;
  const removal = proposal?.operation === "remove";
  // Left out where Learning's reason only names the insights shown under Learned from.
  const reason = proposal ? proposalReason(proposal.reason) : null;
  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {proposal
              ? skillTitle(proposal.title, proposal.description)
              : "Proposed skill"}
          </DialogTitle>
          {proposal && (
            <DialogDescription>{proposal.description}</DialogDescription>
          )}
        </DialogHeader>
        <DialogBody className="mt-4 gap-5 overflow-y-auto">
          {detail.isPending ? null : detail.error ? (
            <p role="alert" className="text-destructive text-sm">
              {failureSaid(detail.error)}
            </p>
          ) : (
            <>
              {reason ? (
                <section className="grid gap-1.5">
                  <h3 className="font-medium text-sm">Why</h3>
                  <p className="text-pretty text-sm">{reason}</p>
                </section>
              ) : null}
              {proposal && (
                <SkillFiles
                  files={proposal.files.map((file) => ({
                    path: file.path,
                    text: file.content,
                  }))}
                />
              )}
              {proposal && proposal.insights.length > 0 && (
                <section className="grid gap-3">
                  <h3 className="font-medium text-sm">Learned from</h3>
                  {proposal.insights.map((insight) => (
                    <div className="grid gap-2" key={insight.id}>
                      <p className="text-pretty text-sm">{insight.statement}</p>
                      <EvidenceList evidence={insight.evidence} />
                    </div>
                  ))}
                </section>
              )}
            </>
          )}
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {failureSaid(error)}
            </p>
          )}
        </DialogBody>
        <DialogFooter className="mt-4">
          {onDecide && status === "pending_review" ? (
            <>
              <Button
                disabled={deciding}
                onClick={() => onDecide("reject")}
                size="sm"
                type="button"
                variant="outline"
              >
                Reject
              </Button>
              <Button
                disabled={deciding}
                onClick={() => onDecide("approve")}
                size="sm"
                type="button"
              >
                {deciding
                  ? "Saving…"
                  : removal
                    ? "Approve removal"
                    : "Approve and publish"}
              </Button>
            </>
          ) : (
            <>
              {status && decidedNote(status, removal, publishedNote) && (
                <span
                  className="mr-auto text-muted-foreground text-sm"
                  role="status"
                >
                  {decidedNote(status, removal, publishedNote)}
                </span>
              )}
              <Button onClick={onClose} size="sm" type="button">
                Done
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

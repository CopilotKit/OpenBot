import { useCallback, useEffect, useState } from "react";
import {
  answerApproval,
  type PendingApproval,
  readApprovals,
} from "@/components/computer/approvals";
import { Button } from "@/components/ui/button";

/**
 * A transcript line that grew two buttons, for the one action a boundary wanted a person to see.
 *
 * Not a modal, and the restraint is the point. A question about one click belongs where the click is
 * being reported, in sequence with everything else the Bot did, so a person can see what led up to it
 * without losing the conversation behind a dialog. A boundary that interrupts the whole screen is one
 * people learn to dismiss, and an ask rule that gets reflexively approved is worse than no rule at
 * all: it produces a record of consent that nobody actually gave.
 *
 * It polls rather than being handed its question by the tool call that raised it. The tool call is a
 * promise waiting on a server, with no way to push anything into its own rendering while it waits,
 * and the server already holds the list. Polling costs a request a second while a Bot is acting, and
 * buys a card that is correct even when a person answers from another tab.
 */
export function ApprovalRequest({
  botId,
  /** False once the tool call finishes, so a card cannot outlive the action it is about. */
  active,
}: {
  botId: string;
  active: boolean;
}) {
  const [asking, setAsking] = useState<PendingApproval | null>(null);
  const [answering, setAnswering] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      setAsking(null);
      return;
    }
    let live = true;
    const look = async () => {
      const approvals = await readApprovals(botId);
      // A failed read is not an answer. Holding the last question on screen through a blip is better
      // than clearing the card out from under somebody who was reading it.
      if (!live || !approvals) return;
      setAsking(approvals.find((one) => one.granted === undefined) ?? null);
    };
    void look();
    const timer = setInterval(() => void look(), 1_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [botId, active]);

  const answer = useCallback(
    async (granted: boolean) => {
      if (!asking) return;
      setAnswering(true);
      const result = await answerApproval(botId, asking.id, granted);
      setAnswering(false);
      if (!result.ok) {
        setProblem(result.error ?? "That answer could not be recorded.");
        return;
      }
      // Cleared here rather than waiting for the next poll, so the buttons stop being pressable the
      // moment the answer lands. The Bot's turn is still on the server working out what to do with it.
      setAsking(null);
      setProblem(null);
    },
    [asking, botId],
  );

  if (!asking) return null;

  return (
    <div className="my-1.5 rounded-md border border-border bg-card px-3 py-2">
      <p className="text-sm">{asking.question}</p>
      <p className="mt-1 break-all font-mono text-muted-foreground text-xs">
        {asking.rule}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <Button
          disabled={answering}
          onClick={() => void answer(true)}
          size="sm"
        >
          Allow
        </Button>
        <Button
          disabled={answering}
          onClick={() => void answer(false)}
          size="sm"
          variant="outline"
        >
          Deny
        </Button>
        <span className="text-muted-foreground text-xs">
          Asked because of this rule. Allowing covers this one action.
        </span>
      </div>
      {problem ? (
        <p className="mt-2 text-destructive text-xs" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

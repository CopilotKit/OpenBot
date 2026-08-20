import { useCallback, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import {
  answerApproval,
  closeQuestion,
  questionOn,
  watchQuestions,
} from "@/lib/approvals";

/**
 * A transcript line that grew two buttons, for the one action a boundary wanted a person to see.
 *
 * Not a modal, and the restraint is the point. A question about one click belongs where the click is
 * being reported, in sequence with everything else the Bot did, so a person can see what led up to it
 * without losing the conversation behind a dialog. A boundary that interrupts the whole screen is one
 * people learn to dismiss, and an ask rule that gets reflexively approved is worse than no rule at
 * all: it produces a record of consent that nobody actually gave.
 *
 * It draws the question its own tool call is waiting on, and nothing else. The alternative, asking
 * the server what this Bot is waiting on and showing the first unanswered thing, cannot tell one
 * question from another: a run that was stopped or a tab that was reloaded leaves its question open
 * in the registry for the rest of the ten minutes, so the card would offer somebody a stale question
 * on the line of an action nobody is being asked about, and record their Allow against the wrong
 * one. The tool call that raised the question is the only thing that knows which one is its own, so
 * it is what says so.
 */
export function ApprovalRequest({
  /** The tool call this line is reporting. Undefined before the SDK has named it. */
  toolCallId,
}: {
  toolCallId: string | undefined;
}) {
  const asking = useSyncExternalStore(watchQuestions, () =>
    questionOn(toolCallId ?? ""),
  );
  const [answering, setAnswering] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const answer = useCallback(
    async (granted: boolean) => {
      if (!asking) return;
      setAnswering(true);
      const result = await answerApproval(
        asking.botId,
        asking.approvalId,
        granted,
      );
      setAnswering(false);
      if (!result.ok) {
        setProblem(result.error ?? "That answer could not be recorded.");
        return;
      }
      // Taken down here rather than waiting for the call to notice, so the buttons stop being
      // pressable the moment the answer lands. The Bot's turn is still on the server working out
      // what to do with it.
      closeQuestion(toolCallId ?? "");
      setProblem(null);
    },
    [asking, toolCallId],
  );

  if (!asking) return null;

  return (
    <div className="my-1.5 rounded-md border border-border bg-card px-3 py-2">
      <p className="text-sm">{asking.question}</p>
      {asking.rule ? (
        <p className="mt-1 break-all font-mono text-muted-foreground text-xs">
          {asking.rule}
        </p>
      ) : null}
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

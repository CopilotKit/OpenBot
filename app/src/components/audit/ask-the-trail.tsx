import {
  IconAlertTriangle,
  IconFilter,
  IconInfoCircle,
  IconSparkles,
} from "@tabler/icons-react";
import { useState } from "react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { type AuditAnswer, askAuditTrail } from "@/lib/audit/ask";
import { isComposing } from "@/lib/composing";

/** The longest question the server takes. */
const QUESTION_LIMIT = 500;

/**
 * "Ask": a question about what Bots did, read by the deployment's own model as filters.
 *
 * It shows nothing by itself. `onAnswer` hands the answer to the page, which puts its filters on the
 * table as chips over the trail's own rows, with the reading and anything the trail can't answer
 * beside them ({@link AuditAnswerNote}).
 */
export function AskTheTrail({
  onAnswer,
}: {
  onAnswer: (answer: AuditAnswer & { question: string }) => void;
}) {
  const [text, setText] = useState("");
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const question = text.trim();

  const ask = async () => {
    if (!question || asking) return;
    setProblem(null);
    setAsking(true);
    try {
      onAnswer({ ...(await askAuditTrail(question)), question });
    } catch (thrown) {
      setProblem((thrown as Error).message);
    } finally {
      setAsking(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-2"
      data-asking={asking ? "true" : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        void ask();
      }}
    >
      <InputGroup className="max-w-2xl">
        <InputGroupAddon>
          <IconSparkles />
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Ask about the audit trail"
          maxLength={QUESTION_LIMIT}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // A composing IME's Enter picks a word. It doesn't ask.
            if (event.key === "Enter" && isComposing(event))
              event.preventDefault();
          }}
          placeholder="Ask what Bots did, like “Gmail changes by a routine last week”"
          value={text}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            disabled={!question || asking}
            size="sm"
            type="submit"
            variant="default"
          >
            {asking ? "Asking…" : "Ask"}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {problem ? (
        <p
          className="text-destructive text-sm"
          data-audit-ask-problem
          role="alert"
        >
          {problem}
        </p>
      ) : null}
    </form>
  );
}

/**
 * Under the question: what the filters show, read back by a call that never saw the question, and
 * what the trail can't answer, said plainly.
 *
 * The reading describes the filters as answered. Once the admin changes a chip it no longer
 * describes the table, and says so rather than standing as though it did.
 */
export function AuditAnswerNote({
  answer,
  edited,
}: {
  answer: AuditAnswer & { question: string };
  /** Whether the chips have changed since the answer arrived. */
  edited: boolean;
}) {
  return (
    <div className="flex max-w-3xl flex-col gap-1.5 text-sm">
      {answer.answerable === "no" ? (
        <p
          className="flex gap-1.5 text-amber-700 dark:text-amber-500"
          data-audit-unanswered
        >
          <IconInfoCircle className="mt-0.5 size-4 shrink-0" />
          <span>The trail can't answer this. {answer.unanswered}</span>
        </p>
      ) : (
        <>
          {answer.reading ? (
            <p
              className={edited ? "flex gap-1.5 opacity-60" : "flex gap-1.5"}
              data-audit-reading
            >
              <IconFilter className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>
                <span className="font-medium">What the filters show: </span>
                <span className="text-muted-foreground">{answer.reading}</span>
              </span>
            </p>
          ) : null}
          {answer.answerable === "partly" && answer.unanswered ? (
            <p
              className="flex gap-1.5 text-amber-700 dark:text-amber-500"
              data-audit-unanswered
            >
              <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>The rows answer part of this. {answer.unanswered}</span>
            </p>
          ) : null}
          {edited ? (
            <p className="text-muted-foreground">
              You've changed the filters since. The reading above is for the
              filters as answered.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

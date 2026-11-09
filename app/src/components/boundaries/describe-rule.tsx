import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { isComposing } from "@/lib/composing";
import {
  type PolicyTranslation,
  translatePolicyRule,
} from "@/lib/computers/policy-translate";

/** What came back for one description, kept beside the words it came from. */
export type WrittenRule = PolicyTranslation & { text: string };

/**
 * "Describe the rule": a sentence in, a rule out, written by the deployment's own model.
 *
 * It fills nothing in by itself. `onWritten` hands the rule to the screen, which puts it in the CEL
 * field where the admin reads it, edits it if they want, and saves it themselves. A description that
 * only grants permission comes back as an allow rule, which these screens cannot add, so it is
 * answered here and never handed on.
 */
export function DescribeRule({
  onWritten,
}: {
  onWritten: (written: WrittenRule) => void;
}) {
  const [text, setText] = useState("");
  const [writing, setWriting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const described = text.trim();

  const write = async () => {
    if (!described || writing) return;
    setProblem(null);
    setWriting(true);
    try {
      const translation = await translatePolicyRule(described);
      if (translation.effect === "allow") {
        setProblem(
          "That says what Bots may do. A rule here stops an action, so describe what no Bot may do.",
        );
        return;
      }
      onWritten({ ...translation, text: described });
    } catch (thrown) {
      setProblem((thrown as Error).message);
    } finally {
      setWriting(false);
    }
  };

  return (
    <Field>
      <FieldLabel htmlFor="rule-description-english">
        Describe the rule
      </FieldLabel>
      <FieldDescription>
        Say in a sentence what no Bot may do, and your model writes the rule. A
        second reading that never sees your words says what the rule does.
      </FieldDescription>
      <Textarea
        className="min-h-10"
        id="rule-description-english"
        maxLength={1000}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Enter writes the rule. It must never reach the form around it, whose Enter saves.
          if (event.key !== "Enter" || event.shiftKey || isComposing(event))
            return;
          event.preventDefault();
          event.stopPropagation();
          void write();
        }}
        placeholder="Bots may not visit social media sites"
        rows={2}
        value={text}
      />
      <div>
        <Button
          disabled={!described || writing}
          onClick={() => void write()}
          size="sm"
          type="button"
          variant="outline"
        >
          {writing ? "Writing…" : "Write rule"}
        </Button>
      </div>
      {problem ? (
        <p className="text-destructive text-sm" role="alert">
          {problem}
        </p>
      ) : null}
    </Field>
  );
}

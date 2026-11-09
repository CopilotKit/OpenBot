import type { UseQueryResult } from "@tanstack/react-query";
import { DryRunChanges } from "@/components/boundaries/dry-run-changes";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import type { DryRunReport } from "@/lib/computers/queries";

/**
 * What the rule would have stopped, worked out as it is written: a Bot's computer actions and its
 * app calls, in one list. A rule that can't be evaluated says why here, under the rule, and nothing
 * is replayed. The first answer arrives into an empty space, with no placeholder before it.
 *
 * Shared by Add rule and a rule's own page, which both replay the rule in the editor on its own.
 */
export function RulePreview({
  preview,
}: {
  preview: UseQueryResult<DryRunReport>;
}) {
  if (preview.isPending) return null;
  return (
    <Field aria-labelledby="rule-preview" aria-live="polite">
      <FieldLabel id="rule-preview">On recent activity</FieldLabel>
      {preview.error ? (
        <p className="text-destructive text-sm" role="alert">
          {preview.error.message}
        </p>
      ) : preview.data.scanned === 0 ? (
        <FieldDescription>
          No recorded actions to test against yet. You'll see what this rule
          stops once Bots have acted.
        </FieldDescription>
      ) : (
        <div>
          <FieldDescription>
            {preview.data.wouldRefuse === 0
              ? `Of the last ${preview.data.scanned} recorded actions, this rule would have stopped none. It may still stop future ones.`
              : `Of the last ${preview.data.scanned} recorded actions, this rule would have stopped ${preview.data.wouldRefuse}.`}
          </FieldDescription>
          <DryRunChanges
            changes={preview.data.changes.filter(
              (change) => change.would === "refused",
            )}
            total={preview.data.wouldRefuse}
            verdict="Would stop"
          />
        </div>
      )}
    </Field>
  );
}

import { IconAlertTriangle, IconCircleCheck } from "@tabler/icons-react";
import type { WrittenRule } from "@/components/boundaries/describe-rule";
import { cn } from "@/lib/utils";

/**
 * Beside a rule the model wrote: whether it compiles, and what it does, read back from the rule alone.
 *
 * The reading is the check that matters. It comes from a call that saw the rule and never the
 * description, so a rule that drifted from what the admin asked for reads differently from what they
 * asked for, right under it. Once the admin edits the rule, both the reading and the compile result
 * describe the rule as written, not as edited, and the screen says so rather than letting them stand
 * as though they still applied.
 */
export function RuleReading({
  written,
  rule,
}: {
  written: WrittenRule;
  /** The rule in the field now. */
  rule: string;
}) {
  const edited = rule.trim() !== written.rule.trim();
  return (
    <div className="flex flex-col gap-2 text-sm" role="status">
      <div className={cn("flex flex-col gap-2", edited && "opacity-60")}>
        {written.compile.ok ? (
          <p className="flex items-center gap-1.5">
            <IconCircleCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            Compiles. OpenBot can check it on every action.
          </p>
        ) : (
          <div className="flex gap-1.5 text-destructive">
            <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p>
              Doesn't compile, so OpenBot won't save it. {written.compile.error}
            </p>
          </div>
        )}
        {written.explanation ? (
          <div>
            <p className="font-medium">What this rule does</p>
            <p className="mt-0.5 text-muted-foreground">
              {written.explanation}
            </p>
          </div>
        ) : null}
        {written.warning ? (
          <p className="text-amber-600 dark:text-amber-500">
            {written.warning}
          </p>
        ) : null}
      </div>
      {edited ? (
        <p className="text-amber-600 dark:text-amber-500">
          You've changed the rule since it was written. The check and the
          reading above are for the written rule, not your edit.
        </p>
      ) : null}
    </div>
  );
}

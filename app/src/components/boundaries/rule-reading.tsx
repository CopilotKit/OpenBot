import { IconAlertTriangle, IconCircleCheck } from "@tabler/icons-react";
import type { WrittenRule } from "@/components/boundaries/describe-rule";
import { cn } from "@/lib/utils";

/**
 * Beside what a model wrote: whether it checks, what it does read back from what was written alone,
 * any warning, and, once the admin has edited it, that the reading is about what was written and not
 * their edit. Shared by a boundary and team approval rules, each saying it in its own words.
 */
export function ReadingStatus({
  check,
  passed,
  failed,
  heading,
  points,
  explanation,
  warning,
  edited,
}: {
  check: { ok: true } | { ok: false; error: string };
  /** What a passing check means: "Compiles. OpenBot can check it on every action." */
  passed: string;
  /**
   * What a failing check means, before its error: "Doesn't compile, so OpenBot won't save it." Empty
   * where the error says it all.
   */
  failed: string;
  /** Over the reading: "What this rule does". */
  heading: string;
  /**
   * The reading as a list, under the heading and before the explanation: the network allowlist's
   * "what becomes reachable", one line each.
   */
  points?: readonly string[];
  explanation: string | null;
  warning: string | null;
  /**
   * The note that the check and the reading are for what was written, shown once it was edited. What
   * is above it fades then, since it describes the written text.
   */
  edited: string | null;
}) {
  return (
    <div className="flex flex-col gap-2 text-sm" role="status">
      <div className={cn("flex flex-col gap-2", edited && "opacity-60")}>
        {check.ok ? (
          <p className="flex items-center gap-1.5">
            <IconCircleCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            {passed}
          </p>
        ) : (
          <div className="flex gap-1.5 text-destructive">
            <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p>{[failed, check.error].filter(Boolean).join(" ")}</p>
          </div>
        )}
        {explanation ? (
          <div>
            <p className="font-medium">{heading}</p>
            {points && points.length > 0 ? (
              <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-muted-foreground">
                {points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            ) : null}
            <p className="mt-0.5 text-muted-foreground">{explanation}</p>
          </div>
        ) : null}
        {warning ? (
          <p className="text-amber-600 dark:text-amber-500">{warning}</p>
        ) : null}
      </div>
      {edited ? (
        <p className="text-amber-600 dark:text-amber-500">{edited}</p>
      ) : null}
    </div>
  );
}

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
    <ReadingStatus
      check={written.compile}
      edited={
        edited
          ? "You've changed the rule since it was written. The check and the reading above are for the written rule, not your edit."
          : null
      }
      explanation={written.explanation}
      failed="Doesn't compile, so OpenBot won't save it."
      heading="What this rule does"
      passed="Compiles. OpenBot can check it on every action."
      warning={written.warning}
    />
  );
}

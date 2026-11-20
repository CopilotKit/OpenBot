import { whatIfExplainable } from "@openbot/shared/what-if";
import { IconHelpCircle } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { AuditEvent } from "@/components/audit/audit-cells";
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
import { explainAuditEvent, type WhatIfExplained } from "@/lib/what-if/check";
import { cn } from "@/lib/utils";
import { OUTCOMES, WhatIfResultView } from "./what-if-result";

/** Whether "Why did this happen?" can answer for a row: one OpenBot's controls decided. */
export function explainable(event: AuditEvent): boolean {
  return whatIfExplainable(event);
}

const RECORDED_WORDS = {
  allowed: "Allowed",
  refused: "Refused",
  asks: "Asked first",
  hands_off: "Handed to the person",
  failed: "Allowed, then didn't finish",
} as const;

/**
 * "Why?" on an Audit row: the same check "What would happen" runs, asked about the row's own recorded
 * facts, with no model. The dialog says what the row recorded, then what every control says about it
 * today, and where the two differ because a setting has changed since.
 */
export function WhyButton({ event }: { event: AuditEvent }) {
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState<WhatIfExplained | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const show = async () => {
    setOpen(true);
    if (answer || loading) return;
    setProblem(null);
    setLoading(true);
    try {
      setAnswer(await explainAuditEvent(event.id));
    } catch (thrown) {
      setProblem((thrown as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const differs =
    answer &&
    answer.recorded.outcome !== "failed" &&
    (answer.recorded.outcome !== answer.result.outcome ||
      (answer.recorded.layer !== null &&
        answer.recorded.layer !== answer.result.decidedBy));

  return (
    <>
      <Button
        className="-ms-2 mt-1 text-muted-foreground"
        data-why={event.id}
        onClick={() => void show()}
        size="xs"
        variant="ghost"
      >
        <IconHelpCircle />
        Why?
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Why did this happen?</DialogTitle>
            <DialogDescription>
              Each of OpenBot's controls, asked about this event's own facts
              with today's settings.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4 overflow-y-auto">
            {loading ? null : problem ? (
              <p className="text-destructive text-sm" role="alert">
                {problem}
              </p>
            ) : answer ? (
              <div className="flex flex-col gap-4">
                <div
                  className="flex items-start gap-2 text-sm"
                  data-why-recorded={answer.recorded.outcome}
                >
                  <span
                    className={cn(
                      "mt-px whitespace-nowrap rounded-full px-2 py-0.5 font-medium text-xs",
                      answer.recorded.outcome === "failed"
                        ? "bg-muted text-muted-foreground"
                        : OUTCOMES[answer.recorded.outcome].tone,
                    )}
                  >
                    {RECORDED_WORDS[answer.recorded.outcome]}
                  </span>
                  <span>
                    <span className="font-medium">Then: </span>
                    <span className="text-muted-foreground">
                      {answer.recorded.summary}
                    </span>
                  </span>
                </div>
                {differs ? (
                  <p className="text-amber-700 text-sm dark:text-amber-500">
                    Today's settings decide this differently. Something has
                    changed since it happened.
                  </p>
                ) : null}
                <WhatIfResultView inDialog result={answer.result} />
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            {answer ? (
              <Button
                render={(props) => (
                  <Link
                    {...props}
                    search={{ action: JSON.stringify(answer.action) }}
                    to="/admin/what-if"
                  />
                )}
                size="sm"
                variant="outline"
              >
                Try a change
              </Button>
            ) : null}
            <Button onClick={() => setOpen(false)} size="sm">
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

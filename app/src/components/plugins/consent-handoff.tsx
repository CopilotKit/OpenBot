import { useEffect, useRef, useState } from "react";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CONSENT_COUNTDOWN_SECONDS,
  type ConsentHandoff,
  consentHandoffWords,
} from "@/lib/plugins/consent-handoff";
import { cn } from "@/lib/utils";

/**
 * The step before an app's sign-in through Composio: what the next pages will say and why, held on
 * screen for a countdown, then on to the sign-in by itself. "Continue now" skips the wait.
 *
 * WHY IT MOVES ON BY ITSELF. Composio's own page in between used to flash by too fast to read, and
 * a step that waited for a press would only add one. So it stays long enough to read and then goes.
 *
 * Two places draw it, with one body: a dialog over the page where Connect leaves this tab
 * (`ConsentHandoffDialog`), and a page of its own in the tab a sign-in opens in
 * (`ConsentHandoffPage`, at `/connecting`).
 */

/**
 * Seconds left, from {@link CONSENT_COUNTDOWN_SECONDS} down to 0, while `running`. `onDone` runs
 * once, at 0.
 */
export function useCountdown(running: boolean, onDone: () => void): number {
  const [left, setLeft] = useState(CONSENT_COUNTDOWN_SECONDS);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!running) {
      setLeft(CONSENT_COUNTDOWN_SECONDS);
      return;
    }
    let seconds = CONSENT_COUNTDOWN_SECONDS;
    const timer = setInterval(() => {
      seconds -= 1;
      setLeft(seconds);
      if (seconds <= 0) {
        clearInterval(timer);
        done.current();
      }
    }, 1_000);
    return () => clearInterval(timer);
  }, [running]);
  return left;
}

/** The app's mark, on the same tile Connections draws it on. */
function ConsentMark({ handoff }: { handoff: Omit<ConsentHandoff, "url"> }) {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
      <PluginLogo logo={handoff.logo ?? null} name={handoff.app} />
    </span>
  );
}

/** What the step says, and the countdown under it. */
function ConsentStepBody({
  handoff,
  seconds,
}: {
  handoff: Omit<ConsentHandoff, "url">;
  seconds: number;
}) {
  const words = consentHandoffWords(handoff);
  /*
   * The bar fills over the whole countdown. It starts one step ahead once it is on screen, so it
   * is always moving towards the second that is about to end rather than the one that just did.
   */
  const [started, setStarted] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setStarted(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const filled = Math.min(
    1,
    (CONSENT_COUNTDOWN_SECONDS - seconds + (started ? 1 : 0)) /
      CONSENT_COUNTDOWN_SECONDS,
  );
  return (
    <div className="flex flex-col gap-3" data-testid="consent-handoff">
      {words.paragraphs.map((paragraph) => (
        <p
          className="text-muted-foreground text-sm text-pretty"
          key={paragraph}
        >
          {paragraph}
        </p>
      ))}
      <div className="mt-1 flex flex-col gap-2">
        <p
          aria-live="polite"
          className="font-medium text-foreground text-sm tabular-nums"
          data-testid="consent-countdown"
        >
          {words.countdown(Math.max(seconds, 0))}
        </p>
        <div
          aria-hidden="true"
          className="h-1 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full origin-left rounded-full bg-primary transition-transform duration-1000 ease-linear motion-reduce:transition-none"
            style={{ transform: `scaleX(${filled})` }}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The step as a dialog, for a Connect that leaves this tab for the sign-in. Open while `handoff`
 * is set. Cancel, Escape or the close button end it and nothing is opened; the countdown reaching
 * 0, or Continue now, calls `onContinue`.
 */
export function ConsentHandoffDialog({
  handoff,
  onCancel,
  onContinue,
}: {
  handoff: ConsentHandoff | null;
  onCancel: () => void;
  onContinue: (handoff: ConsentHandoff) => void;
}) {
  const open = handoff !== null;
  const held = useRef(handoff);
  if (handoff) held.current = handoff;
  const go = () => {
    if (held.current) onContinue(held.current);
  };
  const seconds = useCountdown(open, go);
  const shown = handoff ?? held.current;
  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      open={open}
    >
      {shown ? (
        <DialogContent>
          <DialogHeader className="flex-row items-center gap-3">
            <ConsentMark handoff={shown} />
            <DialogTitle>{consentHandoffWords(shown).heading}</DialogTitle>
          </DialogHeader>
          <DialogBody className="mt-1">
            <ConsentStepBody handoff={shown} seconds={seconds} />
          </DialogBody>
          <DialogFooter className="mt-2">
            <Button
              onClick={onCancel}
              size="sm"
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button onClick={go} size="sm" type="button">
              Continue now
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/**
 * The step as a page, in the tab a sign-in opened in. `handoff` is what the tab that opened it
 * left (`readConsentHandoff`), or null where it left nothing this page can use.
 */
export function ConsentHandoffPage({
  handoff,
  onContinue,
}: {
  handoff: ConsentHandoff | null;
  onContinue: (handoff: ConsentHandoff) => void;
}) {
  const go = () => {
    if (handoff) onContinue(handoff);
  };
  const seconds = useCountdown(handoff !== null, go);
  const words = handoff ? consentHandoffWords(handoff) : null;
  useEffect(() => {
    if (words) document.title = words.heading;
  }, [words]);
  return (
    <main className="grid min-h-svh place-items-center bg-background p-4 text-foreground sm:p-6">
      <div
        className={cn(
          "flex w-full max-w-md flex-col gap-5 rounded-xl border border-border bg-card p-6 text-card-foreground shadow-sm",
        )}
      >
        {handoff && words ? (
          <>
            <div className="flex items-center gap-3">
              <ConsentMark handoff={handoff} />
              <h1 className="font-heading font-medium text-lg">
                {words.heading}
              </h1>
            </div>
            <ConsentStepBody handoff={handoff} seconds={seconds} />
            <div className="flex justify-end">
              <Button onClick={go} size="sm" type="button">
                Continue now
              </Button>
            </div>
          </>
        ) : (
          <>
            <h1 className="font-heading font-medium text-lg">
              Nothing to connect here
            </h1>
            <p className="text-muted-foreground text-sm">
              This sign-in has expired or was already used. Close this tab and
              press Connect again in OpenBot.
            </p>
          </>
        )}
      </div>
    </main>
  );
}

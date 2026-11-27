import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { Button } from "@/components/ui/button";
import {
  loadAgainWhenAnswered,
  loadingAgain,
  useLoadingAgain,
} from "@/lib/load-again";
import { askAgainAfterMs, unavailableSaid } from "@/lib/load-failure";
import { queryClient, SOONEST_ASK_AGAIN_MS } from "@/query-client";

/** The longest the page waits before it asks again by itself, whatever Retry-After said. */
const LONGEST_WAIT_MS = 60_000;

/**
 * A whole page that couldn't load because OpenBot is holding off for now: the organization is being
 * moved, or its database can't be reached. The server answers 503 with a sentence for people and
 * `Retry-After` (lib/load-failure.tsx), and this page says that sentence, calmly, in the sign-in
 * screen's frame as `NoOrganizationPage` does, never as an error with a stack trace.
 *
 * It loads again by itself after the Retry-After, a second at the soonest: the reads that failed are
 * dropped, so they are asked afresh, and the route loads again once they are answered, this page
 * staying up meanwhile (lib/load-again.ts). Should OpenBot still be holding off, this page stays,
 * with the new answer's sentence, and waits its Retry-After. Try again does the same at once. One
 * try runs at a time: a second would drop the reads the first is still asking.
 */
export function UnavailablePage({
  said,
  retryAfterMs,
  reset,
}: {
  said: string;
  retryAfterMs: number;
  reset: () => void;
}) {
  const router = useRouter();
  const [trying, setTrying] = useState(false);
  /** Whether a try of this page's is running, read by the wait's timer, which a render's `trying` would leave stale. */
  const inFlight = useRef(false);
  /** Counts the waits: each try that ends, and each wait that ran out while a try was running, starts the next. */
  const [waits, setWaits] = useState(0);
  // Drawn afresh while a try loads the app again, the page says so.
  const loading = useLoadingAgain();
  /*
   * OpenBot's answer to the last try, when it was still holding off: its sentence, and its own wait before the next.
   * Kept with the answer it followed, so a new one drawn here by the router goes back to what that one says.
   */
  const [stillHeld, setStillHeld] = useState<{
    said: string;
    retryAfterMs: number;
    after: string;
  }>();
  const answer = `${retryAfterMs} ${said}`;
  const held = stillHeld?.after === answer ? stillHeld : undefined;
  const saidNow = held?.said ?? said;
  const waitMs = held?.retryAfterMs ?? retryAfterMs;

  const tryAgain = async () => {
    inFlight.current = true;
    setTrying(true);
    try {
      await queryClient.resetQueries({
        predicate: (query) => query.state.status === "error",
      });
      // This page stays up saying "Trying again…" until the app is ready, or stays as it is when OpenBot still holds off.
      const again = await loadAgainWhenAnswered({
        router,
        reset,
        stays: (failed) => unavailableSaid(failed) !== undefined,
        meanwhile: <BackInAMoment said={saidNow} trying />,
      });
      if (again)
        setStillHeld({
          said: unavailableSaid(again.failed) ?? said,
          retryAfterMs: askAgainAfterMs(again.failed) ?? retryAfterMs,
          after: answer,
        });
    } finally {
      inFlight.current = false;
      setTrying(false);
      // A try that threw waits for the next one all the same; what it threw reaches the app's error reporting.
      setWaits((count) => count + 1);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: one wait per answer and per try; tryAgain is the same every render that matters.
  useEffect(() => {
    const timer = setTimeout(
      () => {
        // A try already running (pressed, or this page's before it was drawn afresh) is waited on, never doubled.
        if (inFlight.current || loadingAgain()) setWaits((count) => count + 1);
        else void tryAgain();
      },
      Math.min(Math.max(waitMs, SOONEST_ASK_AGAIN_MS), LONGEST_WAIT_MS),
    );
    return () => clearTimeout(timer);
  }, [waitMs, saidNow, waits]);

  return (
    <BackInAMoment
      onTryAgain={() => {
        if (!inFlight.current && !loadingAgain()) void tryAgain();
      }}
      said={saidNow}
      trying={trying || loading}
    />
  );
}

/** The page itself, also drawn on its own while the app loads again after a try (lib/load-again.ts). */
function BackInAMoment({
  said,
  trying,
  onTryAgain,
}: {
  said: string;
  trying: boolean;
  onTryAgain?: () => void;
}) {
  return (
    <div className="flex min-h-dvh w-full flex-1 flex-col items-center justify-center in-data-[slot=sidebar-inset]:min-h-0">
      <div className="-mt-12 flex w-full max-w-82 flex-col items-center p-4">
        <AgentOrb size="56px" />
        <h1 className="mt-8 text-center font-medium text-2xl tracking-tight">
          Back in a moment
        </h1>
        <p
          className="mt-3 text-pretty text-center text-muted-foreground text-sm"
          role="status"
        >
          {said}
        </p>
        <Button
          className="mt-8 h-10 w-full tracking-tight"
          disabled={trying}
          onClick={onTryAgain}
          size="lg"
          variant="outline"
        >
          {trying ? "Trying again…" : "Try again"}
        </Button>
      </div>
    </div>
  );
}

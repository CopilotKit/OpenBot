import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { Button } from "@/components/ui/button";
import { queryClient } from "@/query-client";

/** The longest the page waits before it asks again by itself, whatever Retry-After said. */
const LONGEST_WAIT_MS = 60_000;

/**
 * A whole page that couldn't load because OpenBot is holding off for now: the organization is being
 * moved, or its database can't be reached. The server answers 503 with a sentence for people and
 * `Retry-After` (lib/load-failure.ts), and this page says that sentence, calmly, in the sign-in
 * screen's frame as `NoOrganizationPage` does, never as an error with a stack trace.
 *
 * It loads again by itself after the Retry-After: the reads that failed are dropped, so they are
 * asked afresh, and the route loads again. Should OpenBot still be holding off, the new answer
 * brings this page back with its own Retry-After. Try again does the same at once.
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

  const tryAgain = async () => {
    setTrying(true);
    try {
      await queryClient.resetQueries({
        predicate: (query) => query.state.status === "error",
      });
      reset();
      await router.invalidate();
    } finally {
      setTrying(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: one wait per answer; tryAgain is the same every render that matters.
  useEffect(() => {
    const timer = setTimeout(
      () => void tryAgain(),
      Math.min(Math.max(retryAfterMs, 0), LONGEST_WAIT_MS),
    );
    return () => clearTimeout(timer);
  }, [retryAfterMs, said]);

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
          onClick={() => void tryAgain()}
          size="lg"
          variant="outline"
        >
          {trying ? "Trying again…" : "Try again"}
        </Button>
      </div>
    </div>
  );
}

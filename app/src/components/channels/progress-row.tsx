import { useEffect, useState } from "react";

/**
 * One line saying something is under way, and for how long.
 *
 * For a wait the person did not start and cannot watch: a Bot asked by their Bot, a routine firing,
 * a sign-in or an approval somebody else has to finish. Drawn where the result will appear, so the
 * person looks at the right spot, and with a running clock, because "still working" and "stuck"
 * look the same without one.
 *
 * It borrows the shimmer a running tool line uses, so every kind of "working on it" in the
 * transcript reads the same.
 */
export function ProgressRow({
  label,
  since,
}: {
  /** What is under way, as a person would say it: "Asking Ana…". */
  label: string;
  /** When it started. ISO-8601, or epoch milliseconds. */
  since: string | number;
}) {
  const elapsed = useElapsed(since);
  return (
    <p
      className="flex items-baseline gap-2 text-muted-foreground text-sm"
      data-testid="progress-row"
      // `status` rather than `alert`: progress, not an interruption. Only the label is announced;
      // a clock read aloud every second would drown out everything else on the page.
      role="status"
    >
      <span className="tool-line-running">{label}</span>
      <span aria-hidden="true" className="tabular-nums opacity-70">
        {elapsed}
      </span>
    </p>
  );
}

/** "0:12", "4:05", "1:02:07". Never negative: a server clock a little ahead reads as zero. */
export function formatElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** The time since `since`, as text, moving once a second while it is on screen. */
function useElapsed(since: string | number): string {
  const start = typeof since === "number" ? since : Date.parse(since);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return formatElapsed(Number.isNaN(start) ? 0 : now - start);
}

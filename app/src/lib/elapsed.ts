import { useEffect, useState } from "react";

/*
 * Time that is still passing, as a screen shows it: how long something has been going, and how long
 * ago something happened. The clock is read again on a timer, so the words stay right while the
 * screen is left open.
 */

/** This clock's time, read again every `everyMs` while `ticking`. */
export function useNow(everyMs: number, ticking = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs, ticking]);
  return now;
}

/** Seconds since `startedAt`, ticking once a second while there is one. */
export function useSecondsSince(startedAt: number | undefined) {
  const now = useNow(1000, startedAt !== undefined);
  if (startedAt === undefined) return 0;
  // The other clock (a server's, the Recorder's machine's) can run a moment ahead of this one.
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** 0:42, 12:05, 1:02:09. */
export function elapsed(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`;
}

/**
 * How long something took, in the fewest words: 42s, 2m, 1h 5m. A minute and more is said in whole
 * minutes, as a person would say it.
 */
export function briefDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

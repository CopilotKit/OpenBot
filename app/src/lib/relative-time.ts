const RELATIVE_UNITS = [
  { limit: 60_000, divisor: 1_000, unit: "second" },
  { limit: 3_600_000, divisor: 60_000, unit: "minute" },
  { limit: 86_400_000, divisor: 3_600_000, unit: "hour" },
  { limit: 604_800_000, divisor: 86_400_000, unit: "day" },
  { limit: Number.POSITIVE_INFINITY, divisor: 604_800_000, unit: "week" },
] as const;

const relativeFormat = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

/**
 * Locale-aware relative timestamp, e.g. "2 minutes ago".
 *
 * The unit is chosen after rounding, so a time that rounds up to a unit's upper bound reads in the
 * next unit: 59.7 seconds ago is "1 minute ago", not "60 seconds ago".
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const time = new Date(iso).getTime();
  // An invalid date used to flow into `Math.abs(NaN)` comparisons and `format(-NaN)`, which
  // answers "NaN weeks ago" or throws depending on ICU. Return the input unchanged instead.
  if (!Number.isFinite(time)) return iso;
  const elapsed = now.getTime() - time;
  for (const scale of RELATIVE_UNITS) {
    const value = Math.round(elapsed / scale.divisor);
    if (Math.abs(value) * scale.divisor < scale.limit) {
      return relativeFormat.format(-value, scale.unit);
    }
  }
  // Unreachable: the last unit's limit is infinite.
  return iso;
}

const SHORT_UNITS = [
  { limit: 3_600_000, divisor: 60_000, suffix: "m" },
  { limit: 86_400_000, divisor: 3_600_000, suffix: "h" },
  { limit: 604_800_000, divisor: 86_400_000, suffix: "d" },
  { limit: Number.POSITIVE_INFINITY, divisor: 604_800_000, suffix: "w" },
] as const;

/**
 * The sidebar's compact timestamp: "now", "5m", "3h", "2d", "6w".
 *
 * Rounded down, so a unit never shows its own upper bound ("60m"). A time slightly ahead of this
 * clock, from a server whose clock runs fast, reads as "now" rather than a negative number.
 */
export function relativeTimeShort(iso: string, now: Date = new Date()): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return iso;
  const elapsed = now.getTime() - time;
  if (elapsed < 60_000) return "now";
  const scale =
    SHORT_UNITS.find(({ limit }) => elapsed < limit) ??
    SHORT_UNITS[SHORT_UNITS.length - 1];
  return `${Math.floor(elapsed / scale.divisor)}${scale.suffix}`;
}

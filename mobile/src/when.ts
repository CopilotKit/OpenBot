/**
 * Times as a list shows them: a time today, "Yesterday", a weekday this week, else a date. Read
 * in the phone's own locale. It imports nothing that needs a phone, so it can be tested.
 */
export function shortWhen(iso: string | null | undefined, now = new Date()) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const days = dayDifference(date, now);
  if (days === 0)
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7)
    return date.toLocaleDateString(undefined, { weekday: "long" });
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** A day as a heading over what happened on it: "Today", "Yesterday", "November 23rd, 2026". */
export function dayHeading(iso: string | null | undefined, now = new Date()) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const days = dayDifference(date, now);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** The day and time over messages sent after a pause: "Today, 11:45 AM". */
export function dayAndTime(iso: string | null | undefined, now = new Date()) {
  const day = dayHeading(iso, now);
  if (!day || !iso) return day;
  const time = new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${day}, ${time}`;
}

/** Whole calendar days from `date` to `now`, in the phone's time zone. */
function dayDifference(date: Date, now: Date) {
  const start = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  return Math.round((start(now) - start(date)) / 86_400_000);
}

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

/** Only the time of day: "5:54 PM". Under a heading that already says the day. */
export function timeOfDay(iso: string | null | undefined) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
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

/**
 * A moment as a sentence reads it, past or to come: "Today, 8:42 AM", "Tomorrow, 9:00 AM",
 * "Yesterday, 5:42 PM", "Monday, 5:42 PM" within the week, else "Dec 1, 5:42 PM". A routine's next
 * run, and when a run started.
 */
export function momentWhen(iso: string | null | undefined, now = new Date()) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const days = dayDifference(date, now);
  const day =
    days === 0
      ? "Today"
      : days === 1
        ? "Yesterday"
        : days === -1
          ? "Tomorrow"
          : Math.abs(days) < 7
            ? date.toLocaleDateString(undefined, { weekday: "long" })
            : date.toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                ...(date.getFullYear() === now.getFullYear()
                  ? {}
                  : { year: "numeric" }),
              });
  return `${day}, ${time}`;
}

/** Whole calendar days from `date` to `now`, in the phone's time zone. */
function dayDifference(date: Date, now: Date) {
  const start = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  return Math.round((start(now) - start(date)) / 86_400_000);
}

/** How long something took, in a few words: "under a minute", "2 min", "1 hr 5 min". Empty when it can't say. */
export function took(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
) {
  if (!startIso || !endIso) return "";
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

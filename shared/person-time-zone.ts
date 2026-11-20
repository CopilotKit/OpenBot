/**
 * The person's own time zone, as their browser reports it, for the runs they start.
 *
 * A Bot works out "tomorrow" and "9am" from the date it is told and the clock of the machine it
 * runs on, and both were UTC. Asked "what's on my calendar tomorrow?" late on a Friday afternoon in
 * California, which is already Saturday in UTC, a Bot looked up Sunday. Asked for "every weekday at
 * 9am", it had to ask which time zone was meant. The browser knows the answer (the IANA zone the
 * device is set to), so it says so on every run it starts, and the server tells every Bot.
 *
 * Sent as a run property (AG-UI `forwardedProps`) rather than a header, because it then travels with
 * the run itself: into an approval's stored continuation, and into the tool calls the run makes,
 * where a routine set without a zone takes this one.
 */

/** The `forwardedProps` key a browser run carries the person's IANA time zone under. */
export const PERSON_TIME_ZONE_PROP = "openbotTimeZone";

/** Longer than any zone the IANA database names; anything past it is not one. */
const MAX_TIME_ZONE_LENGTH = 64;

/**
 * Area/Location names and the bare ones (`UTC`), never an offset such as `+05:00`, which Intl
 * accepts on newer engines but which follows no daylight saving rule and is not a place.
 */
const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/**
 * The value as a time zone this runtime knows, canonicalised, or undefined for anything else.
 *
 * A run property is whatever the browser sent, so it is checked here rather than trusted: not a
 * string, too long, not shaped like an IANA name, or a name Intl does not know all read as absent,
 * and the Bot is told the date in UTC instead.
 */
export function personTimeZone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const zone = value.trim();
  if (
    zone.length === 0 ||
    zone.length > MAX_TIME_ZONE_LENGTH ||
    !IANA_NAME.test(zone)
  )
    return undefined;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
    }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** The person's time zone a run carries, checked. Undefined when it carries none or a bad one. */
export function runTimeZone(forwardedProps: unknown): string | undefined {
  if (
    typeof forwardedProps !== "object" ||
    forwardedProps === null ||
    Array.isArray(forwardedProps)
  )
    return undefined;
  return personTimeZone(
    (forwardedProps as Record<string, unknown>)[PERSON_TIME_ZONE_PROP],
  );
}

/** The time zone this device is set to, as the browser reports it. Undefined when it cannot say. */
export function deviceTimeZone(): string | undefined {
  try {
    return personTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return undefined;
  }
}

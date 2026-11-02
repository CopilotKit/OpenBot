/** At this many clicks, inputs and page loads in one recording the Recorder shows its notice in the page. */
export const RECORDER_ACTION_NOTICE_AT = 50;

/** A recording moves to a linked trajectory after this many events, before it reaches the 20,000 that Intelligence
 * keeps in one trajectory. */
export const TRAJECTORY_ROLLOVER_AT = 19_000;

/**
 * How long a stopped recording waits in this browser for its person to connect again (Decision 19) before it is deleted
 * unsent, from when it began waiting: as long as OpenBot itself keeps a person signed in, 7 days (better-auth's default
 * session `expiresIn`, which OpenBot leaves as it is, and the organization session cookie's `COOKIE_AGE` in
 * server/src/auth/organization.ts). Only recordings waiting for someone are bounded: the connected person's own kept
 * recordings are tried again and the popup offers to discard them.
 */
export const KEPT_FOR_PERSON_DAYS = 7;
export const KEPT_FOR_PERSON_MS = KEPT_FOR_PERSON_DAYS * 24 * 60 * 60 * 1000;

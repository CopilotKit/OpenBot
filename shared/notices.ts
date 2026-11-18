/**
 * NOTICES OPENBOT SHOWS A PERSON ONCE, AND THE RULE FOR WHEN.
 *
 * A notice (a nudge) is shown to a person at most until they answer it. Either answer is saved to
 * their preferences as the notice's id in `dismissedNotices`, so no device shows it again. Whether one
 * is due now is the server's call, made on every read of the person's preferences (`noticesDue`), so
 * the rule below is kept in one place and every app reads the same answer.
 *
 * A new nudge is a new id here, a rule on the server, and a card in the app. The preferences, the
 * dismissal and the events (`POST .../nudge-events`) need nothing new.
 */

/** The ask to star OpenBot on GitHub, in the personal edition only. */
export const STAR_ON_GITHUB = "star-on-github";

/** What a notice id may be: `NoticeId` in api/openapi/common.yaml. */
export const NOTICE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The most notices one person's list holds: `maxItems` in api/openapi/accounts.yaml. */
export const MAX_NOTICES = 64;

/**
 * A moment a person got something out of OpenBot, which is when a nudge may ask something of them:
 * they copied a Bot's answer, one of their routines finished a run, or a long task (a Bot's task in a
 * conversation of its own) finished with a result.
 */
export type NudgeMoment = "result_copied" | "routine_succeeded" | "task_finished";

/**
 * When the star nudge is due. Only in the personal edition (OpenBot for one person), never a team's,
 * and never once dismissed. Then: the person has used OpenBot on at least `daysActive` separate days
 * (a day on which they sent a message, counted as UTC calendar days), and the last thing that
 * happened to them was a win, within `winWithinMs`. An error after the win (a routine or a task that
 * failed) takes it back, so the card never follows an error.
 */
export const STAR_NUDGE_RULE = {
  daysActive: 3,
  winWithinMs: 10 * 60_000,
} as const;

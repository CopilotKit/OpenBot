/*
 * The words for what always asks and for the "Always ask before making changes" switch, shared by
 * onboarding's Welcome and Settings → Approvals so the two never say different things.
 *
 * Each sentence is what server/src/approvals/policy.ts does:
 * - Deleting, sending, sharing and posting in an app or on a website are safety asks, decided before
 *   any rule or the switch is read, so they ask with the switch off.
 * - Payments and credential or security-setting changes are hand-offs, not asks: the person does
 *   them, the Bot never does.
 * - The switch asks before every change that isn't a read, a Bot's own workspace included, unless a
 *   rule allows it.
 * - A Bot's own workspace (`computer_write_file`, `computer_run_command`) is left out of the safety
 *   asks, so deleting a file there asks only when the switch, Auto-review or a rule says so.
 */

export const ALWAYS_ASKS =
  "Bots always ask for your approval before deleting, sending, sharing, or posting content in your apps or on websites.";

export const HANDED_TO_YOU =
  "Bots leave payments and account security changes for you to do yourself.";

export const ASK_FIRST_TITLE = "Always ask before making changes";

export const ASK_FIRST_DESCRIPTION =
  "Require your approval for every change to your apps, websites, and files, including routine edits and updates.";

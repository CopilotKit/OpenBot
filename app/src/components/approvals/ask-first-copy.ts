/*
 * The words for what always asks and for the "Extra vigilant" switch, shared by
 * onboarding's Welcome and Settings → Approvals so the two never say different things.
 *
 * Each sentence is what server/src/approvals/policy.ts does:
 * - Deleting, sending, sharing, posting and paying in an app or on a website ask with the switch
 *   off. Open by default: the person can allow each once, for a conversation, or always, unless the
 *   admin set that kind to ask every time.
 * - A password or other sign-in detail changed on a website is a hand-off: only the person has it.
 * - The switch asks before every change that isn't a read, a Bot's own workspace included, unless a
 *   rule allows it.
 * - A Bot's own workspace (`computer_write_file`, `computer_run_command`) is left out of the safety
 *   asks, so deleting a file there asks only when the switch, Auto-review or a rule says so.
 */

export const ALWAYS_ASKS =
  "Bots ask for your approval before deleting, sending, sharing, posting, or paying in your apps or on websites. You can allow each one once, for a conversation, or always.";

/**
 * What asks with the switch off, said once on onboarding's Welcome, where the switch is offered: the
 * same rule as ALWAYS_ASKS in fewer words. Not "always": the person can allow each kind once, for a
 * conversation, or always. "In your apps or on websites" stays, because a Bot deleting a file in its
 * own workspace does not ask.
 */
export const ALWAYS_ASKS_SHORT =
  "Bots ask before they delete, send, share, post, or pay in your apps or on websites.";

export const HANDED_TO_YOU =
  "Bots leave changing a password on a website for you to do yourself.";

export const ASK_FIRST_TITLE = "Extra vigilant";

export const ASK_FIRST_DESCRIPTION =
  "Require your approval for every change to your apps, websites, and files, including routine edits and updates.";

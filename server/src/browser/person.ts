import {
  isPersonBrowserId,
  PERSON_BROWSER_PREFIX,
} from "@openbot/shared/openbot-browser";
import { personDigest } from "../learning/personal-space";

/**
 * A person's own OpenBot browser, as a computer: `person-` and the same 32 hex digits their Learning space is named with
 * (learning/personal-space.ts). Hashed rather than copied for the same reasons: a user id is any text, the same person
 * always gets the same browser on every replica with nothing to look up, and two people never share one. Every way of
 * reaching a computer then carries it unchanged, with the id in `x-openbot-bot-id` as a Bot's is.
 */
export function personBrowserId(userId: string): string {
  return `${PERSON_BROWSER_PREFIX}${personDigest(userId)}`;
}

/**
 * The install id the OpenBot browser's Recorder connection is stored under: the browser id's own 32 hex digits, the
 * shape every install id has. The same every time, so each open replaces the browser's previous connection (the same
 * copy connecting again, Decision 18) instead of adding another.
 */
export function personBrowserInstallId(computerId: string): string {
  return computerId.slice(PERSON_BROWSER_PREFIX.length);
}

/**
 * Whether this person may reach this browser: only when it is their own. Not an admin, not anybody else: a person's
 * browser holds what they signed into by hand, so its screen and what it records are theirs alone, which no Bot's
 * computer access rule (agents/computer-access.ts) says for a Bot.
 */
export function ownsPersonBrowser(
  actor: { id: string },
  computerId: string,
): boolean {
  return (
    isPersonBrowserId(computerId) && computerId === personBrowserId(actor.id)
  );
}

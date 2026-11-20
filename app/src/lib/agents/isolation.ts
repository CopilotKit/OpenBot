/**
 * The words for Isolated Bots, said the same way in the New Bot sheet and on a Bot's Setup row.
 *
 * Kept together because they answer one question from two places, and a reader who meets the
 * tooltip when making a Bot should meet the same sentence when they come back to change it.
 */

/** What Isolated means. */
export const ISOLATED_EXPLAINED =
  "Runs in its own computer. Nothing it does can reach your other Bots' files or logins. Costs more to run.";

/** Added for a public Bot, whose one computer is everybody's. */
export const ISOLATED_PUBLIC =
  "Everyone who uses this Bot shares that computer.";

/**
 * Said on an isolated Bot's Visibility row. Its one computer is shared by everybody who uses it, so a public one shares
 * whatever anybody signed in to there with everybody else, as a shared Bot's computer does across the industry. Said
 * before it is made public, and while it is.
 */
export const ISOLATED_PUBLIC_SHARES_LOGINS =
  "Everyone who uses it shares its computer, so anything signed in to there is theirs too.";

/** The same, said to the owner of a private isolated Bot before they make it public. */
export const ISOLATED_MAKING_PUBLIC =
  "Making it public shares its computer, and anything signed in to there, with everyone who uses it.";

/** Why it cannot be ticked on this deployment. */
export const ISOLATION_UNAVAILABLE =
  "This OpenBot can't give a Bot a computer of its own.";

/** Why it cannot be ticked by this person. */
export const ISOLATION_NOT_ALLOWED =
  "Your admin turned off Isolated Bots for you.";

/** An isolated Bot whose owner lost the switch, which keeps running on their shared computer. */
export const ISOLATION_WITHDRAWN =
  "Your admin turned off Isolated Bots, so this Bot runs on your computer.";

/** An isolated Bot on a deployment that can no longer make it a computer of its own. */
export const ISOLATION_GONE =
  "This OpenBot can't give a Bot a computer of its own, so this Bot runs on your computer.";

/** The whole explanation for a Bot of this visibility. */
export function isolatedExplained(isPublic: boolean): string {
  return isPublic
    ? `${ISOLATED_EXPLAINED} ${ISOLATED_PUBLIC}`
    : ISOLATED_EXPLAINED;
}

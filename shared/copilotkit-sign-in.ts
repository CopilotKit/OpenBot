/**
 * Why a sign-in through a CopilotKit organization did not finish.
 *
 * The server sends the browser back to the sign-in screen with one of these as `?error=`, and the
 * screen says what it means. A code and never a message: a message in a URL is text anybody can
 * write into a link to this OpenBot's sign-in page.
 */
export const COPILOTKIT_SIGN_IN_ERRORS = [
  /** The person is in a different CopilotKit organization from the one this OpenBot serves. */
  "copilotkit_other_organization",
  /** CopilotKit no longer lists the person in this OpenBot's organization. */
  "copilotkit_not_member",
  /** The one-time code was used already, expired, or does not belong to this browser. */
  "copilotkit_expired",
  /** An admin here removed the person. */
  "copilotkit_removed",
  /** CopilotKit did not answer, or answered with something OpenBot could not read. */
  "copilotkit_unavailable",
  /** Anything else. */
  "copilotkit_failed",
] as const;

export type CopilotKitSignInError = (typeof COPILOTKIT_SIGN_IN_ERRORS)[number];

export function isCopilotKitSignInError(
  value: unknown,
): value is CopilotKitSignInError {
  return (
    typeof value === "string" &&
    (COPILOTKIT_SIGN_IN_ERRORS as readonly string[]).includes(value)
  );
}

/** Where the sign-in screen sends somebody to start signing in through CopilotKit. */
export const COPILOTKIT_SIGN_IN_START_PATH = "/api/auth/copilotkit/start";

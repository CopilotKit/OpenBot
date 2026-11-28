/** What the server says on every other request to somebody in no organization, said here too. */
export const IN_NONE =
  "You aren't a member of an organization here. Ask an admin to add you.";

/**
 * Signed in, and in no organization here: never added, or removed from the last one. Every screen of the app works in
 * an organization, so this is answered with the page for somebody in none (`NoOrganizationPage`), never an error
 * screen, and the sign-in screen is shown as for anybody.
 *
 * It is an answer, not a failure: asking again at once says the same, so the query client never retries it
 * (query-client.ts).
 */
export class InNoOrganization extends Error {
  constructor() {
    super(IN_NONE);
    this.name = "InNoOrganization";
  }
}

/** Whether a failure is the person being in no organization here. */
export function inNoOrganization(error: unknown): error is InNoOrganization {
  return error instanceof InNoOrganization;
}

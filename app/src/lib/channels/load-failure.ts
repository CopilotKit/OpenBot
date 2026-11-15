import { ClientError } from "@/lib/client";

/**
 * What the conversation screen says when it has no conversation to draw.
 *
 * A conversation that is not there is not a failed load, and "Reload the page" does not bring it
 * back. Somebody who works in several organizations reaches one this way often: Back, a bookmark
 * or a link from before they switched opens a conversation of the organization they left, which
 * this one does not have. They are told where they are looking, and where it may be.
 *
 * `organization` is the name of the one the person is working in, given only when they have
 * another to look in.
 */
export function conversationLoadFailure(
  error: unknown,
  organization?: string,
): string {
  if (error instanceof ClientError && error.status === 404) {
    return organization
      ? `Couldn't find this conversation in ${organization}. It may be in another of your organizations.`
      : "Couldn't find this conversation. It may have been deleted.";
  }
  return "Couldn't load this conversation. Reload the page.";
}

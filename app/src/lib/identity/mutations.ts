import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  deleteLinkedAccount,
  linkAccount,
} from "@/lib/api/generated/linked-accounts/linked-accounts";
import { idempotencyKey, ORGANIZATION_ID } from "@/lib/api/request";
import { ClientError } from "@/lib/client";
import { identityKeys } from "./queries";

const UNLINK_FALLBACK = "The account could not be disconnected";

/** The API's code for "no such link". */
export const LINKED_ACCOUNT_NOT_FOUND = "LINKED_ACCOUNT_NOT_FOUND";

/**
 * Whether a refusal says the link is already gone: the API's own 404, `LINKED_ACCOUNT_NOT_FOUND`.
 * Removed in another tab, or by a retry after a failed audit write, which is what the person asked
 * for, so it is success. Any other 404 (a proxy, a missing route, an SPA fallback page) says nothing
 * about the link and is a failure: the credential may still be live.
 */
export function alreadyUnlinked(error: unknown): boolean {
  return (
    error instanceof ClientError &&
    error.status === 404 &&
    error.code === LINKED_ACCOUNT_NOT_FOUND
  );
}

export function unlinkMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string): Promise<void> => {
      try {
        await deleteLinkedAccount(
          ORGANIZATION_ID,
          "me",
          id,
          { "Idempotency-Key": idempotencyKey() },
          { fallback: UNLINK_FALLBACK },
        );
      } catch (error) {
        if (alreadyUnlinked(error)) return;
        throw error;
      }
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: identityKeys.links() }),
  });
}

/** A one-time code the person sends to the bot in Slack to link their account. */
export type SlackLinkCode = {
  code: string;
  expiresAt: string;
  instruction: string;
};

const SLACK_CODE_FAILED = "Could not create a Slack link code";

export function issueSlackCodeMutationOptions() {
  return mutationOptions({
    mutationFn: async (): Promise<SlackLinkCode> => {
      const started = await linkAccount(
        ORGANIZATION_ID,
        "me",
        { provider: "slack" },
        { "Idempotency-Key": idempotencyKey() },
        { fallback: SLACK_CODE_FAILED },
      );
      if (started.provider !== "slack") throw new Error(SLACK_CODE_FAILED);
      return {
        code: started.code,
        expiresAt: started.expiresAt,
        instruction: started.instruction,
      };
    },
  });
}

const CONNECT_GITHUB_FAILED = "Could not start connecting GitHub. Try again.";

/**
 * The only address the browser will follow after asking to connect GitHub: the OAuth authorize page
 * on github.com over https. Anything else — a missing envelope, `javascript:`, another host — is a
 * broken or tampered response, and navigating to it would hand the person to somewhere else.
 */
export function githubAuthorizationUrl(value: unknown): string {
  const candidate =
    value && typeof value === "object"
      ? (value as { authorizationUrl?: unknown }).authorizationUrl
      : undefined;
  if (typeof candidate !== "string") throw new Error(CONNECT_GITHUB_FAILED);
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(CONNECT_GITHUB_FAILED);
  }
  if (
    url.protocol !== "https:" ||
    url.host !== "github.com" ||
    url.pathname !== "/login/oauth/authorize"
  ) {
    throw new Error(CONNECT_GITHUB_FAILED);
  }
  return candidate;
}

/** Resolves to the GitHub consent URL; the caller navigates, not this factory. */
export function connectGithubMutationOptions() {
  return mutationOptions({
    mutationFn: async (): Promise<string> =>
      // Checked, whatever the answer says: the browser follows it.
      githubAuthorizationUrl(
        await linkAccount(
          ORGANIZATION_ID,
          "me",
          { provider: "github" },
          { "Idempotency-Key": idempotencyKey() },
          { fallback: CONNECT_GITHUB_FAILED },
        ),
      ),
  });
}

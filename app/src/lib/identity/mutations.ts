import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import { identityKeys } from "./queries";

const UNLINK_FALLBACK = "The account could not be disconnected";

/** The machine-readable code on the server's own "no such link" 404. */
export const IDENTITY_LINK_NOT_FOUND = "identity_link_not_found";

/**
 * The server's own 404, tagged `code: "identity_link_not_found"`, means the link is already gone —
 * removed in another tab, or by a retry after a failed audit write — which is what the person asked
 * for, so it is success rather than an error. Any other 404 (a proxy, a missing route, an SPA
 * fallback page) says nothing about the link, so it throws: the credential may still be live.
 */
export async function unlinkOutcome(response: Response): Promise<void> {
  if (response.ok) return;
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
    code?: unknown;
  } | null;
  if (response.status === 404 && body?.code === IDENTITY_LINK_NOT_FOUND) {
    return;
  }
  throw new Error(
    typeof body?.error === "string" ? body.error : UNLINK_FALLBACK,
  );
}

export function unlinkMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string): Promise<void> =>
      unlinkOutcome(
        await tryClient(`/api/identity/links/${encodeURIComponent(id)}`, {
          method: "DELETE",
        }),
      ),
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

export function issueSlackCodeMutationOptions() {
  return mutationOptions({
    mutationFn: (): Promise<SlackLinkCode> =>
      client<SlackLinkCode>("/api/identity/challenges", "challenge", {
        method: "POST",
        body: { provider: "slack" },
        fallback: "Could not create a Slack link code",
      }),
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
      // `client` yields undefined when the envelope key is absent; the validator handles that.
      githubAuthorizationUrl(
        await client<unknown>("/api/identity/github/connect", "connect", {
          method: "POST",
          fallback: CONNECT_GITHUB_FAILED,
        }),
      ),
  });
}

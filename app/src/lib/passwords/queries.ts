import { queryOptions } from "@tanstack/react-query";
import type {
  SavedLogin as ApiSavedLogin,
  SignInRequest as ApiSignInRequest,
  SignInStatus as ApiSignInStatus,
} from "@/lib/api/generated/model";
import { listSavedLogins } from "@/lib/api/generated/saved-logins/saved-logins";
import {
  getSignInRequest,
  listSignInRequests,
} from "@/lib/api/generated/sign-in-requests/sign-in-requests";
import { organizationId } from "@/lib/api/request";

/** A person's own things are addressed as theirs: the API reads `me` as the caller. */
export const ME = "me";

/**
 * A Bot's request to be signed in to a website, as the private form sees it.
 *
 * Never carries a credential: the form sends one and the server passes it to the Bot's computer.
 * `savedLogins` lists usernames only, and only while the workspace's password manager is on.
 */
export type SignInStatus = ApiSignInStatus;
export type SignInRequest = ApiSignInRequest;
export type SavedLogin = ApiSavedLogin;

export const passwordKeys = {
  all: ["passwords"] as const,
  logins: () => ["passwords", "logins"] as const,
  signIn: (id: string) => ["passwords", "sign-in", id] as const,
  pending: () => ["passwords", "sign-in-requests"] as const,
};

export const FINAL_SIGN_IN: readonly SignInStatus[] = [
  "signed_in",
  "failed",
  "cancelled",
  "expired",
];

export function signInRequestQueryOptions(id: string) {
  return queryOptions({
    queryKey: passwordKeys.signIn(id),
    queryFn: async (): Promise<SignInRequest> =>
      (
        await getSignInRequest(organizationId(), ME, id, {
          fallback: "Could not load this sign-in request",
        })
      ).signInRequest,
  });
}

/**
 * Every page of a list the API pages, read to the end. A server that hands back the cursor it was
 * given would never end the list, so a repeated cursor ends it too.
 */
async function everyPage<Page extends { nextCursor: string | null }>(
  read: (cursor: string | undefined) => Promise<Page>,
): Promise<Page[]> {
  const pages: Page[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    pages.push(page);
    if (cursor) seen.add(cursor);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && !seen.has(cursor));
  return pages;
}

/** This person's open sign-in requests, newest first. */
export function pendingSignInRequestsQueryOptions() {
  return queryOptions({
    queryKey: passwordKeys.pending(),
    queryFn: async (): Promise<SignInRequest[]> =>
      (
        await everyPage((cursor) =>
          listSignInRequests(
            organizationId(),
            ME,
            { limit: 100, ...(cursor ? { cursor } : {}) },
            { fallback: "Could not load your sign-in requests" },
          ),
        )
      ).flatMap((page) => page.signInRequests),
  });
}

export function savedLoginsQueryOptions() {
  return queryOptions({
    queryKey: passwordKeys.logins(),
    queryFn: async (): Promise<{
      passwordManager: boolean;
      logins: SavedLogin[];
    }> => {
      const pages = await everyPage((cursor) =>
        listSavedLogins(
          organizationId(),
          ME,
          { limit: 100, ...(cursor ? { cursor } : {}) },
          { fallback: "Could not load your passwords" },
        ),
      );
      return {
        // Every page says it; the first is as good as any.
        passwordManager: pages[0]?.passwordManager ?? false,
        logins: pages.flatMap((page) => page.savedLogins),
      };
    },
  });
}

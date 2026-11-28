import { queryOptions } from "@tanstack/react-query";
import type {
  SavedLogin as ApiSavedLogin,
  SavedLoginCounts,
  SignInRequest as ApiSignInRequest,
  SignInStatus as ApiSignInStatus,
} from "@/lib/api/generated/model";
import {
  getUnusableSavedLogins,
  listSavedLogins,
} from "@/lib/api/generated/saved-logins/saved-logins";
import {
  getSignInRequest,
  listSignInRequests,
} from "@/lib/api/generated/sign-in-requests/sign-in-requests";
import { organizationId } from "@/lib/api/request";
import { ClientError } from "@/lib/client";

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
  unusable: () => ["passwords", "unusable"] as const,
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

/**
 * Whether a refusal is an OpenBot that has no such address: one released before the operation, or
 * the personal edition, which serves neither the count nor the purge of saved logins nobody may use.
 * That is the API's plain not found (`NOT_FOUND`), or a 404 that names no code, as `olderOpenBot`
 * in lib/service-terms/queries.ts reads it. Every other 404 is about this request
 * (`ORGANIZATION_NOT_FOUND`) and fails like any other refusal.
 */
export function notServedHere(error: unknown): boolean {
  return (
    error instanceof ClientError &&
    error.status === 404 &&
    (error.code === undefined || error.code === "NOT_FOUND")
  );
}

/**
 * For an admin: how many saved logins nobody may use, exactly what a purge would delete now, for
 * each reason. Null on an OpenBot that doesn't serve it, which serves no purge either.
 */
export function unusableSavedLoginsQueryOptions() {
  return queryOptions({
    queryKey: passwordKeys.unusable(),
    queryFn: async ({ signal }): Promise<SavedLoginCounts | null> => {
      try {
        return await getUnusableSavedLogins(organizationId(), {
          signal,
          fallback: "Couldn't count the saved logins. Try again.",
        });
      } catch (error) {
        if (notServedHere(error)) return null;
        throw error;
      }
    },
    // A count to act on: never kept as fresh.
    staleTime: 0,
  });
}

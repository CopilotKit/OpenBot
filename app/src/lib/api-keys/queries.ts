import { queryOptions } from "@tanstack/react-query";
import { everyPage } from "@/lib/api/every-page";
import { listApiKeys } from "@/lib/api/generated/api-keys/api-keys";
import type { ApiKey as ApiKeyRecord } from "@/lib/api/generated/model";
import { organizationId } from "@/lib/api/request";
import { ClientError } from "@/lib/client";

/** An API key the person made, as the API lists it. Never the key itself: `start` is its first characters. */
export type ApiKey = ApiKeyRecord;

export const apiKeyKeys = {
  all: ["api-keys"] as const,
  list: () => ["api-keys", "list"] as const,
};

const LOAD_FALLBACK = "Couldn't load your API keys.";

/** The API's code for "this OpenBot signs nobody in", which is OpenBot on one computer for one person. */
export const SIGN_IN_UNAVAILABLE = "SIGN_IN_UNAVAILABLE";

/** The API's code for a refusal by who is asking. */
export const PERMISSION_DENIED = "PERMISSION_DENIED";

/**
 * Whether a refusal is this OpenBot saying it has no sign-in, and so no API keys: the API's 503 with
 * `SIGN_IN_UNAVAILABLE`. That is the feature being absent, not the server breaking. Any other
 * failure, a 503 from a proxy included, is shown as a failure.
 */
export function apiKeysAbsent(error: unknown): boolean {
  return (
    error instanceof ClientError &&
    error.status === 503 &&
    error.code === SIGN_IN_UNAVAILABLE
  );
}

/**
 * Whether a refusal is the API saying keys are managed only by a person signed in to OpenBot on the
 * web: its 403 with `PERMISSION_DENIED`. The list is always the person's own (`me`), so the only way
 * to be refused is to have signed in as an app, which is what OpenBot Desktop connected to an OpenBot
 * elsewhere does.
 */
export function apiKeysNeedBrowser(error: unknown): boolean {
  return (
    error instanceof ClientError &&
    error.status === 403 &&
    error.code === PERMISSION_DENIED
  );
}

/**
 * What the screen has to show: the person's keys, or one of the two reasons there is no list. Both
 * reasons are answers, not failures, so the screen says them in a sentence.
 */
export type ApiKeyList =
  | { state: "ready"; apiKeys: ApiKey[] }
  /** This OpenBot has no sign-in, so it has no keys. */
  | { state: "unavailable" }
  /** Keys are managed from OpenBot in a browser, not from here. */
  | { state: "browser-only" };

/** Every page of the person's API keys, newest first. A handful at most, so the screen reads them all. */
export function apiKeyListQueryOptions() {
  return queryOptions({
    queryKey: apiKeyKeys.list(),
    queryFn: async ({ signal }): Promise<ApiKeyList> => {
      try {
        const apiKeys = await everyPage<ApiKey>(async (cursor) => {
          const page = await listApiKeys(
            organizationId(),
            "me",
            { limit: 100, ...(cursor ? { cursor } : {}) },
            { signal, fallback: LOAD_FALLBACK },
          );
          return { items: page.apiKeys, nextCursor: page.nextCursor };
        });
        return { state: "ready", apiKeys };
      } catch (error) {
        if (apiKeysAbsent(error)) return { state: "unavailable" };
        if (apiKeysNeedBrowser(error)) return { state: "browser-only" };
        throw error;
      }
    },
    /*
     * A key's last use changes away from this screen: a script used it while the person was in
     * their terminal. Coming back to the window, or to the screen, asks again, so "Never used" is
     * not drawn from the list read before.
     */
    refetchOnWindowFocus: "always",
    refetchOnMount: "always",
  });
}

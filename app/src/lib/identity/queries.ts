import { queryOptions } from "@tanstack/react-query";
import {
  listLinkedAccountProviders,
  listLinkedAccounts,
} from "@/lib/api/generated/linked-accounts/linked-accounts";
import { ORGANIZATION_ID } from "@/lib/api/request";
import { ClientError } from "@/lib/client";

export type LinkedAccount = {
  id: string;
  provider: "slack" | "github";
  title: string;
  handle: string | null;
  status: "active" | "needs_reconnect";
  createdAt: string;
};

export const identityKeys = {
  all: ["identity"] as const,
  links: () => [...identityKeys.all, "links"] as const,
  providers: () => [...identityKeys.all, "providers"] as const,
};

const LOAD_FALLBACK = "Could not load your linked accounts";
const PROVIDERS_FALLBACK = "Could not load the account types you can link";

/** The API's code for "this deployment keeps no linked accounts at all". */
export const LINKED_ACCOUNTS_UNAVAILABLE = "LINKED_ACCOUNTS_UNAVAILABLE";

/**
 * Whether a refusal is the deployment saying it keeps no linked accounts: the API's 503 with
 * `LINKED_ACCOUNTS_UNAVAILABLE`. That is the feature being absent, not the server breaking, so it
 * reads as nothing to show and the section hides itself. Any other failure, a 503 from a proxy or the
 * platform included, is shown.
 */
export function linkedAccountsAbsent(error: unknown): boolean {
  return (
    error instanceof ClientError &&
    error.status === 503 &&
    error.code === LINKED_ACCOUNTS_UNAVAILABLE
  );
}

/** Every page of the person's linked accounts. A handful at most, so the screen reads them all. */
async function allLinks(signal?: AbortSignal): Promise<LinkedAccount[]> {
  const links: LinkedAccount[] = [];
  let cursor: string | undefined;
  do {
    const page = await listLinkedAccounts(
      ORGANIZATION_ID,
      "me",
      { limit: 100, ...(cursor ? { cursor } : {}) },
      { ...(signal ? { signal } : {}), fallback: LOAD_FALLBACK },
    );
    links.push(...page.linkedAccounts);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return links;
}

export function linkedAccountsQueryOptions() {
  return queryOptions({
    queryKey: identityKeys.links(),
    queryFn: async ({ signal }): Promise<LinkedAccount[]> => {
      try {
        return await allLinks(signal);
      } catch (error) {
        if (linkedAccountsAbsent(error)) return [];
        throw error;
      }
    },
  });
}

/** Which account types this deployment can link a person to. */
export type IdentityProviders = { slack: boolean; github: boolean };

export function identityProvidersQueryOptions() {
  return queryOptions({
    queryKey: identityKeys.providers(),
    queryFn: async ({ signal }): Promise<IdentityProviders> => {
      try {
        const page = await listLinkedAccountProviders(
          ORGANIZATION_ID,
          { limit: 100 },
          { signal, fallback: PROVIDERS_FALLBACK },
        );
        const offered = page.linkedAccountProviders.map(
          (provider) => provider.id,
        );
        return {
          slack: offered.includes("slack"),
          github: offered.includes("github"),
        };
      } catch (error) {
        // No linked accounts here, so nothing is linkable.
        if (linkedAccountsAbsent(error)) return { slack: false, github: false };
        throw error;
      }
    },
  });
}

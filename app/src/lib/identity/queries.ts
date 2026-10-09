import { queryOptions } from "@tanstack/react-query";
import { tryClient } from "@/lib/client";

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

/** The machine-readable code on the server's own "no identity store here" 503. */
export const IDENTITY_UNAVAILABLE = "identity_unavailable";

/**
 * A deployment without an identity store answers 503 with `code: "identity_unavailable"`. That is
 * the feature being absent, not the server breaking, so it reads as no links and the section hides
 * itself. Any other failure, including a 503 from a proxy or the platform, throws so it is shown.
 */
export async function linksFromResponse(
  response: Response,
): Promise<LinkedAccount[]> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: unknown;
      code?: unknown;
    } | null;
    if (response.status === 503 && body?.code === IDENTITY_UNAVAILABLE) {
      return [];
    }
    throw new Error(
      typeof body?.error === "string" ? body.error : LOAD_FALLBACK,
    );
  }
  const body = (await response.json().catch(() => null)) as {
    links?: LinkedAccount[];
  } | null;
  if (!body || !Array.isArray(body.links)) throw new Error(LOAD_FALLBACK);
  return body.links;
}

export function linkedAccountsQueryOptions() {
  return queryOptions({
    queryKey: identityKeys.links(),
    queryFn: async (): Promise<LinkedAccount[]> =>
      linksFromResponse(await tryClient("/api/identity/links")),
  });
}

/** Which account types this deployment can link a person to. */
export type IdentityProviders = { slack: boolean; github: boolean };

const PROVIDERS_FALLBACK = "Could not load the account types you can link";

/** The tagged 503 means no identity store, so nothing is linkable; other failures throw. */
export async function providersFromResponse(
  response: Response,
): Promise<IdentityProviders> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: unknown;
      code?: unknown;
    } | null;
    if (response.status === 503 && body?.code === IDENTITY_UNAVAILABLE) {
      return { slack: false, github: false };
    }
    throw new Error(
      typeof body?.error === "string" ? body.error : PROVIDERS_FALLBACK,
    );
  }
  const body = (await response.json().catch(() => null)) as {
    providers?: { slack?: unknown; github?: unknown };
  } | null;
  const providers = body?.providers;
  if (
    !providers ||
    typeof providers.slack !== "boolean" ||
    typeof providers.github !== "boolean"
  ) {
    throw new Error(PROVIDERS_FALLBACK);
  }
  return { slack: providers.slack, github: providers.github };
}

export function identityProvidersQueryOptions() {
  return queryOptions({
    queryKey: identityKeys.providers(),
    queryFn: async (): Promise<IdentityProviders> =>
      providersFromResponse(await tryClient("/api/identity/providers")),
  });
}

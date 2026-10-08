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

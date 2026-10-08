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

/**
 * A deployment without an identity store answers 503 "not available". That is the feature being
 * absent, not the server breaking, so it reads as no links and the section hides itself.
 */
export async function linksFromResponse(
  response: Response,
): Promise<LinkedAccount[]> {
  if (response.status === 503) return [];
  if (!response.ok) {
    const message = await response
      .json()
      .then((body: { error?: string }) => body.error)
      .catch(() => undefined);
    throw new Error(message ?? LOAD_FALLBACK);
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

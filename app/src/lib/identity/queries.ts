import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export type LinkedAccount = {
  id: string;
  provider: "slack" | "github";
  title: string;
  handle: string | null;
  status: "active" | "needs_reconnect";
  createdAt: string;
};

/** What the confirm page learns about a link challenge before the person agrees to it. */
export type LinkChallenge = {
  provider: LinkedAccount["provider"];
  title: string;
  handle: string | null;
};

export const identityKeys = {
  all: ["identity"] as const,
  links: () => [...identityKeys.all, "links"] as const,
  challenge: (token: string) =>
    [...identityKeys.all, "challenge", token] as const,
};

export function linkedAccountsQueryOptions() {
  return queryOptions({
    queryKey: identityKeys.links(),
    queryFn: async (): Promise<LinkedAccount[]> =>
      client<LinkedAccount[]>("/api/identity/links", "links", {
        fallback: "Could not load your linked accounts",
      }),
  });
}

/** A POST because the token is a secret and does not belong in a URL the server logs. */
export function challengeQueryOptions(token: string) {
  return queryOptions({
    queryKey: identityKeys.challenge(token),
    queryFn: async (): Promise<LinkChallenge> =>
      client<LinkChallenge>("/api/identity/challenges/peek", "challenge", {
        method: "POST",
        body: { token },
        fallback: "This link expired or was already used",
      }),
    retry: false,
  });
}

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

export const identityKeys = {
  all: ["identity"] as const,
  links: () => [...identityKeys.all, "links"] as const,
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

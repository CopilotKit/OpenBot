import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** One trail row that means a Bot is waiting on a person. */
export type AttentionItem = {
  /** The trail row's id; resolving cites the exact row. */
  id: string;
  kind: "refused" | "tool_rejected" | "stalled";
  botId: string;
  at: string;
  /** One sentence a person can act on, written by whatever recorded the row. */
  sentence: string;
};

export const attentionKeys = {
  all: ["attention"] as const,
  list: () => ["attention", "list"] as const,
};

/**
 * Polled the way grants are: often enough that a Bot in trouble is noticed inside a minute, and
 * refetched on focus so coming back to the tab answers immediately.
 */
export function attentionListQueryOptions() {
  return queryOptions({
    queryKey: attentionKeys.list(),
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    queryFn: (): Promise<AttentionItem[]> =>
      client("/api/attention", "items", {
        fallback: "The attention list could not be loaded.",
      }),
  });
}

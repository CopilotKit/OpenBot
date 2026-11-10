import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { AuditEvent } from "@/components/audit/audit-cells";
import { client } from "@/lib/client";

export const auditKeys = {
  all: ["audit-events"] as const,
  list: (search = "") => ["audit-events", "list", { search }] as const,
  vocabulary: ["audit-events", "vocabulary"] as const,
};

/**
 * What a filter on the trail may name in this deployment: its Bots, the people the trail has, the
 * apps and tools it has seen, and the boundary rules, now and in the trail. The values a chip on
 * the Audit page is edited from, and the only ones the model may choose.
 */
export type AuditVocabulary = {
  bots: { id: string; name: string }[];
  people: { id: string; name: string | null; email: string }[];
  /** Apps by their key (`gmail`), whichever broker carried them. */
  apps: { key: string; name: string }[];
  /** `calls` is how many rows the trail holds for the tool; 0 for one never called. */
  tools: { app: string; tool: string; calls: number }[];
  rules: { rule: string; name: string | null; refusals: number }[];
};

export function auditVocabularyQueryOptions() {
  return queryOptions({
    queryKey: auditKeys.vocabulary,
    queryFn: async (): Promise<AuditVocabulary> =>
      (
        await client("/api/admin/audit-events/vocabulary", {
          fallback: "Couldn't load the filters",
        })
      ).json(),
  });
}

/** One page of the trail as `GET /api/admin/audit-events` answers it, newest first. */
export type AuditEventsPage = {
  events: AuditEvent[];
  /** Where the next, older page starts. Absent on the last page. */
  nextCursor?: string;
};

/**
 * The trail for one view (`search`, e.g. `?eventType=...`), a page at a time.
 *
 * Paged because the trail only grows. This used to ask once and never follow `nextCursor`, so the
 * page showed the newest 50 events, called them the whole trail, and had no way to reach the rest.
 */
export function auditEventsQueryOptions(search = "") {
  return infiniteQueryOptions({
    queryKey: auditKeys.list(search),
    initialPageParam: "",
    queryFn: async ({ pageParam }): Promise<AuditEventsPage> => {
      // `search` is empty or starts with `?`; an older page carries the cursor after it.
      const cursor = pageParam
        ? `${search ? "&" : "?"}cursor=${encodeURIComponent(pageParam)}`
        : "";
      const response = await client(
        `/api/admin/audit-events${search}${cursor}`,
        { fallback: "Could not load audit events" },
      );
      return response.json();
    },
    getNextPageParam: (page: AuditEventsPage) => page.nextCursor || undefined,
  });
}

/**
 * The CSV download behind the Audit page's Export button.
 *
 * Carries the page's current filter (`search`, e.g. `?eventType=...`) into
 * `GET /api/admin/audit-events?format=csv`, so the file and the table agree. A `format`
 * already on the search is replaced rather than doubled, and paging params are dropped:
 * the export walks every matching page server-side up to its cap.
 */
export function auditExportUrl(search = ""): string {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  params.delete("cursor");
  params.delete("limit");
  params.set("format", "csv");
  const query = params.toString();
  return `/api/admin/audit-events${query ? `?${query}` : "?format=csv"}`;
}

import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export const auditKeys = { all: ["audit-events"] as const };

export function auditEventsQueryOptions(search = "") {
  return queryOptions({
    queryKey: [...auditKeys.all, search] as const,
    queryFn: async () => {
      const response = await client(`/api/admin/audit-events${search}`, {
        fallback: "Could not load audit events",
      });
      return response.json();
    },
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

import type { QueryClient } from "@tanstack/react-query";
import { auditKeys } from "@/lib/audit/queries";

/**
 * One page of the trail in the cache, as `GET /api/admin/audit-events` answers it (`{ events }`, and
 * `nextCursor` when older events remain), under the key the page asks for the view `search` with.
 * The page reads it as the first page of its paged query.
 */
export function seedAuditPage(
  queryClient: QueryClient,
  search: string,
  page: { events: unknown[]; nextCursor?: string },
): void {
  queryClient.setQueryData(auditKeys.list(search), {
    pages: [page],
    pageParams: [""],
  });
}

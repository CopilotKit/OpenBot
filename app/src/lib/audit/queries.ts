import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { AuditEvent } from "@/components/audit/audit-cells";
import {
  exportAuditEvents,
  getAuditEventVocabulary,
  listAuditEvents,
} from "@/lib/api/generated/audit-events/audit-events";
import type {
  AuditVocabulary as ApiAuditVocabulary,
  ExportAuditEventsParams,
  ListAuditEventsParams,
} from "@/lib/api/generated/model";
import { ORGANIZATION_ID } from "@/lib/api/request";

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
export type AuditVocabulary = ApiAuditVocabulary;

export function auditVocabularyQueryOptions() {
  return queryOptions({
    queryKey: auditKeys.vocabulary,
    queryFn: ({ signal }) =>
      getAuditEventVocabulary(ORGANIZATION_ID, {
        signal,
        fallback: "Couldn't load the filters",
      }),
  });
}

/** One page of the trail, newest first. */
export type AuditEventsPage = {
  events: AuditEvent[];
  /** Where the next, older page starts. Absent on the last page. */
  nextCursor?: string;
};

/** The filters the API's audit operations take, each one a query parameter of the same name. */
const FILTERS = [
  "eventType",
  "excludeEventType",
  "excludeCalls",
  "actorUserId",
  "initiatorKind",
  "targetType",
  "targetId",
  "bot",
  "app",
  "tool",
  "effect",
  "intent",
  "rule",
  "from",
  "to",
] as const satisfies readonly (keyof ExportAuditEventsParams)[];

/**
 * A view's query (`search`, empty or `?eventType=...`) as the API's filters.
 *
 * The page builds its views as query strings, the way the trail has always been asked. Paging and
 * `format` are not filters, so they are dropped: the list pages by its own cursor, and the export is
 * an operation of its own.
 */
export function auditFilterParams(search = ""): ExportAuditEventsParams {
  const query = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const params: Record<string, string> = {};
  for (const name of FILTERS) {
    const value = query.get(name);
    if (value !== null) params[name] = value;
  }
  return params as ExportAuditEventsParams;
}

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
    queryFn: async ({ pageParam, signal }): Promise<AuditEventsPage> => {
      const params: ListAuditEventsParams = {
        ...auditFilterParams(search),
        ...(pageParam ? { cursor: pageParam } : {}),
      };
      const page = await listAuditEvents(ORGANIZATION_ID, params, {
        signal,
        fallback: "Could not load audit events",
      });
      return {
        events: page.auditEvents,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },
    getNextPageParam: (page: AuditEventsPage) => page.nextCursor || undefined,
  });
}

/** The CSV behind the Audit page's Export button, and how much of what matched it holds. */
export type AuditExport = {
  csv: string;
  /** Set when more events matched than the file holds: the number it holds. */
  truncatedAt?: number;
};

/**
 * The same filtered query as the table, as one file, so the file and the table agree. The server
 * walks every matching page up to its cap, so this is one request however many pages match.
 */
export async function exportAuditTrail(search = ""): Promise<AuditExport> {
  let truncatedAt: number | undefined;
  const csv = await exportAuditEvents(
    ORGANIZATION_ID,
    auditFilterParams(search),
    {
      fallback: "Couldn't export these events. Try again.",
      onResponse: (response) => {
        const held = Number(response.headers.get("openbot-export-truncated"));
        if (Number.isInteger(held) && held > 0) truncatedAt = held;
      },
    },
  );
  return { csv, ...(truncatedAt === undefined ? {} : { truncatedAt }) };
}

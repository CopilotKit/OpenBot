/**
 * The audit trail's API as the server answers it, for a test that fakes `fetch` by hand.
 *
 * The app reads the trail through the client generated from api/openapi.yaml, at
 * `/api/v2/organizations/default/audit-events`: a page comes back as `{ auditEvents, nextCursor }`
 * with `nextCursor` null on the last page, the export as `text/csv` with `OpenBot-Export-Truncated`
 * when the file stopped early, and the vocabulary and a question's answer as themselves.
 */

/**
 * The Response a real `fetch` returns. Read before any test registers happy-dom, as each test file
 * that needs it does at its top.
 */
const NativeResponse = globalThis.Response;

/** Where the app reads the trail: the API's address in the one organization. */
export const AUDIT_PATH = "/api/v2/organizations/default/audit-events";
export const AUDIT_EXPORT_PATH = `${AUDIT_PATH}/export`;
export const AUDIT_VOCABULARY_PATH = `${AUDIT_PATH}/vocabulary`;
export const AUDIT_ASK_PATH = `${AUDIT_PATH}/ask`;

/** One page of the trail, as the API's body. Null ends the list. */
export function auditPageBody(
  events: readonly unknown[],
  nextCursor: string | null = null,
) {
  return { auditEvents: events, nextCursor };
}

/** One page of the trail, as the API answers it. */
export function auditPage(
  events: readonly unknown[],
  nextCursor: string | null = null,
): Response {
  return NativeResponse.json(auditPageBody(events, nextCursor));
}

/** The export, as the API answers it: the file, and how many events it holds when it stopped early. */
export function auditExport(csv: string, truncatedAt?: number): Response {
  return new NativeResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition":
        'attachment; filename="audit-events-2026-11-14.csv"',
      ...(truncatedAt === undefined
        ? {}
        : { "openbot-export-truncated": String(truncatedAt) }),
    },
  });
}

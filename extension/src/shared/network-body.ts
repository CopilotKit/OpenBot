// How a request or response body is kept in a network event, in the collector's own shape (`@copilotkit/learning`
// 0.0.1 `network-body.ts` BodySnapshot): one copy for debugger capture in the service worker and for the page-level
// hook, which bundles it into the page. Import-free, so the hook carries nothing else.

export type NetworkBody = {
  status: "complete" | "empty" | "truncated" | "unavailable";
  text?: string;
  encoding?: "utf-8";
  truncated?: true;
  /** A body past NETWORK_BODY_READ_MAX_BYTES: its full size, so the cut is never silent. */
  bytes?: number;
  reason?: string;
};

/** How much of a body is read (Decision 5's 2 MiB). What is read is masked as one piece before the event is cut to
 * Intelligence's 16 KiB, so a credential-named key is redacted wherever it sits in it. A body this cut short is no
 * longer valid JSON: `maskBody` then reads it key by key from its start, and a form body pair by pair, so no
 * credential in the part kept survives. */
export const NETWORK_BODY_READ_MAX_BYTES = 2 * 1024 * 1024;

const encoder = new TextEncoder();

/** Text bodies only: text/*, JSON, form-urlencoded and XML. Anything else, and any event stream, is not read. */
export function isReadableBody(
  contentType: string | null | undefined,
): boolean {
  if (!contentType) return false;
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "text/event-stream") return false;
  return (
    type.startsWith("text/") ||
    type === "application/x-www-form-urlencoded" ||
    type === "application/json" ||
    type.endsWith("+json") ||
    type === "application/xml" ||
    type.endsWith("+xml")
  );
}

export const unavailableBody = (reason: string): NetworkBody => ({
  status: "unavailable",
  reason,
});

/** The text whole, or its first `maxBytes` (cut on a code point boundary) marked truncated with its full size. */
export function textBody(
  text: string,
  maxBytes: number = NETWORK_BODY_READ_MAX_BYTES,
): NetworkBody {
  if (text === "") return { status: "empty" };
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes)
    return { status: "complete", text, encoding: "utf-8" };
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return {
    status: "truncated",
    truncated: true,
    text: new TextDecoder().decode(bytes.subarray(0, end)),
    encoding: "utf-8",
    bytes: bytes.length,
  };
}

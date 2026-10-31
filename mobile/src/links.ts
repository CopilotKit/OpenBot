/**
 * Where a tap on a notification goes, read from the link the server put in it. Only known screens,
 * and only an `openbotmobile:` link with nothing in it that could point anywhere else. A ping opens
 * the person's Needs you list, and needs no conversation to name.
 */
export function notificationDestination(value: unknown):
  | {
      pathname: "/conversation" | "/approvals";
      params: { channelId: string; requestId?: string };
    }
  | { pathname: "/needs-you"; params: Record<string, never> }
  | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("url" in value) ||
    typeof value.url !== "string"
  )
    return null;
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    return null;
  }
  if (
    url.protocol !== "openbotmobile:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    (url.pathname && url.pathname !== "/")
  )
    return null;
  if (url.hostname === "needs-you")
    return url.search ? null : { pathname: "/needs-you", params: {} };
  if (url.hostname !== "conversation" && url.hostname !== "approvals")
    return null;
  const channelId = url.searchParams.get("channelId");
  const requestId = url.searchParams.get("requestId");
  if (!channelId || channelId.length > 200 || (requestId?.length ?? 0) > 200)
    return null;
  return {
    pathname: url.hostname === "conversation" ? "/conversation" : "/approvals",
    params: { channelId, ...(requestId ? { requestId } : {}) },
  };
}

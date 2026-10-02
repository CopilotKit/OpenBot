export function notificationDestination(value: unknown): {
  pathname: "/conversation" | "/approvals";
  params: { channelId: string; requestId?: string };
} | null {
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

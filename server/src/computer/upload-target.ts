const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WorkspaceUploadTarget = {
  id: "netsfera-erp";
  origin: string;
  bearerToken: string;
  pathFor(transferId: string): string;
};

/** Derive the binary endpoint from the already-configured ERP MCP connection and principal. */
export function workspaceUploadTargetFromMcp(
  mcpUrl: string,
  bearerToken: string | undefined,
): WorkspaceUploadTarget {
  const url = new URL(mcpUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname.replace(/\/+$/, "") !== "/api/mcp" ||
    url.search ||
    url.hash ||
    !bearerToken?.trim()
  ) {
    throw new Error(
      "The ERP connector is not a safe authenticated MCP endpoint.",
    );
  }
  return {
    id: "netsfera-erp",
    origin: url.origin,
    bearerToken: bearerToken.trim(),
    pathFor(transferId) {
      if (!UUID.test(transferId)) throw new Error("Invalid transfer id.");
      return `/api/agent-transfers/${transferId}`;
    },
  };
}

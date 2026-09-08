import { readFile, stat } from "node:fs/promises";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WorkspaceUploadTarget = {
  id: "netsfera-erp";
  origin: string;
  bearerToken: string;
  pathFor(transferId: string): string;
};

export function parseWorkspaceUploadTarget(
  origin: string,
  bearerToken: string,
): WorkspaceUploadTarget {
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !bearerToken.trim()
  ) {
    throw new Error("The workspace upload target is not a safe HTTPS origin.");
  }
  const fixedOrigin = url.origin;
  return {
    id: "netsfera-erp",
    origin: fixedOrigin,
    bearerToken: bearerToken.trim(),
    pathFor(transferId) {
      if (!UUID.test(transferId)) throw new Error("Invalid transfer id.");
      return `/api/agent-transfers/${transferId}`;
    },
  };
}

export async function loadWorkspaceUploadTarget(input: {
  origin: string;
  tokenFile: string;
}): Promise<WorkspaceUploadTarget> {
  const details = await stat(input.tokenFile);
  if (!details.isFile() || (details.mode & 0o077) !== 0) {
    throw new Error(
      "WORKSPACE_TRANSFER_NETSFERA_ERP_TOKEN_FILE must be a regular file readable only by its owner.",
    );
  }
  return parseWorkspaceUploadTarget(
    input.origin,
    await readFile(input.tokenFile, "utf8"),
  );
}

export const HOST_ACCESS_DESKTOP_LEASE_MS = 15_000;

export type HostAccessOperationKind =
  | "choose_folder"
  | "list_files"
  | "read_file"
  | "write_file"
  | "run_command"
  | "cancel"
  | "stop";

export type HostAccessGrant = {
  id: string;
  botId: string;
  actorId: string;
  displayName: string;
  revoked: boolean;
};

export type HostAccessDesktopOperation = {
  operationId: string;
  targetOperationId?: string;
  kind: HostAccessOperationKind;
  botId: string;
  actorId: string;
  grantId?: string;
  botName?: string;
  relativePath?: string;
  content?: string;
  command?: string;
  writable?: boolean;
  /** For a command: the member's policy after the team cap, so the native dialog can say so. */
  commandPolicy?: "ask" | "allow" | "never";
  expiresAt?: number;
};

export type HostAccessDesktopResult = {
  operationId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  grant?: {
    grantId: string;
    displayName: string;
  };
};

export type HostAccessDesktopPollResponse = {
  operations: HostAccessDesktopOperation[];
  leaseMs: number;
};

export type HostAccessStatus = {
  grants: HostAccessGrant[];
  pending: HostAccessDesktopOperation[];
  connected: boolean;
};

/**
 * What `GET /api/host-access` answers: the broker's status, and whether this OpenBot has a desktop
 * host at all. Only OpenBot Desktop gives the server one (`OPENBOT_DESKTOP_HOST_TOKEN`), so a server
 * started any other way can never reach a folder, and the page says so instead of waiting for it.
 */
export type HostAccessRouteStatus = HostAccessStatus & { desktop: boolean };

export function asHostAccessDesktopResult(
  value: unknown,
): HostAccessDesktopResult | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Partial<HostAccessDesktopResult>;
  if (typeof result.operationId !== "string" || !result.operationId)
    return null;
  if (typeof result.ok !== "boolean") return null;
  if (!result.ok) {
    return {
      operationId: result.operationId,
      ok: false,
      error:
        typeof result.error === "string" && result.error.trim()
          ? result.error
          : "The native host operation failed.",
    };
  }
  const grant = result.grant;
  return {
    operationId: result.operationId,
    ok: true,
    ...("result" in result ? { result: result.result } : {}),
    ...(grant &&
    typeof grant === "object" &&
    typeof grant.grantId === "string" &&
    grant.grantId &&
    typeof grant.displayName === "string" &&
    grant.displayName
      ? {
          grant: {
            grantId: grant.grantId,
            displayName: grant.displayName,
          },
        }
      : {}),
  };
}

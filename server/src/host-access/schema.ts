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
    writable?: boolean;
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
            writable: grant.writable === true,
          },
        }
      : {}),
  };
}

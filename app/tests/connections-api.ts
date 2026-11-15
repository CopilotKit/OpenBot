/**
 * A person's connections to apps, and an app's one shared account, as the API answers them, for app
 * tests that fake the server while driving real components.
 *
 * The screens read a connection in the shape `lib/plugins/queries.ts` maps it to; a test states the
 * row that way (`TodayConnection`) and these builders answer it at the API's addresses in the API's
 * shape, so a test reads like the screen and the wire is the contract's.
 */

const NativeResponse = globalThis.Response;

const ORGANIZATION = "/api/v2/organizations/default";
export const MY_CONNECTIONS_PATH = `${ORGANIZATION}/people/me/connections`;

/** A person's own connection to an app, or one act on it (`connect`, `confirm`, ...). */
export function myConnectionPath(appId: string, action?: string): string {
  return `${MY_CONNECTIONS_PATH}/${encodeURIComponent(appId)}${action ? `/${action}` : ""}`;
}

/** One of the person's accounts at an app, and an act on it (`make-default`, `disconnect`). */
export function myAccountPath(
  appId: string,
  accountId: string,
  action: "make-default" | "disconnect",
): string {
  return `${myConnectionPath(appId, "accounts")}/${encodeURIComponent(accountId)}/${action}`;
}

/** An app's one shared account, or one act on it. */
export function sharedConnectionPath(appId: string, action?: string): string {
  return `${ORGANIZATION}/apps/${encodeURIComponent(appId)}/shared-connection${action ? `/${action}` : ""}`;
}

export type ConnectionsOperation =
  | "list"
  | "get"
  | "connect"
  | "confirm"
  | "recheck"
  | "disconnect"
  | "disconnect-preview"
  | "authorizations"
  | "authorize"
  | "accounts"
  | "make-default"
  | "disconnect-account";

/** Which connections operation a request is, read off its address and method. */
export type ConnectionsCall = {
  operation: ConnectionsOperation;
  /** The app, decoded. Absent on the list. */
  appId?: string;
  accountId?: string;
  /** Whether the address is the app's shared account rather than the person's own. */
  shared: boolean;
  method: string;
  /** The JSON body, parsed, or null. */
  body: Record<string, unknown> | null;
};

const PERSON =
  /^\/api\/v2\/organizations\/default\/people\/me\/connections(?:\/([^/]+)(?:\/(accounts)(?:\/([^/]+)\/(make-default|disconnect))?|\/([a-z-]+))?)?$/;
const SHARED =
  /^\/api\/v2\/organizations\/default\/apps\/([^/]+)\/shared-connection(?:\/([a-z-]+))?$/;

export function connectionsCall(
  input: RequestInfo | URL,
  init?: RequestInit,
): ConnectionsCall | null {
  const url = new URL(
    typeof input === "string" ? input : String(input),
    "http://openbot.test",
  );
  const method = (init?.method ?? "GET").toUpperCase();
  const body =
    typeof init?.body === "string"
      ? (JSON.parse(init.body) as Record<string, unknown>)
      : null;
  const person = PERSON.exec(url.pathname);
  if (person) {
    const [, app, accounts, accountId, accountAction, action] = person;
    const appId = app ? decodeURIComponent(app) : undefined;
    const operation: ConnectionsOperation | undefined = !appId
      ? "list"
      : accountAction === "make-default"
        ? "make-default"
        : accountAction === "disconnect"
          ? "disconnect-account"
          : accounts
            ? "accounts"
            : ((action ?? "get") as ConnectionsOperation);
    return {
      operation,
      ...(appId ? { appId } : {}),
      ...(accountId ? { accountId: decodeURIComponent(accountId) } : {}),
      shared: false,
      method,
      body,
    };
  }
  const shared = SHARED.exec(url.pathname);
  if (shared) {
    const [, app, action] = shared;
    return {
      operation: (action ?? "get") as ConnectionsOperation,
      appId: decodeURIComponent(app ?? ""),
      shared: true,
      method,
      body,
    };
  }
  return null;
}

/** A connection as the screens read it: today's row, which these builders answer in the API's shape. */
export type TodayConnection = {
  serverId: string;
  scope?: string;
  connectedAt?: string;
  revoked?: boolean;
  verified?: boolean;
  verifiedAt?: string | null;
  probe?: string | null;
  checkable?: boolean;
  canAddAccount?: boolean;
};

export function connectionBody(row: TodayConnection) {
  // A row that says nothing about a check is one OpenBot keeps the sign-in for itself.
  const checked =
    row.verified !== undefined ||
    row.probe !== undefined ||
    row.checkable !== undefined;
  return {
    appId: row.serverId,
    connectedAt: row.connectedAt ?? "2026-11-01T09:00:00.000Z",
    revoked: row.revoked === true,
    scope: checked ? null : (row.scope ?? ""),
    check: checked
      ? {
          verified: row.verified === true,
          verifiedAt: row.verifiedAt ?? null,
          checkedAction: row.probe ?? null,
          checkable: row.checkable === true,
        }
      : null,
    canAddAccount: row.canAddAccount === true,
  };
}

/** One page of a person's connections. */
export function connectionPage(
  rows: readonly TodayConnection[],
  nextCursor: string | null = null,
): Response {
  return NativeResponse.json({
    connections: rows.map(connectionBody),
    nextCursor,
  });
}

/** One of a person's connections. */
export function connectionResponse(row: TodayConnection): Response {
  return NativeResponse.json(connectionBody(row));
}

/** An app's one shared account, connected or not. */
export function sharedConnectionResponse(shared: {
  appId: string;
  connected: boolean;
  connectedAt?: string | null;
  connectedBy?: string | null;
  displayName?: string | null;
  verified?: boolean;
  verifiedAt?: string | null;
  probe?: string | null;
  checkable?: boolean;
}): Response {
  return NativeResponse.json({
    appId: shared.appId,
    connected: shared.connected,
    connectedAt: shared.connected
      ? (shared.connectedAt ?? "2026-11-01T09:00:00.000Z")
      : null,
    connectedBy: shared.connectedBy ?? null,
    accountName: shared.displayName ?? null,
    check: shared.connected
      ? {
          verified: shared.verified === true,
          verifiedAt: shared.verifiedAt ?? null,
          checkedAction: shared.probe ?? null,
          checkable: shared.checkable === true,
        }
      : null,
  });
}

/** What a press of Connect answers, from what today's screens read off it. */
export function startResponse(
  start:
    | { authorizationUrl: string }
    | {
        fields: readonly {
          name: string;
          label: string;
          help: string;
          required: boolean;
          secret: boolean;
          default?: string;
        }[];
        guide?: { steps: string; url: string | null } | null;
      }
    | { connected: true; verified?: boolean; probe?: string | null },
): Response {
  if ("authorizationUrl" in start)
    return NativeResponse.json({
      next: "consent",
      authorizationUrl: start.authorizationUrl,
    });
  if ("fields" in start)
    return NativeResponse.json({
      next: "form",
      fields: start.fields.map((field) => ({
        ...field,
        default: field.default ?? null,
      })),
      guide: start.guide ?? null,
    });
  return NativeResponse.json({
    next: "connected",
    verified: start.verified ?? null,
    checkedAction: start.probe ?? null,
  });
}

export function confirmationResponse(connected: boolean): Response {
  return NativeResponse.json({ connected });
}

export function checkResponse(check: {
  verified: boolean;
  verifiedAt: string | null;
  probe: string | null;
}): Response {
  return NativeResponse.json({
    verified: check.verified,
    verifiedAt: check.verifiedAt,
    checkedAction: check.probe,
  });
}

export function disconnectionResponse(revocationRequested = true): Response {
  return NativeResponse.json({ revocationRequested });
}

export function disconnectPreviewResponse(preview: {
  siblings: readonly string[];
  unanswered: number;
}): Response {
  return NativeResponse.json({
    alsoEnds: preview.siblings,
    uncheckedCount: preview.unanswered,
  });
}

/** What an account allows, action by action, or that the app couldn't be asked. */
export function authorizationsResponse(
  actions: readonly unknown[] | { unreadable: string },
): Response {
  return NativeResponse.json(
    Array.isArray(actions)
      ? { readable: true, reason: null, actions }
      : {
          readable: false,
          reason: (actions as { unreadable: string }).unreadable,
          actions: [],
        },
  );
}

export function authorizationStartResponse(authorizationUrl: string): Response {
  return NativeResponse.json({ authorizationUrl });
}

/** One page of a person's accounts at an app. */
export function accountsPage(
  accounts: readonly {
    id: string;
    identity: string | null;
    label: string;
    isDefault: boolean;
    connectedAt: string | null;
  }[],
  nextCursor: string | null = null,
): Response {
  return NativeResponse.json({ accounts, nextCursor });
}

export function accountDisconnectionResponse(remaining: number): Response {
  return NativeResponse.json({
    remaining,
    connectionEnded: remaining === 0,
    revocationRequested: true,
  });
}

/** A refusal, as problem details carry it. */
export function connectionsProblem(
  status: number,
  detail: string,
  code = status === 404
    ? "NOT_FOUND"
    : status === 409
      ? "CONFLICT"
      : status === 403
        ? "PERMISSION_DENIED"
        : status === 502
          ? "APP_SERVICE_FAILED"
          : status === 503
            ? "CONNECTIONS_UNAVAILABLE"
            : status >= 500
              ? "INTERNAL_SERVER_ERROR"
              : "VALIDATION_ERROR",
): Response {
  return new NativeResponse(
    JSON.stringify({
      type: `https://open.bot/errors/${code.toLowerCase().replaceAll("_", "-")}`,
      title: detail,
      status,
      detail,
      code,
      category: "validation",
      retryable: false,
      requestId: "req_test",
      traceId: "trace_test",
    }),
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

/**
 * Intelligence's organization policy, as OpenBot calls it: every capability switch, enterprise
 * setting, network rule, the computer-action boundary, approval preferences and rules, and every
 * approval for a Bot to use a Shared app is read and written here, under this deployment's project
 * key. The contract is Intelligence's `docs/contracts/organization-policy.md`.
 *
 * Every write carries an `Idempotency-Key`, and a write that fails on the way (the connection drops,
 * Intelligence answers 5xx) is retried with the same key, so a retry after a lost response is the
 * same write rather than a second one. Nothing here holds a database connection: a caller must never
 * call this with an OpenBot transaction open.
 */
import type {
  ActionBoundary,
  ActionBoundaryRecord,
  ApprovalPreferencesPatch,
  ApprovalPreferencesRecord,
  ApprovalRuleDraft,
  ApprovalRulePatch,
  ApprovalRuleRecord,
  CapabilityRuleKey,
  CapabilityRuleRecord,
  ConnectionApprovalDraft,
  ConnectionApprovalKey,
  ConnectionApprovalRecord,
  NetworkRuleKey,
  NetworkRuleRecord,
  PolicySettings,
  PolicySettingsPatch,
} from "./types";

export type OrgPolicySettings = {
  apiUrl: string;
  apiKey: string;
  /** For tests that need to observe or stub the transport. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
};

/**
 * Intelligence refused or could not answer. `message` is what a person reads when a screen shows the
 * failure (admin routes and Settings answer with it); `detail` is what happened, for the log.
 * `code` is the policy error code when Intelligence sent one.
 */
export class PolicyError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
    readonly detail: string = message,
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

/** What to log about a failure: a policy error's detail, or the error's own message. */
export function policyFailure(error: unknown): string {
  if (error instanceof PolicyError) return error.detail;
  return error instanceof Error ? error.message : String(error);
}

/** The record changed since it was read, or (for a fill) somebody stored one first. */
export class PolicyVersionConflictError extends PolicyError {
  constructor(what: string) {
    super(
      "Someone else changed this at the same time. Reload the page and try again.",
      412,
      "POLICY_VERSION_CONFLICT",
      `${what} changed since it was read.`,
    );
    this.name = "PolicyVersionConflictError";
  }
}

/** No such record in Intelligence. */
export class PolicyNotFoundError extends PolicyError {
  constructor(what: string) {
    super(
      "That setting no longer exists. Reload the page.",
      404,
      "POLICY_NOT_FOUND",
      `${what} is not in Intelligence.`,
    );
    this.name = "PolicyNotFoundError";
  }
}

/** An approval rule with this id already exists, revoked or not. */
export class PolicyAlreadyExistsError extends PolicyError {
  constructor(what: string) {
    super(
      "That rule already exists.",
      409,
      "POLICY_ALREADY_EXISTS",
      `${what} already exists.`,
    );
    this.name = "PolicyAlreadyExistsError";
  }
}

/** The approval rule is revoked, so it cannot be changed. */
export class PolicyRuleRevokedError extends PolicyError {
  constructor(what: string) {
    super(
      "That rule was removed. Reload the page.",
      409,
      "POLICY_RULE_REVOKED",
      `${what} is revoked.`,
    );
    this.name = "PolicyRuleRevokedError";
  }
}

/** What a person reads when a read or a write did not go through. */
const READS = new Set(["read", "list", "subscribe to"]);
function sentenceFor(action: string, status: number | null): string {
  if (READS.has(action))
    return "Couldn't load these settings. Reload the page.";
  if (status !== null && status >= 400 && status < 500)
    return "That change wasn't saved. Check it and try again.";
  return "Couldn't save that change. Try again in a moment.";
}

/** A conditional write: only this version, or only while nothing is stored. */
export type Precondition = { ifMatch?: number; ifNoneMatch?: true };

export type PolicyPage<T> = {
  items: T[];
  nextCursor: string | null;
  joinCode: string | null;
};

export type OrgPolicyClient = ReturnType<typeof createOrgPolicyClient>;

const ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE = 500;

/** A fresh key for one logical write. Retries of that write reuse it. */
export function policyIdempotencyKey(operation: string): string {
  return `openbot:policy:${operation}:${crypto.randomUUID()}`;
}

const enc = encodeURIComponent;

export function capabilityRulePath(key: CapabilityRuleKey): string {
  return key.scopeKind === "organization"
    ? `/api/policy/capability-rules/organization/${enc(key.capability)}`
    : `/api/policy/capability-rules/${key.scopeKind}/${enc(key.scopeId)}/${enc(key.capability)}`;
}

export function networkRulePath(key: NetworkRuleKey): string {
  return key.scopeKind === "organization"
    ? "/api/policy/network-rules/organization"
    : `/api/policy/network-rules/group/${enc(key.scopeId)}`;
}

export function connectionApprovalPath(key: ConnectionApprovalKey): string {
  return `/api/policy/connection-approvals/${enc(key.agentId)}/${enc(key.connectionId)}`;
}

export function createOrgPolicyClient(settings: OrgPolicySettings) {
  const base = settings.apiUrl.replace(/\/+$/, "");
  const send = settings.fetch ?? fetch;

  async function request(
    method: string,
    path: string,
    options: {
      body?: unknown;
      idempotencyKey?: string;
      precondition?: Precondition;
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${settings.apiKey}`,
      accept: "application/json",
    };
    if (options.body !== undefined)
      headers["content-type"] = "application/json";
    if (options.idempotencyKey)
      headers["idempotency-key"] = options.idempotencyKey;
    if (options.precondition?.ifMatch !== undefined)
      headers["if-match"] = `"${options.precondition.ifMatch}"`;
    if (options.precondition?.ifNoneMatch) headers["if-none-match"] = "*";
    let lastError: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const response = await send(`${base}${path}`, {
          method,
          headers,
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        // A 5xx is Intelligence failing, not refusing: the same write under the same key is safe to
        // send again, and a read is safe to repeat.
        if (response.status >= 500 && attempt < ATTEMPTS) {
          lastError = new PolicyError(
            sentenceFor(method === "GET" ? "read" : "save", null),
            response.status,
            await errorCode(response),
            `Intelligence answered ${response.status} to ${method} ${path}.`,
          );
          await pause(attempt);
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt < ATTEMPTS) await pause(attempt);
      }
    }
    if (lastError instanceof PolicyError) throw lastError;
    throw new PolicyError(
      sentenceFor(method === "GET" ? "read" : "save", null),
      null,
      null,
      `Could not reach Intelligence for ${method} ${path}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  async function refusal(
    response: Response,
    what: string,
    action: string,
  ): Promise<never> {
    const code = await errorCode(response);
    if (response.status === 404) throw new PolicyNotFoundError(what);
    if (response.status === 412) throw new PolicyVersionConflictError(what);
    if (code === "POLICY_ALREADY_EXISTS")
      throw new PolicyAlreadyExistsError(what);
    if (code === "POLICY_RULE_REVOKED") throw new PolicyRuleRevokedError(what);
    throw new PolicyError(
      sentenceFor(action, response.status),
      response.status,
      code,
      `Intelligence refused to ${action} ${what}: ${response.status}${code ? ` ${code}` : ""}.`,
    );
  }

  /** A read or write that answers one record: 200 or 201 with it, or a refusal. */
  async function one<T>(
    method: string,
    path: string,
    what: string,
    action: string,
    options: Parameters<typeof request>[2] = {},
  ): Promise<T> {
    const response = await request(method, path, options);
    if (response.status !== 200 && response.status !== 201)
      return refusal(response, what, action);
    return (await response.json()) as T;
  }

  /** A read that answers one record, or null when Intelligence has none under that key. */
  async function maybe<T>(path: string, what: string): Promise<T | null> {
    const response = await request("GET", path);
    if (response.status === 404) return null;
    if (response.status !== 200) return refusal(response, what, "read");
    return (await response.json()) as T;
  }

  /** A delete answered with 204. True when this call removed it, false when nothing was stored. */
  async function removed(
    path: string,
    what: string,
    key: string,
    precondition?: Precondition,
  ): Promise<boolean> {
    const response = await request("DELETE", path, {
      idempotencyKey: key,
      ...(precondition ? { precondition } : {}),
    });
    if (response.status === 404) return false;
    if (response.status !== 204) return refusal(response, what, "delete");
    return true;
  }

  /** Every item of a collection, walking every page. There is no cap: the cursor decides the end. */
  async function all<T>(
    path: string,
    filter: Record<string, string> = {},
  ): Promise<{ items: T[]; joinCode: string | null }> {
    const items: T[] = [];
    let cursor: string | null = null;
    let joinCode: string | null = null;
    do {
      const query = new URLSearchParams({ ...filter, limit: String(PAGE) });
      if (cursor) query.set("cursor", cursor);
      const response = await request("GET", `${path}?${query}`);
      if (response.status !== 200) return refusal(response, path, "list");
      const page = (await response.json()) as PolicyPage<T>;
      items.push(...page.items);
      joinCode = page.joinCode ?? joinCode;
      cursor = page.nextCursor;
    } while (cursor);
    return { items, joinCode };
  }

  return {
    settings: () =>
      one<PolicySettings>(
        "GET",
        "/api/policy/settings",
        "the settings",
        "read",
      ),
    patchSettings: (
      patch: PolicySettingsPatch,
      key: string,
      precondition?: Precondition,
    ) =>
      one<PolicySettings>(
        "PATCH",
        "/api/policy/settings",
        "the settings",
        "change",
        {
          body: patch,
          idempotencyKey: key,
          ...(precondition ? { precondition } : {}),
        },
      ),
    resetSettings: (key: string) =>
      one<PolicySettings>(
        "DELETE",
        "/api/policy/settings",
        "the settings",
        "reset",
        { idempotencyKey: key },
      ),

    actionBoundary: () =>
      one<ActionBoundaryRecord>(
        "GET",
        "/api/policy/action-boundary",
        "the action boundary",
        "read",
      ),
    putActionBoundary: (
      boundary: ActionBoundary | null,
      updatedBy: string | null,
      key: string,
      precondition?: Precondition,
    ) =>
      one<ActionBoundaryRecord>(
        "PUT",
        "/api/policy/action-boundary",
        "the action boundary",
        "save",
        {
          body: { boundary, ...(updatedBy ? { updatedBy } : {}) },
          idempotencyKey: key,
          ...(precondition ? { precondition } : {}),
        },
      ),
    resetActionBoundary: (key: string) =>
      one<ActionBoundaryRecord>(
        "DELETE",
        "/api/policy/action-boundary",
        "the action boundary",
        "reset",
        { idempotencyKey: key },
      ),

    capabilityRules: (filter: { scopeKind?: string } = {}) =>
      all<CapabilityRuleRecord>("/api/policy/capability-rules", filter),
    capabilityRule: (key: CapabilityRuleKey) =>
      maybe<CapabilityRuleRecord>(capabilityRulePath(key), "capability rule"),
    putCapabilityRule: (
      key: CapabilityRuleKey,
      allowed: boolean,
      updatedBy: string | null,
      idempotencyKey: string,
      precondition?: Precondition,
    ) =>
      one<CapabilityRuleRecord>(
        "PUT",
        capabilityRulePath(key),
        "capability rule",
        "save",
        {
          body: { allowed, ...(updatedBy ? { updatedBy } : {}) },
          idempotencyKey,
          ...(precondition ? { precondition } : {}),
        },
      ),
    deleteCapabilityRule: (key: CapabilityRuleKey, idempotencyKey: string) =>
      removed(capabilityRulePath(key), "capability rule", idempotencyKey),

    networkRules: (filter: { scopeKind?: string } = {}) =>
      all<NetworkRuleRecord>("/api/policy/network-rules", filter),
    networkRule: (key: NetworkRuleKey) =>
      maybe<NetworkRuleRecord>(networkRulePath(key), "network rule"),
    putNetworkRule: (
      key: NetworkRuleKey,
      rule: Pick<NetworkRuleRecord, "mode" | "rules" | "locked">,
      updatedBy: string | null,
      idempotencyKey: string,
      precondition?: Precondition,
    ) =>
      one<NetworkRuleRecord>(
        "PUT",
        networkRulePath(key),
        "network rule",
        "save",
        {
          body: { ...rule, ...(updatedBy ? { updatedBy } : {}) },
          idempotencyKey,
          ...(precondition ? { precondition } : {}),
        },
      ),
    deleteNetworkRule: (key: NetworkRuleKey, idempotencyKey: string) =>
      removed(networkRulePath(key), "network rule", idempotencyKey),

    approvalPreferencesList: () =>
      all<ApprovalPreferencesRecord>("/api/policy/approval-preferences"),
    approvalPreferences: (userId: string) =>
      one<ApprovalPreferencesRecord>(
        "GET",
        `/api/policy/approval-preferences/${enc(userId)}`,
        "approval preferences",
        "read",
      ),
    patchApprovalPreferences: (
      userId: string,
      patch: ApprovalPreferencesPatch,
      idempotencyKey: string,
      precondition?: Precondition,
    ) =>
      one<ApprovalPreferencesRecord>(
        "PATCH",
        `/api/policy/approval-preferences/${enc(userId)}`,
        "approval preferences",
        "change",
        {
          body: patch,
          idempotencyKey,
          ...(precondition ? { precondition } : {}),
        },
      ),
    deleteApprovalPreferences: (userId: string, idempotencyKey: string) =>
      removed(
        `/api/policy/approval-preferences/${enc(userId)}`,
        "approval preferences",
        idempotencyKey,
      ),

    approvalRules: (
      filter: {
        ownerUserId?: string;
        team?: boolean;
        includeRevoked?: boolean;
      } = {},
    ) =>
      all<ApprovalRuleRecord>("/api/policy/approval-rules", {
        ...(filter.ownerUserId ? { ownerUserId: filter.ownerUserId } : {}),
        ...(filter.team ? { team: "true" } : {}),
        ...(filter.includeRevoked ? { includeRevoked: "true" } : {}),
      }),
    approvalRule: (id: string) =>
      maybe<ApprovalRuleRecord>(
        `/api/policy/approval-rules/${enc(id)}`,
        `approval rule ${id}`,
      ),
    createApprovalRule: (draft: ApprovalRuleDraft, idempotencyKey: string) =>
      one<ApprovalRuleRecord>(
        "POST",
        "/api/policy/approval-rules",
        `approval rule ${draft.id}`,
        "create",
        { body: draft, idempotencyKey },
      ),
    patchApprovalRule: (
      id: string,
      patch: ApprovalRulePatch,
      idempotencyKey: string,
      precondition?: Precondition,
    ) =>
      one<ApprovalRuleRecord>(
        "PATCH",
        `/api/policy/approval-rules/${enc(id)}`,
        `approval rule ${id}`,
        "change",
        {
          body: patch,
          idempotencyKey,
          ...(precondition ? { precondition } : {}),
        },
      ),
    revokeApprovalRule: (id: string, idempotencyKey: string) =>
      one<ApprovalRuleRecord>(
        "DELETE",
        `/api/policy/approval-rules/${enc(id)}`,
        `approval rule ${id}`,
        "revoke",
        { idempotencyKey },
      ),

    connectionApprovals: (
      filter: {
        agentId?: string;
        connectionId?: string;
        approvedAs?: "admin" | "owner";
      } = {},
    ) =>
      all<ConnectionApprovalRecord>(
        "/api/policy/connection-approvals",
        Object.fromEntries(
          Object.entries(filter).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
      ),
    connectionApproval: (key: ConnectionApprovalKey) =>
      maybe<ConnectionApprovalRecord>(
        connectionApprovalPath(key),
        "connection approval",
      ),
    putConnectionApproval: (
      key: ConnectionApprovalKey,
      draft: ConnectionApprovalDraft,
      idempotencyKey: string,
      precondition?: Precondition,
    ) =>
      one<ConnectionApprovalRecord>(
        "PUT",
        connectionApprovalPath(key),
        `the approval for ${key.agentId} at ${key.connectionId}`,
        "save",
        {
          body: draft,
          idempotencyKey,
          ...(precondition ? { precondition } : {}),
        },
      ),
    deleteConnectionApproval: (
      key: ConnectionApprovalKey,
      idempotencyKey: string,
      precondition?: Precondition,
    ) =>
      removed(
        connectionApprovalPath(key),
        `the approval for ${key.agentId} at ${key.connectionId}`,
        idempotencyKey,
        precondition,
      ),

    /** Credentials for the realtime topic that announces every change to this project's policy. */
    async subscribe(): Promise<{ joinToken: string; joinCode: string }> {
      const response = await request("POST", "/api/policy/subscribe", {
        body: {},
      });
      if (response.status !== 200)
        return refusal(response, "policy events", "subscribe to");
      return (await response.json()) as { joinToken: string; joinCode: string };
    },
  };
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as {
      error?: { code?: unknown };
    };
    return typeof body.error?.code === "string" ? body.error.code : null;
  } catch {
    return null;
  }
}

function pause(attempt: number) {
  return new Promise((resolve) => setTimeout(resolve, 150 * attempt * attempt));
}

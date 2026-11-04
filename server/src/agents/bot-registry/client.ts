/**
 * Intelligence's agent registry, as OpenBot calls it: every Bot is created, read, changed and deleted
 * here, under this deployment's project key. The contract is Intelligence's
 * `docs/contracts/agent-registry.md`.
 *
 * Every write carries an `Idempotency-Key`, and a write that fails on the way (the connection drops,
 * Intelligence answers 5xx) is retried with the same key, so a retry after a lost response is the
 * same write rather than a second one. Nothing here holds a database connection: a caller must never
 * call this with an OpenBot transaction open.
 */
import type { Bot, BotChanges, BotDraft, BotType } from "./types";

export type AgentRegistrySettings = {
  apiUrl: string;
  apiKey: string;
  /** For tests that need to observe or stub the transport. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
};

/** Intelligence refused or could not answer. `code` is the registry's error code when it sent one. */
export class BotRegistryError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "BotRegistryError";
  }
}

/** The Bot changed since it was read: somebody else saved first. Read it again and redo the change. */
export class BotVersionConflictError extends BotRegistryError {
  constructor(id: string) {
    super(
      `Bot ${id} changed since it was read.`,
      412,
      "AGENT_VERSION_CONFLICT",
    );
    this.name = "BotVersionConflictError";
  }
}

/** A Bot with this id already exists in Intelligence, live or deleted. */
export class BotAlreadyExistsError extends BotRegistryError {
  constructor(id: string) {
    super(`Bot ${id} already exists.`, 409, "AGENT_ALREADY_EXISTS");
    this.name = "BotAlreadyExistsError";
  }
}

/** No such Bot in Intelligence: never created, or deleted for good. */
export class BotMissingError extends BotRegistryError {
  constructor(id: string) {
    super(`Bot ${id} is not in Intelligence.`, 404, "AGENT_NOT_FOUND");
    this.name = "BotMissingError";
  }
}

/** The Bot is deleted, so it cannot be changed until it is restored. */
export class BotDeletedError extends BotRegistryError {
  constructor(id: string) {
    super(`Bot ${id} is deleted.`, 409, "AGENT_DELETED");
    this.name = "BotDeletedError";
  }
}

/** How the registry writes an agent on the wire. */
type WireAgent = {
  id: string;
  kind: BotType;
  createdAt: string;
  version: number;
  updatedAt: string;
  deletedAt: string | null;
  name: string;
  title: string;
  description: string;
  avatar: string | null;
  model: string | null;
  visibility: "public" | "private";
  ownerUserId: string | null;
  managedBy: string | null;
  isolated: boolean;
  callbackTokenHash: string | null;
  callbackTokenIssuedAt: string | null;
  configuration: Record<string, unknown>;
};

export type BotPage = {
  bots: Bot[];
  nextCursor: string | null;
  joinCode: string | null;
};

export type BotListFilter = {
  includeDeleted?: boolean;
  ownerUserId?: string;
  packageId?: string;
  callbackTokenHash?: string;
};

export type AgentRegistryClient = ReturnType<typeof createAgentRegistryClient>;

const ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;

/** A fresh key for one logical write. Retries of that write reuse it. */
export function idempotencyKey(operation: string): string {
  return `openbot:${operation}:${crypto.randomUUID()}`;
}

export function createAgentRegistryClient(settings: AgentRegistrySettings) {
  const base = settings.apiUrl.replace(/\/+$/, "");
  const send = settings.fetch ?? fetch;

  async function request(
    method: string,
    path: string,
    options: {
      body?: unknown;
      idempotencyKey?: string;
      ifMatch?: number;
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
    if (options.ifMatch !== undefined)
      headers["if-match"] = `"${options.ifMatch}"`;
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
          lastError = new BotRegistryError(
            `Intelligence answered ${response.status} to ${method} ${path}.`,
            response.status,
            await errorCode(response),
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
    if (lastError instanceof BotRegistryError) throw lastError;
    throw new BotRegistryError(
      `Could not reach Intelligence for ${method} ${path}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      null,
      null,
    );
  }

  async function agentFrom(response: Response): Promise<Bot> {
    return botFromWire((await response.json()) as WireAgent);
  }

  async function refusal(
    response: Response,
    id: string,
    action: string,
  ): Promise<never> {
    const code = await errorCode(response);
    if (response.status === 404) throw new BotMissingError(id);
    if (response.status === 412) throw new BotVersionConflictError(id);
    if (code === "AGENT_ALREADY_EXISTS") throw new BotAlreadyExistsError(id);
    if (code === "AGENT_DELETED") throw new BotDeletedError(id);
    throw new BotRegistryError(
      `Intelligence refused to ${action} Bot ${id}: ${response.status}${code ? ` ${code}` : ""}.`,
      response.status,
      code,
    );
  }

  const path = (id: string) => `/api/agents/${encodeURIComponent(id)}`;

  return {
    async create(draft: BotDraft, key: string): Promise<Bot> {
      const response = await request("POST", "/api/agents", {
        body: draftToWire(draft),
        idempotencyKey: key,
      });
      if (response.status !== 201 && response.status !== 200)
        return refusal(response, draft.id, "create");
      return agentFrom(response);
    },

    /** The Bot, deleted ones included, or null when Intelligence has no such Bot. */
    async get(id: string): Promise<Bot | null> {
      const response = await request("GET", `${path(id)}?includeDeleted=true`);
      if (response.status === 404) return null;
      if (response.status !== 200) return refusal(response, id, "read");
      return agentFrom(response);
    },

    async page(
      filter: BotListFilter = {},
      cursor: string | null = null,
      limit = 100,
    ): Promise<BotPage> {
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor) query.set("cursor", cursor);
      if (filter.includeDeleted) query.set("includeDeleted", "true");
      if (filter.ownerUserId) query.set("ownerUserId", filter.ownerUserId);
      if (filter.packageId) query.set("managedBy", filter.packageId);
      if (filter.callbackTokenHash)
        query.set("callbackTokenHash", filter.callbackTokenHash);
      const response = await request("GET", `/api/agents?${query}`);
      if (response.status !== 200) return refusal(response, "*", "list");
      const body = (await response.json()) as {
        agents: WireAgent[];
        nextCursor: string | null;
        joinCode?: string | null;
      };
      return {
        bots: body.agents.map(botFromWire),
        nextCursor: body.nextCursor,
        joinCode: body.joinCode ?? null,
      };
    },

    /** Every Bot matching the filter, walking every page. There is no cap: the cursor decides the end. */
    async all(
      filter: BotListFilter = {},
    ): Promise<{ bots: Bot[]; joinCode: string | null }> {
      const bots: Bot[] = [];
      let cursor: string | null = null;
      let joinCode: string | null = null;
      do {
        const page: BotPage = await this.page(filter, cursor);
        bots.push(...page.bots);
        joinCode = page.joinCode ?? joinCode;
        cursor = page.nextCursor;
      } while (cursor);
      return { bots, joinCode };
    },

    async update(
      id: string,
      version: number,
      changes: BotChanges,
      key: string,
    ): Promise<Bot> {
      const response = await request("PATCH", path(id), {
        body: changesToWire(changes),
        ifMatch: version,
        idempotencyKey: key,
      });
      if (response.status !== 200) return refusal(response, id, "change");
      return agentFrom(response);
    },

    /** Soft delete. Deleting a Bot that is already deleted returns it unchanged. */
    async remove(id: string, key: string, version?: number): Promise<Bot> {
      // With `version`, a Bot changed since that version is refused rather than deleted.
      const response = await request("DELETE", path(id), {
        idempotencyKey: key,
        ...(version === undefined ? {} : { ifMatch: version }),
      });
      if (response.status !== 200) return refusal(response, id, "delete");
      return agentFrom(response);
    },

    async restore(id: string, key: string): Promise<Bot> {
      const response = await request("POST", `${path(id)}/restore`, {
        idempotencyKey: key,
      });
      if (response.status !== 200) return refusal(response, id, "restore");
      return agentFrom(response);
    },

    /** Delete for good. True when this call removed it, false when it was already gone. */
    async purge(id: string, key: string): Promise<boolean> {
      const response = await request("DELETE", `${path(id)}?purge=true`, {
        idempotencyKey: key,
      });
      if (response.status === 404) return false;
      if (response.status !== 204) return refusal(response, id, "purge");
      return true;
    },

    /** Credentials for the realtime topic that announces every change to this project's Bots. */
    async subscribe(): Promise<{ joinToken: string; joinCode: string }> {
      const response = await request("POST", "/api/agents/subscribe", {
        body: {},
      });
      if (response.status !== 200)
        return refusal(response, "*", "subscribe to");
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

/**
 * OpenBot's configuration names a vault row as `auth.credentialId`; the registry calls the same
 * reference `auth.credentialRef`, because to Intelligence it is a reference into somebody else's store.
 */
function configurationToWire(
  configuration: Record<string, unknown>,
): Record<string, unknown> {
  const auth = configuration.auth as
    | { header?: unknown; credentialId?: unknown }
    | undefined;
  if (!auth || typeof auth !== "object") return configuration;
  const { auth: _auth, ...rest } = configuration;
  return {
    ...rest,
    auth: { header: auth.header, credentialRef: auth.credentialId },
  };
}

function configurationFromWire(
  configuration: Record<string, unknown>,
): Record<string, unknown> {
  const auth = configuration.auth as
    | { header?: unknown; credentialRef?: unknown }
    | undefined;
  if (!auth || typeof auth !== "object") return configuration;
  const { auth: _auth, ...rest } = configuration;
  return {
    ...rest,
    auth: { header: auth.header, credentialId: auth.credentialRef },
  };
}

function botFromWire(agent: WireAgent): Bot {
  return {
    id: agent.id,
    type: agent.kind,
    name: agent.name,
    title: agent.title,
    roleDescription: agent.description,
    avatarSeed: agent.avatar ?? agent.id,
    visibility: agent.visibility,
    ownerUserId: agent.ownerUserId,
    packageId: agent.managedBy,
    isolated: agent.isolated,
    callbackTokenHash: agent.callbackTokenHash,
    callbackTokenIssuedAt: agent.callbackTokenIssuedAt
      ? new Date(agent.callbackTokenIssuedAt)
      : null,
    configuration: configurationFromWire(agent.configuration ?? {}),
    createdAt: new Date(agent.createdAt),
    updatedAt: new Date(agent.updatedAt),
    deletedAt: agent.deletedAt ? new Date(agent.deletedAt) : null,
    version: agent.version,
  };
}

function draftToWire(draft: BotDraft) {
  return {
    id: draft.id,
    kind: draft.type,
    name: draft.name,
    title: draft.title,
    description: draft.roleDescription,
    avatar: draft.avatarSeed,
    visibility: draft.visibility,
    ownerUserId: draft.ownerUserId,
    managedBy: draft.packageId,
    isolated: draft.isolated,
    configuration: configurationToWire(draft.configuration),
    ...(draft.callbackTokenHash
      ? {
          callbackTokenHash: draft.callbackTokenHash,
          callbackTokenIssuedAt: (
            draft.callbackTokenIssuedAt ?? new Date()
          ).toISOString(),
        }
      : {}),
    ...(draft.createdAt ? { createdAt: draft.createdAt.toISOString() } : {}),
    ...(draft.deletedAt ? { deletedAt: draft.deletedAt.toISOString() } : {}),
  };
}

function changesToWire(changes: BotChanges) {
  const wire: Record<string, unknown> = {};
  if (changes.type !== undefined) wire.kind = changes.type;
  if (changes.name !== undefined) wire.name = changes.name;
  if (changes.title !== undefined) wire.title = changes.title;
  if (changes.roleDescription !== undefined)
    wire.description = changes.roleDescription;
  if (changes.avatarSeed !== undefined) wire.avatar = changes.avatarSeed;
  if (changes.visibility !== undefined) wire.visibility = changes.visibility;
  if (changes.ownerUserId !== undefined) wire.ownerUserId = changes.ownerUserId;
  if (changes.packageId !== undefined) wire.managedBy = changes.packageId;
  if (changes.isolated !== undefined) wire.isolated = changes.isolated;
  if (changes.callbackTokenHash !== undefined)
    wire.callbackTokenHash = changes.callbackTokenHash;
  if (changes.callbackTokenIssuedAt !== undefined)
    wire.callbackTokenIssuedAt = changes.callbackTokenIssuedAt
      ? changes.callbackTokenIssuedAt.toISOString()
      : null;
  if (changes.configuration !== undefined)
    wire.configuration = configurationToWire(changes.configuration);
  return wire;
}

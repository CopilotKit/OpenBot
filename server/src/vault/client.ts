/**
 * Intelligence's vault and connections, as OpenBot calls them: every secret, every app (tool server)
 * the deployment added, and every connection a person or the deployment holds lives there, under
 * this deployment's project key. The contracts are Intelligence's `docs/contracts/vault.md` and
 * `docs/contracts/connections.md`.
 *
 * OpenBot's names stay OpenBot's: a secret's logical name is its `keyId` here (the vault calls it
 * `name`), the credential kinds keep their OpenBot names (`model`, `connector`, `agent`, `mcp`,
 * `mcp_oauth_client`, `mcp_user_token`), and a connection's holder is a `person` or the
 * `deployment`. This file is the one place that translates.
 */
import {
  createIntelligenceRequest,
  errorCode,
  type IntelligenceApiSettings,
  IntelligenceApiError,
  walkPages,
} from "./http";

/**
 * The vault refused because the secret is not there: never stored, or purged.
 *
 * No secret error names the secret: its message can reach an audit row or a person, and a credential
 * id is not something either is told.
 */
export class SecretMissingError extends IntelligenceApiError {
  constructor(_id: string) {
    super("The secret is not in the vault.", 404, "VAULT_SECRET_NOT_FOUND");
    this.name = "SecretMissingError";
  }
}

/** The vault refused because the secret is revoked. */
export class SecretRevokedError extends IntelligenceApiError {
  constructor(_id: string) {
    super("The secret is revoked.", 409, "VAULT_SECRET_REVOKED");
    this.name = "SecretRevokedError";
  }
}

/** The secret changed since it was read. */
export class SecretVersionConflictError extends IntelligenceApiError {
  constructor(_id: string) {
    super(
      "The secret changed since it was read.",
      412,
      "VAULT_VERSION_CONFLICT",
    );
    this.name = "SecretVersionConflictError";
  }
}

/** A live secret already holds this kind, provider, name and owner. */
export class SecretNameTakenError extends IntelligenceApiError {
  constructor(_id: string) {
    super(
      "A live secret already holds this kind, provider, name and owner.",
      409,
      "VAULT_SECRET_NAME_TAKEN",
    );
    this.name = "SecretNameTakenError";
  }
}

/** A secret with this id is already in the vault. */
export class SecretAlreadyExistsError extends IntelligenceApiError {
  constructor(_id: string) {
    super(
      "A secret with this id already exists.",
      409,
      "VAULT_SECRET_ALREADY_EXISTS",
    );
    this.name = "SecretAlreadyExistsError";
  }
}

/** A tool server or connection is not there, or changed since it was read, or already exists. */
export class ConnectionRecordMissingError extends IntelligenceApiError {
  constructor(what: string, id: string) {
    super(`${what} ${id} is not in Intelligence.`, 404, null);
    this.name = "ConnectionRecordMissingError";
  }
}
export class ConnectionRecordConflictError extends IntelligenceApiError {
  constructor(what: string, id: string, code: string | null) {
    super(`${what} ${id} changed since it was read.`, 412, code);
    this.name = "ConnectionRecordConflictError";
  }
}
export class ConnectionRecordExistsError extends IntelligenceApiError {
  constructor(what: string, id: string, code: string | null) {
    super(`${what} ${id} already exists.`, 409, code);
    this.name = "ConnectionRecordExistsError";
  }
}

/** OpenBot's credential kinds, a person's saved website login, and the hash of their sign-in password. */
export type SecretKind =
  | "model"
  | "connector"
  | "agent"
  | "mcp"
  | "mcp_oauth_client"
  | "mcp_user_token"
  | "website_login"
  | "password_hash";

const TO_VAULT_KIND: Record<SecretKind, string> = {
  model: "model_api_key",
  connector: "service_api_key",
  agent: "agent_api_key",
  mcp: "mcp_token",
  mcp_oauth_client: "oauth_client",
  mcp_user_token: "oauth_token",
  website_login: "website_login",
  password_hash: "password_hash",
};
const FROM_VAULT_KIND = Object.fromEntries(
  Object.entries(TO_VAULT_KIND).map(([openbot, vault]) => [vault, openbot]),
) as Record<string, SecretKind>;

/** A secret as OpenBot holds it: never its value. */
export type StoredSecret = {
  id: string;
  kind: SecretKind;
  provider: string;
  /** The secret's logical name (the vault's `name`): a model key's ref, a person's id, a username. */
  keyId: string;
  ownerUserId: string | null;
  metadata: Record<string, unknown>;
  /** The organization key that encrypts the value, in Intelligence. */
  encryptionKeyId: string;
  replaces: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
};

export type SecretDraft = {
  id: string;
  kind: SecretKind;
  provider: string;
  keyId: string;
  ownerUserId?: string | null;
  metadata?: Record<string, unknown>;
  plaintext: string;
  /** A live secret of the same kind, provider, name and owner to revoke in the same step. */
  replaces?: string | null;
  /** For copying an existing record. */
  createdAt?: Date;
  revokedAt?: Date | null;
};

/** Who reads a value and why: recorded by the vault with every reveal. */
export type SecretAccessor = {
  purpose: string;
  userId?: string | null;
  botId?: string | null;
};

export type RevealedSecret = { id: string; version: number; value: string };

export type SecretFilter = {
  includeRevoked?: boolean;
  kind?: SecretKind;
  provider?: string;
  keyId?: string;
  ownerUserId?: string;
};

export type SecretAccessEvent = {
  id: number;
  secretId: string;
  secretVersion: number | null;
  apiKeyId: number | null;
  accessorUserId: string | null;
  accessorAgentId: string | null;
  purpose: string;
  outcome: "revealed" | "revoked" | "not_found";
  createdAt: Date;
};

/** An app (tool server) the deployment added, with OpenBot's names for its fields. */
export type ToolServer = {
  id: string;
  title: string;
  logo: string | null;
  vendor: string;
  url: string;
  provenance: string;
  authScheme: string | null;
  credentialId: string | null;
  accountMode: "personal" | "shared" | null;
  sharedVendorUserId: string | null;
  ownerGrants: "any" | "admin" | null;
  entraScope: string | null;
  addedBy: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ToolServerDraft = Omit<
  ToolServer,
  "version" | "createdAt" | "updatedAt"
> & { createdAt?: Date };
export type ToolServerChanges = Partial<
  Omit<ToolServer, "id" | "version" | "createdAt" | "updatedAt">
>;

/** A person's own grant on an app: their OAuth token, in the vault. */
export type ServerGrant = {
  kind: "grant";
  id: string;
  serverId: string;
  userId: string;
  credentialId: string;
  scope: string;
  connectedAt: Date;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

/** An account at Composio or Arcade that an app's calls run in. */
export type BrokeredConnection = {
  kind: "brokered";
  id: string;
  provider: "composio" | "arcade";
  app: string;
  holder: "person" | "deployment";
  userId: string | null;
  vendorUserId: string;
  connectedBy: string | null;
  connectedAt: Date;
  verified: boolean;
  verifiedAt: Date | null;
  probeAction: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

/** The id a person is filed under at a broker. */
export type BrokeredIdentity = {
  kind: "identity";
  id: string;
  provider: "composio" | "arcade";
  userId: string;
  vendorUserId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type Connection = ServerGrant | BrokeredConnection | BrokeredIdentity;

export type ConnectionDraft =
  | (Omit<
      ServerGrant,
      "version" | "createdAt" | "updatedAt" | "connectedAt"
    > & {
      connectedAt?: Date;
      createdAt?: Date;
    })
  | (Omit<
      BrokeredConnection,
      "version" | "createdAt" | "updatedAt" | "connectedAt"
    > & { connectedAt?: Date; createdAt?: Date })
  | (Omit<BrokeredIdentity, "version" | "createdAt" | "updatedAt"> & {
      createdAt?: Date;
    });

export type ConnectionChanges = Partial<{
  credentialId: string;
  scope: string;
  vendorUserId: string;
  connectedBy: string | null;
  connectedAt: Date;
  verified: boolean;
  verifiedAt: Date | null;
  probeAction: string | null;
}>;

type WireSecret = {
  id: string;
  kind: string;
  provider: string;
  name: string;
  ownerUserId: string | null;
  metadata: Record<string, unknown>;
  keyId: string;
  replaces: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
};

type WireToolServer = {
  id: string;
  title: string;
  logo: string | null;
  vendor: string;
  url: string;
  source: string;
  authScheme: string | null;
  credentialRef: string | null;
  accountMode: "personal" | "shared" | null;
  sharedAccountId: string | null;
  ownerGrants: "any" | "admin" | null;
  entraScope: string | null;
  addedBy: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

type WireConnection = {
  id: string;
  kind: "tool_server_grant" | "broker_account" | "broker_identity";
  holder: "user" | "application";
  userId: string | null;
  toolServerId: string | null;
  credentialRef: string | null;
  scope: string | null;
  broker: "composio" | "arcade" | null;
  app: string | null;
  vendorUserId: string | null;
  connectedBy: string | null;
  connectedAt: string;
  verified: boolean;
  verifiedAt: string | null;
  probeAction: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

const date = (value: string) => new Date(value);
const maybeDate = (value: string | null) => (value ? new Date(value) : null);

function secretFromWire(wire: WireSecret): StoredSecret {
  const kind = FROM_VAULT_KIND[wire.kind];
  if (!kind)
    throw new Error(`The vault returned an unknown kind ${wire.kind}.`);
  return {
    id: wire.id,
    kind,
    provider: wire.provider,
    keyId: wire.name,
    ownerUserId: wire.ownerUserId,
    metadata: wire.metadata ?? {},
    encryptionKeyId: wire.keyId,
    replaces: wire.replaces,
    version: wire.version,
    createdAt: date(wire.createdAt),
    updatedAt: date(wire.updatedAt),
    revokedAt: maybeDate(wire.revokedAt),
  };
}

function toolServerFromWire(wire: WireToolServer): ToolServer {
  return {
    id: wire.id,
    title: wire.title,
    logo: wire.logo,
    vendor: wire.vendor,
    url: wire.url,
    provenance: wire.source,
    authScheme: wire.authScheme,
    credentialId: wire.credentialRef,
    accountMode: wire.accountMode,
    sharedVendorUserId: wire.sharedAccountId,
    ownerGrants: wire.ownerGrants,
    entraScope: wire.entraScope,
    addedBy: wire.addedBy,
    version: wire.version,
    createdAt: date(wire.createdAt),
    updatedAt: date(wire.updatedAt),
  };
}

function toolServerChangesToWire(changes: ToolServerChanges) {
  const wire: Record<string, unknown> = {};
  if (changes.title !== undefined) wire.title = changes.title;
  if (changes.logo !== undefined) wire.logo = changes.logo;
  if (changes.vendor !== undefined) wire.vendor = changes.vendor;
  if (changes.url !== undefined) wire.url = changes.url;
  if (changes.provenance !== undefined) wire.source = changes.provenance;
  if (changes.authScheme !== undefined) wire.authScheme = changes.authScheme;
  if (changes.credentialId !== undefined)
    wire.credentialRef = changes.credentialId;
  if (changes.accountMode !== undefined) wire.accountMode = changes.accountMode;
  if (changes.sharedVendorUserId !== undefined)
    wire.sharedAccountId = changes.sharedVendorUserId;
  if (changes.ownerGrants !== undefined) wire.ownerGrants = changes.ownerGrants;
  if (changes.entraScope !== undefined) wire.entraScope = changes.entraScope;
  if (changes.addedBy !== undefined) wire.addedBy = changes.addedBy;
  return wire;
}

function connectionFromWire(wire: WireConnection): Connection {
  const base = {
    id: wire.id,
    version: wire.version,
    createdAt: date(wire.createdAt),
    updatedAt: date(wire.updatedAt),
  };
  if (wire.kind === "tool_server_grant") {
    return {
      ...base,
      kind: "grant",
      serverId: wire.toolServerId ?? "",
      userId: wire.userId ?? "",
      credentialId: wire.credentialRef ?? "",
      scope: wire.scope ?? "",
      connectedAt: date(wire.connectedAt),
    };
  }
  if (wire.kind === "broker_identity") {
    return {
      ...base,
      kind: "identity",
      provider: wire.broker ?? "composio",
      userId: wire.userId ?? "",
      vendorUserId: wire.vendorUserId ?? "",
    };
  }
  return {
    ...base,
    kind: "brokered",
    provider: wire.broker ?? "composio",
    app: wire.app ?? "",
    holder: wire.holder === "user" ? "person" : "deployment",
    userId: wire.userId,
    vendorUserId: wire.vendorUserId ?? "",
    connectedBy: wire.connectedBy,
    connectedAt: date(wire.connectedAt),
    verified: wire.verified,
    verifiedAt: maybeDate(wire.verifiedAt),
    probeAction: wire.probeAction,
  };
}

function connectionDraftToWire(draft: ConnectionDraft) {
  const timestamps = {
    ...(draft.createdAt ? { createdAt: draft.createdAt.toISOString() } : {}),
    ...("connectedAt" in draft && draft.connectedAt
      ? { connectedAt: draft.connectedAt.toISOString() }
      : {}),
  };
  if (draft.kind === "grant") {
    return {
      id: draft.id,
      kind: "tool_server_grant",
      holder: "user",
      userId: draft.userId,
      toolServerId: draft.serverId,
      credentialRef: draft.credentialId,
      scope: draft.scope,
      ...timestamps,
    };
  }
  if (draft.kind === "identity") {
    return {
      id: draft.id,
      kind: "broker_identity",
      holder: "user",
      userId: draft.userId,
      broker: draft.provider,
      vendorUserId: draft.vendorUserId,
      ...timestamps,
    };
  }
  return {
    id: draft.id,
    kind: "broker_account",
    holder: draft.holder === "person" ? "user" : "application",
    userId: draft.holder === "person" ? draft.userId : null,
    broker: draft.provider,
    app: draft.app,
    vendorUserId: draft.vendorUserId,
    connectedBy: draft.connectedBy,
    verified: draft.verified,
    verifiedAt: draft.verifiedAt ? draft.verifiedAt.toISOString() : null,
    probeAction: draft.probeAction,
    ...timestamps,
  };
}

function connectionChangesToWire(changes: ConnectionChanges) {
  const wire: Record<string, unknown> = {};
  if (changes.credentialId !== undefined)
    wire.credentialRef = changes.credentialId;
  if (changes.scope !== undefined) wire.scope = changes.scope;
  if (changes.vendorUserId !== undefined)
    wire.vendorUserId = changes.vendorUserId;
  if (changes.connectedBy !== undefined) wire.connectedBy = changes.connectedBy;
  if (changes.connectedAt !== undefined)
    wire.connectedAt = changes.connectedAt.toISOString();
  if (changes.verified !== undefined) wire.verified = changes.verified;
  if (changes.verifiedAt !== undefined)
    wire.verifiedAt = changes.verifiedAt
      ? changes.verifiedAt.toISOString()
      : null;
  if (changes.probeAction !== undefined) wire.probeAction = changes.probeAction;
  return wire;
}

export type VaultClient = ReturnType<typeof createVaultClient>;

export function createVaultClient(settings: IntelligenceApiSettings) {
  const request = createIntelligenceRequest(settings);

  async function secretRefusal(
    response: Response,
    id: string,
    action: string,
  ): Promise<never> {
    const code = await errorCode(response);
    if (response.status === 404) throw new SecretMissingError(id);
    if (response.status === 412) throw new SecretVersionConflictError(id);
    if (code === "VAULT_SECRET_REVOKED") throw new SecretRevokedError(id);
    if (code === "VAULT_SECRET_NAME_TAKEN") throw new SecretNameTakenError(id);
    if (code === "VAULT_SECRET_ALREADY_EXISTS")
      throw new SecretAlreadyExistsError(id);
    throw new IntelligenceApiError(
      // Never the secret's id: this sentence can reach an audit row or a person.
      `Intelligence refused to ${action} a secret: ${response.status}${code ? ` ${code}` : ""}.`,
      response.status,
      code,
    );
  }

  async function recordRefusal(
    response: Response,
    what: string,
    id: string,
    action: string,
  ): Promise<never> {
    const code = await errorCode(response);
    if (response.status === 404)
      throw new ConnectionRecordMissingError(what, id);
    if (response.status === 412)
      throw new ConnectionRecordConflictError(what, id, code);
    if (code?.endsWith("_ALREADY_EXISTS"))
      throw new ConnectionRecordExistsError(what, id, code);
    throw new IntelligenceApiError(
      `Intelligence refused to ${action} ${what} ${id}: ${response.status}${code ? ` ${code}` : ""}.`,
      response.status,
      code,
    );
  }

  const secretPath = (id: string) =>
    `/api/vault/secrets/${encodeURIComponent(id)}`;
  const serverPath = (id: string) =>
    `/api/tool-servers/${encodeURIComponent(id)}`;
  const connectionPath = (id: string) =>
    `/api/connections/${encodeURIComponent(id)}`;

  const secrets = {
    async create(draft: SecretDraft, key: string): Promise<StoredSecret> {
      const response = await request("POST", "/api/vault/secrets", {
        idempotencyKey: key,
        body: {
          id: draft.id,
          kind: TO_VAULT_KIND[draft.kind],
          provider: draft.provider,
          name: draft.keyId,
          ownerUserId: draft.ownerUserId ?? null,
          metadata: draft.metadata ?? {},
          value: draft.plaintext,
          replaces: draft.replaces ?? null,
          ...(draft.createdAt
            ? { createdAt: draft.createdAt.toISOString() }
            : {}),
          ...(draft.revokedAt
            ? { revokedAt: draft.revokedAt.toISOString() }
            : {}),
        },
      });
      if (response.status !== 201 && response.status !== 200)
        return secretRefusal(response, draft.id, "store");
      return secretFromWire((await response.json()) as WireSecret);
    },

    /** The secret, revoked ones included, or null when the vault has no such secret. */
    async get(id: string): Promise<StoredSecret | null> {
      const response = await request("GET", secretPath(id));
      if (response.status === 404) return null;
      if (response.status !== 200) return secretRefusal(response, id, "read");
      return secretFromWire((await response.json()) as WireSecret);
    },

    async all(
      filter: SecretFilter = {},
    ): Promise<{ secrets: StoredSecret[]; joinCode: string | null }> {
      const { items, joinCode } = await walkPages(async (cursor) => {
        const query = new URLSearchParams({ limit: "100" });
        if (cursor) query.set("cursor", cursor);
        if (filter.includeRevoked) query.set("includeRevoked", "true");
        if (filter.kind) query.set("kind", TO_VAULT_KIND[filter.kind]);
        if (filter.provider) query.set("provider", filter.provider);
        if (filter.keyId) query.set("name", filter.keyId);
        if (filter.ownerUserId) query.set("ownerUserId", filter.ownerUserId);
        const response = await request("GET", `/api/vault/secrets?${query}`);
        if (response.status !== 200)
          return secretRefusal(response, "*", "list");
        const body = (await response.json()) as {
          secrets: WireSecret[];
          nextCursor: string | null;
          joinCode?: string | null;
        };
        return {
          items: body.secrets.map(secretFromWire),
          nextCursor: body.nextCursor,
          joinCode: body.joinCode ?? null,
        };
      });
      return { secrets: items, joinCode };
    },

    async update(
      id: string,
      version: number,
      changes: { plaintext?: string; metadata?: Record<string, unknown> },
      key: string,
    ): Promise<StoredSecret> {
      const response = await request("PATCH", secretPath(id), {
        ifMatch: version,
        idempotencyKey: key,
        body: {
          ...(changes.plaintext === undefined
            ? {}
            : { value: changes.plaintext }),
          ...(changes.metadata === undefined
            ? {}
            : { metadata: changes.metadata }),
        },
      });
      if (response.status !== 200) return secretRefusal(response, id, "change");
      return secretFromWire((await response.json()) as WireSecret);
    },

    async revoke(
      id: string,
      key: string,
      version?: number,
    ): Promise<StoredSecret> {
      const response = await request("POST", `${secretPath(id)}/revoke`, {
        idempotencyKey: key,
        body: {},
        ...(version === undefined ? {} : { ifMatch: version }),
      });
      if (response.status !== 200) return secretRefusal(response, id, "revoke");
      return secretFromWire((await response.json()) as WireSecret);
    },

    /** Removes the secret for good. True when this call removed it, false when it was already gone. */
    async purge(id: string, key: string): Promise<boolean> {
      const response = await request("DELETE", secretPath(id), {
        idempotencyKey: key,
      });
      if (response.status === 404) return false;
      if (response.status !== 204) return secretRefusal(response, id, "purge");
      return true;
    },

    /** The value of a live secret. The vault records the read: who, which secret, which Bot, why. */
    async reveal(
      id: string,
      accessor: SecretAccessor,
    ): Promise<RevealedSecret> {
      const response = await request("POST", `${secretPath(id)}/reveal`, {
        body: {
          purpose: accessor.purpose,
          accessor: {
            ...(accessor.userId ? { userId: accessor.userId } : {}),
            ...(accessor.botId ? { agentId: accessor.botId } : {}),
          },
        },
      });
      if (response.status !== 200) return secretRefusal(response, id, "reveal");
      return (await response.json()) as RevealedSecret;
    },

    async accessEvents(secretId?: string): Promise<SecretAccessEvent[]> {
      const query = new URLSearchParams({ limit: "100" });
      if (secretId) query.set("secretId", secretId);
      const response = await request(
        "GET",
        `/api/vault/access-events?${query}`,
      );
      if (response.status !== 200)
        return secretRefusal(response, secretId ?? "*", "list the reads of");
      const body = (await response.json()) as {
        events: Array<
          Omit<SecretAccessEvent, "createdAt"> & { createdAt: string }
        >;
      };
      return body.events.map((event) => ({
        ...event,
        createdAt: new Date(event.createdAt),
      }));
    },
  };

  const toolServers = {
    async create(draft: ToolServerDraft, key: string): Promise<ToolServer> {
      const response = await request("POST", "/api/tool-servers", {
        idempotencyKey: key,
        body: {
          id: draft.id,
          ...toolServerChangesToWire(draft),
          ...(draft.createdAt
            ? { createdAt: draft.createdAt.toISOString() }
            : {}),
        },
      });
      if (response.status !== 201 && response.status !== 200)
        return recordRefusal(response, "App", draft.id, "add");
      return toolServerFromWire((await response.json()) as WireToolServer);
    },
    async get(id: string): Promise<ToolServer | null> {
      const response = await request("GET", serverPath(id));
      if (response.status === 404) return null;
      if (response.status !== 200)
        return recordRefusal(response, "App", id, "read");
      return toolServerFromWire((await response.json()) as WireToolServer);
    },
    async all(): Promise<{ servers: ToolServer[]; joinCode: string | null }> {
      const { items, joinCode } = await walkPages(async (cursor) => {
        const query = new URLSearchParams({ limit: "100" });
        if (cursor) query.set("cursor", cursor);
        const response = await request("GET", `/api/tool-servers?${query}`);
        if (response.status !== 200)
          return recordRefusal(response, "App", "*", "list");
        const body = (await response.json()) as {
          toolServers: WireToolServer[];
          nextCursor: string | null;
          joinCode?: string | null;
        };
        return {
          items: body.toolServers.map(toolServerFromWire),
          nextCursor: body.nextCursor,
          joinCode: body.joinCode ?? null,
        };
      });
      return { servers: items, joinCode };
    },
    async update(
      id: string,
      version: number,
      changes: ToolServerChanges,
      key: string,
    ): Promise<ToolServer> {
      const response = await request("PATCH", serverPath(id), {
        ifMatch: version,
        idempotencyKey: key,
        body: toolServerChangesToWire(changes),
      });
      if (response.status !== 200)
        return recordRefusal(response, "App", id, "change");
      return toolServerFromWire((await response.json()) as WireToolServer);
    },
    /** True when this call removed it, false when it was already gone. */
    async remove(id: string, key: string): Promise<boolean> {
      const response = await request("DELETE", serverPath(id), {
        idempotencyKey: key,
      });
      if (response.status === 404) return false;
      if (response.status !== 204)
        return recordRefusal(response, "App", id, "remove");
      return true;
    },
  };

  const connections = {
    async create(draft: ConnectionDraft, key: string): Promise<Connection> {
      const response = await request("POST", "/api/connections", {
        idempotencyKey: key,
        body: connectionDraftToWire(draft),
      });
      if (response.status !== 201 && response.status !== 200)
        return recordRefusal(response, "Connection", draft.id, "store");
      return connectionFromWire((await response.json()) as WireConnection);
    },
    async get(id: string): Promise<Connection | null> {
      const response = await request("GET", connectionPath(id));
      if (response.status === 404) return null;
      if (response.status !== 200)
        return recordRefusal(response, "Connection", id, "read");
      return connectionFromWire((await response.json()) as WireConnection);
    },
    async all(): Promise<{
      connections: Connection[];
      joinCode: string | null;
    }> {
      const { items, joinCode } = await walkPages(async (cursor) => {
        const query = new URLSearchParams({ limit: "100" });
        if (cursor) query.set("cursor", cursor);
        const response = await request("GET", `/api/connections?${query}`);
        if (response.status !== 200)
          return recordRefusal(response, "Connection", "*", "list");
        const body = (await response.json()) as {
          connections: WireConnection[];
          nextCursor: string | null;
          joinCode?: string | null;
        };
        return {
          items: body.connections.map(connectionFromWire),
          nextCursor: body.nextCursor,
          joinCode: body.joinCode ?? null,
        };
      });
      return { connections: items, joinCode };
    },
    async update(
      id: string,
      version: number,
      changes: ConnectionChanges,
      key: string,
    ): Promise<Connection> {
      const response = await request("PATCH", connectionPath(id), {
        ifMatch: version,
        idempotencyKey: key,
        body: connectionChangesToWire(changes),
      });
      if (response.status !== 200)
        return recordRefusal(response, "Connection", id, "change");
      return connectionFromWire((await response.json()) as WireConnection);
    },
    /** True when this call removed it, false when it was already gone. */
    async remove(id: string, key: string): Promise<boolean> {
      const response = await request("DELETE", connectionPath(id), {
        idempotencyKey: key,
      });
      if (response.status === 404) return false;
      if (response.status !== 204)
        return recordRefusal(response, "Connection", id, "remove");
      return true;
    },
  };

  return {
    secrets,
    toolServers,
    connections,
    /** Credentials for the realtime topic that announces every change to secrets, apps and connections. */
    async subscribe(): Promise<{ joinToken: string; joinCode: string }> {
      const response = await request("POST", "/api/connections/subscribe", {
        body: {},
      });
      if (response.status !== 200)
        return recordRefusal(response, "Subscription", "*", "create");
      return (await response.json()) as { joinToken: string; joinCode: string };
    },
  };
}

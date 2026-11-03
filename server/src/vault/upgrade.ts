/**
 * Moving an existing deployment's secrets, apps and connections into Intelligence, once, at boot.
 *
 * A deployment that ran before this release holds its credentials in `credentials` and its people's
 * saved website logins in `saved_logins`, both encrypted under the local `KEY_ENCRYPTION_KEY`; its apps
 * in `mcp_servers`; and its connections in `mcp_user_credentials`, `brokered_connections` and
 * `brokered_identities`. This decrypts each secret with the local key and stores it in Intelligence's
 * vault under the SAME id, revoked ones included, so every pointer that names a credential (an app's,
 * a person's grant, a GitHub link, a responsibility's trigger, a remote Bot's `credentialRef` in the
 * agent registry) keeps resolving. Then it copies the apps and connections. Then it checks that
 * Intelligence holds every id it copied, and only then records each copy as done, so it never runs
 * again: a secret or connection later removed in Intelligence must not come back from a local row
 * this release keeps.
 *
 * SAFE TO RUN ANY NUMBER OF TIMES, FROM ANY NUMBER OF REPLICAS AT ONCE. The copy runs under a lease
 * (`vault/leases.ts`), so replicas take turns, and the second finds it recorded. Each record is written
 * under an idempotency key made from the record itself, and a record Intelligence already has is left
 * alone.
 *
 * LOUD ON A MISMATCH. A record Intelligence refuses, a secret the local key cannot decrypt, or a record
 * missing after the copy stops the boot with the ids named. Running on with some secrets moved and some
 * not would leave apps that cannot be called and logins that cannot be used, with nothing saying why.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { credentialOwner, decryptSecret } from "../credentials";
import type { Database } from "../db/client";
import {
  brokeredConnections,
  brokeredIdentities,
  credentials,
  intelligenceCopies,
  mcpServers,
  mcpUserCredentials,
  savedLogins,
} from "../db/schema";
import {
  type ConnectionDraft,
  ConnectionRecordExistsError,
  SecretAlreadyExistsError,
  type SecretDraft,
  type ToolServerDraft,
} from "./client";
import type { ConnectionsDirectory } from "./directory";
import { brokeredId, grantId, identityId } from "./ids";
import { holdSecretLease } from "./leases";

export const VAULT_COPY_NAME = "vault";
export const CONNECTIONS_COPY_NAME = "connections";

export class VaultCopyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultCopyMismatchError";
  }
}

export type VaultCopyOutcome = {
  secrets:
    | { kind: "done-before" }
    | { kind: "copied"; local: number; created: number };
  connections:
    | { kind: "done-before" }
    | { kind: "copied"; servers: number; connections: number; created: number };
};

/** The same key for the same record from every replica, so their writes are one write. */
function upgradeKey(kind: string, record: unknown): string {
  return `openbot-upgrade:${kind}:${createHash("sha256").update(JSON.stringify(record)).digest("hex")}`;
}

async function done(database: Database, name: string) {
  const [row] = await database
    .select({ name: intelligenceCopies.name })
    .from(intelligenceCopies)
    .where(eq(intelligenceCopies.name, name))
    .limit(1);
  return row !== undefined;
}

async function copySecrets(
  database: Database,
  directory: ConnectionsDirectory,
  encryptionKey: string,
) {
  const credentialRows = await database.select().from(credentials);
  const loginRows = await database.select().from(savedLogins);
  const { secrets: before } = await directory.client.secrets.all({
    includeRevoked: true,
  });
  const already = new Set(before.map((secret) => secret.id));
  const refused: string[] = [];
  const drafts: SecretDraft[] = [];
  for (const row of credentialRows) {
    if (already.has(row.id)) continue;
    try {
      const metadata = (row.metadata ?? {}) as Record<string, unknown>;
      drafts.push({
        id: row.id,
        kind: row.kind,
        provider: row.provider,
        keyId: row.keyId,
        ownerUserId: credentialOwner({
          kind: row.kind,
          provider: row.provider,
          keyId: row.keyId,
          metadata,
        }),
        metadata,
        plaintext: await decryptSecret(encryptionKey, row.encryptedValue),
        createdAt: row.createdAt,
        revokedAt: row.revokedAt,
      });
    } catch (error) {
      refused.push(
        `credential ${row.id}: the local key could not decrypt it (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  for (const row of loginRows) {
    if (already.has(row.id)) continue;
    try {
      drafts.push({
        id: row.id,
        kind: "website_login",
        provider: row.origin,
        keyId: row.username,
        ownerUserId: row.ownerUserId,
        metadata: {
          lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
        },
        plaintext: await decryptSecret(encryptionKey, row.encryptedPassword),
        createdAt: row.createdAt,
      });
    } catch (error) {
      refused.push(
        `saved login ${row.id}: the local key could not decrypt it (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  /*
   * Revoked ones first: a name may hold one live secret, and an older revoked one under the same name
   * must not be refused for standing beside it. Order inside each group keeps the local creation order.
   */
  drafts.sort(
    (left, right) =>
      Number(left.revokedAt == null) - Number(right.revokedAt == null) ||
      (left.createdAt?.getTime() ?? 0) - (right.createdAt?.getTime() ?? 0),
  );
  let created = 0;
  for (const draft of drafts) {
    const { plaintext: _value, ...fingerprint } = draft;
    try {
      // The key is made from the record without its value: the same record is the same write.
      await directory.createSecret(
        draft,
        upgradeKey("secret", {
          ...fingerprint,
          valueDigest: createHash("sha256")
            .update(draft.plaintext)
            .digest("hex"),
        }),
      );
      created += 1;
    } catch (error) {
      if (error instanceof SecretAlreadyExistsError) continue;
      refused.push(
        `${draft.kind} ${draft.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const local = credentialRows.length + loginRows.length;
  if (refused.length > 0) {
    throw new VaultCopyMismatchError(
      `${refused.length} of this deployment's ${local} secrets were not moved into Intelligence's vault, and this server will not start without them:\n${refused.join("\n")}`,
    );
  }
  const { secrets: after } = await directory.client.secrets.all({
    includeRevoked: true,
  });
  const present = new Set(after.map((secret) => secret.id));
  const missing = [
    ...credentialRows.map((row) => row.id),
    ...loginRows.map((row) => row.id),
  ].filter((id) => !present.has(id));
  if (missing.length > 0) {
    throw new VaultCopyMismatchError(
      `${local} secrets were to be copied into Intelligence's vault and ${local - missing.length} are there. Missing: ${missing.join(", ")}`,
    );
  }
  await database
    .insert(intelligenceCopies)
    .values({ name: VAULT_COPY_NAME, copied: local })
    .onConflictDoNothing();
  console.info(
    JSON.stringify({
      type: "vault-copied-to-intelligence",
      credentials: credentialRows.length,
      savedLogins: loginRows.length,
      created,
    }),
  );
  return { kind: "copied" as const, local, created };
}

async function copyConnections(
  database: Database,
  directory: ConnectionsDirectory,
) {
  const serverRows = await database.select().from(mcpServers);
  const grantRows = await database.select().from(mcpUserCredentials);
  const brokeredRows = await database.select().from(brokeredConnections);
  const identityRows = await database.select().from(brokeredIdentities);
  const refused: string[] = [];
  let created = 0;

  const { servers: serversBefore } = await directory.client.toolServers.all();
  const serversAlready = new Set(serversBefore.map((server) => server.id));
  for (const row of serverRows) {
    if (serversAlready.has(row.id)) continue;
    const draft: ToolServerDraft = {
      id: row.id,
      title: row.title,
      logo: row.logo,
      vendor: row.vendor,
      url: row.url,
      provenance: row.provenance,
      authScheme: row.authScheme,
      credentialId: row.credentialId,
      accountMode: row.accountMode,
      sharedVendorUserId: row.sharedVendorUserId,
      ownerGrants: row.ownerGrants,
      entraScope: row.entraScope,
      addedBy: row.addedBy,
      createdAt: row.createdAt,
    };
    try {
      await directory.createServer(draft, upgradeKey("app", draft));
      created += 1;
    } catch (error) {
      if (error instanceof ConnectionRecordExistsError) continue;
      refused.push(
        `app ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const drafts: ConnectionDraft[] = [
    ...grantRows.map(
      (row): ConnectionDraft => ({
        kind: "grant",
        id: grantId(row.serverId, row.userId),
        serverId: row.serverId,
        userId: row.userId,
        credentialId: row.credentialId,
        scope: row.scope,
        connectedAt: row.connectedAt,
      }),
    ),
    ...brokeredRows.map(
      (row): ConnectionDraft => ({
        kind: "brokered",
        id: brokeredId(row.provider, row.app, row.holder, row.userId),
        provider: row.provider,
        app: row.app,
        holder: row.holder,
        userId: row.holder === "person" ? row.userId : null,
        vendorUserId: row.vendorUserId,
        connectedBy: row.connectedBy,
        connectedAt: row.connectedAt,
        verified: row.verified,
        verifiedAt: row.verifiedAt,
        probeAction: row.probeAction,
      }),
    ),
    ...identityRows.map(
      (row): ConnectionDraft => ({
        kind: "identity",
        id: identityId(row.provider, row.userId),
        provider: row.provider,
        userId: row.userId,
        vendorUserId: row.vendorUserId,
        createdAt: row.createdAt,
      }),
    ),
  ];
  const { connections: connectionsBefore } =
    await directory.client.connections.all();
  const connectionsAlready = new Set(connectionsBefore.map((c) => c.id));
  for (const draft of drafts) {
    if (connectionsAlready.has(draft.id)) continue;
    try {
      await directory.createConnection(draft, upgradeKey("connection", draft));
      created += 1;
    } catch (error) {
      if (error instanceof ConnectionRecordExistsError) continue;
      refused.push(
        `${draft.kind} ${draft.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const local = serverRows.length + drafts.length;
  if (refused.length > 0) {
    throw new VaultCopyMismatchError(
      `Intelligence refused ${refused.length} of this deployment's ${local} apps and connections, so they were not moved and this server will not start without them:\n${refused.join("\n")}`,
    );
  }
  const [{ servers: serversAfter }, { connections: connectionsAfter }] =
    await Promise.all([
      directory.client.toolServers.all(),
      directory.client.connections.all(),
    ]);
  const present = new Set([
    ...serversAfter.map((server) => server.id),
    ...connectionsAfter.map((connection) => connection.id),
  ]);
  const missing = [
    ...serverRows.map((row) => row.id),
    ...drafts.map((draft) => draft.id),
  ].filter((id) => !present.has(id));
  if (missing.length > 0) {
    throw new VaultCopyMismatchError(
      `${local} apps and connections were to be copied into Intelligence and ${local - missing.length} are there. Missing: ${missing.join(", ")}`,
    );
  }
  await database
    .insert(intelligenceCopies)
    .values({ name: CONNECTIONS_COPY_NAME, copied: local })
    .onConflictDoNothing();
  console.info(
    JSON.stringify({
      type: "connections-copied-to-intelligence",
      apps: serverRows.length,
      grants: grantRows.length,
      brokered: brokeredRows.length,
      identities: identityRows.length,
      created,
    }),
  );
  return {
    kind: "copied" as const,
    servers: serverRows.length,
    connections: drafts.length,
    created,
  };
}

/**
 * Copies the local vault, apps and connections into Intelligence, each once. The secrets go first:
 * an app or a grant names a secret, and must never be the only one of the pair that arrived.
 */
export async function copyLocalVaultToIntelligence(
  database: Database,
  directory: ConnectionsDirectory,
  encryptionKey: string,
): Promise<VaultCopyOutcome> {
  if (
    (await done(database, VAULT_COPY_NAME)) &&
    (await done(database, CONNECTIONS_COPY_NAME))
  ) {
    return {
      secrets: { kind: "done-before" },
      connections: { kind: "done-before" },
    };
  }
  // Replicas booting together take turns; the one that waited finds the copy recorded.
  const lease = await holdSecretLease(database, "upgrade-copy:vault", {
    ttlMs: 10 * 60 * 1000,
    waitMs: 11 * 60 * 1000,
  });
  try {
    const secrets = (await done(database, VAULT_COPY_NAME))
      ? ({ kind: "done-before" } as const)
      : await copySecrets(database, directory, encryptionKey);
    const connections = (await done(database, CONNECTIONS_COPY_NAME))
      ? ({ kind: "done-before" } as const)
      : await copyConnections(database, directory);
    return { secrets, connections };
  } finally {
    await lease.release();
  }
}

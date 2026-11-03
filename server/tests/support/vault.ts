// server/tests/support/vault.ts
//
// Secrets, apps and connections for the tests, in a real Intelligence.
//
// They live in Intelligence's vault and connections now, so a test that needs one makes it there,
// through the same directory the server uses, and reads it back the way the server does. There is no
// stand-in: a fake vault that passed while the real one refused would be exactly the test that lies.
//
// WHICH INTELLIGENCE. The same as the Bots': `TEST_INTELLIGENCE_API_URL`, `TEST_INTELLIGENCE_API_KEY`
// and `TEST_INTELLIGENCE_GATEWAY_WS_URL` (see support/bots.ts), failing by name when missing.
//
// ISOLATION. Every file shares one Intelligence project, as every file shares the test database. A
// test that used to delete its `mcp_servers` or `credentials` rows removes them here instead, with
// the helpers below; a test that needs to start from no apps at all calls `removeAllApps`.
import { randomUUID } from "node:crypto";
import { type CredentialKind, credentialOwner } from "../../src/credentials";
import { createDatabase } from "../../src/db/client";
import {
  type BrokeredConnection,
  type BrokeredIdentity,
  createVaultClient,
  type ServerGrant,
  type StoredSecret,
  type ToolServer,
  type ToolServerDraft,
} from "../../src/vault/client";
import {
  type ConnectionsDirectory,
  createConnectionsDirectory,
  installConnectionsDirectory,
} from "../../src/vault/directory";
import { brokeredId, grantId, identityId } from "../../src/vault/ids";
import { removeServerLocalRows } from "../../src/vault/local-rows";
import { testIntelligence, useTestBots } from "./bots";
import { testDatabaseUrl } from "./database";

let started: Promise<ConnectionsDirectory> | undefined;

/**
 * The process's vault directory, against the test Intelligence, installed and loaded. Once per
 * process: every file shares it. Starts the Bot directory too, since most callers of either need both.
 */
export function useTestVault(): Promise<ConnectionsDirectory> {
  started ??= (async () => {
    const intelligence = testIntelligence();
    await useTestBots();
    const directory = installConnectionsDirectory(
      createConnectionsDirectory({
        client: createVaultClient({
          apiUrl: intelligence.apiUrl,
          apiKey: intelligence.apiKey,
        }),
        gatewayWsUrl: intelligence.gatewayWsUrl,
      }),
    );
    // The same cleanup the server wires: a removed app takes its rows here with it.
    const database = createDatabase(testDatabaseUrl(), { max: 1 });
    directory.onServerRemoved((serverId) =>
      removeServerLocalRows(database, [serverId]),
    );
    await directory.start();
    return directory;
  })();
  return started;
}

/** A second directory on the same Intelligence: another replica of the same deployment. */
export async function anotherReplica(
  options: { valueTtlMs?: number } = {},
): Promise<ConnectionsDirectory> {
  const intelligence = testIntelligence();
  const directory = createConnectionsDirectory({
    client: createVaultClient({
      apiUrl: intelligence.apiUrl,
      apiKey: intelligence.apiKey,
    }),
    gatewayWsUrl: intelligence.gatewayWsUrl,
    ...options,
  });
  await directory.start();
  return directory;
}

// ---------------------------------------------------------------- secrets

export type SeedCredential = {
  id?: string;
  kind: CredentialKind;
  provider: string;
  keyId: string;
  metadata?: Record<string, unknown>;
  plaintext: string;
  ownerUserId?: string | null;
  revoked?: boolean;
};

/** Store a credential in the vault, as the old tests inserted a `credentials` row. */
export async function seedCredential(
  input: SeedCredential,
): Promise<StoredSecret> {
  const directory = await useTestVault();
  const metadata = input.metadata ?? {};
  const secret = await directory.createSecret({
    id: input.id ?? randomUUID(),
    kind: input.kind,
    provider: input.provider,
    keyId: input.keyId,
    ownerUserId: credentialOwner({ ...input, metadata }),
    metadata,
    plaintext: input.plaintext,
  });
  return input.revoked ? directory.revokeSecret(secret.id) : secret;
}

/** The secret as Intelligence holds it now, past this process's memory, or null. */
export async function storedSecret(id: string): Promise<StoredSecret | null> {
  return (await useTestVault()).client.secrets.get(id);
}

/** The value of a secret, read the way the server reads it (and recorded). */
export async function secretValue(id: string): Promise<string> {
  return (
    await (
      await useTestVault()
    ).client.secrets.reveal(id, {
      purpose: "test_assertion",
    })
  ).value;
}

/** Every live secret of a kind for a provider, from Intelligence. */
export async function liveSecrets(filter: {
  kind?: CredentialKind | "website_login";
  provider?: string;
  keyId?: string;
}): Promise<StoredSecret[]> {
  const directory = await useTestVault();
  const { secrets } = await directory.client.secrets.all({
    ...(filter.kind ? { kind: filter.kind } : {}),
    ...(filter.provider ? { provider: filter.provider } : {}),
    ...(filter.keyId ? { keyId: filter.keyId } : {}),
  });
  return secrets;
}

/** Remove secrets for good, as test cleanup. */
export async function purgeSecrets(ids: Iterable<string>): Promise<void> {
  const directory = await useTestVault();
  for (const id of ids) await directory.purgeSecret(id);
}

// ---------------------------------------------------------------- apps

export type SeedServer = Partial<Omit<ToolServerDraft, "id">> & {
  id: string;
  url: string;
};

/** Add an app, as the old tests inserted an `mcp_servers` row. Replaces one under the same id. */
export async function seedServer(input: SeedServer): Promise<ToolServer> {
  const directory = await useTestVault();
  const draft: ToolServerDraft = {
    id: input.id,
    title: input.title ?? input.id,
    logo: input.logo ?? null,
    vendor: input.vendor ?? input.id,
    url: input.url,
    provenance: input.provenance ?? "first-party",
    authScheme: input.authScheme ?? null,
    credentialId: input.credentialId ?? null,
    accountMode: input.accountMode ?? null,
    sharedVendorUserId: input.sharedVendorUserId ?? null,
    ownerGrants: input.ownerGrants ?? null,
    entraScope: input.entraScope ?? null,
    addedBy: input.addedBy ?? null,
  };
  const existing = await directory.findServer(input.id);
  if (!existing) return directory.createServer(draft);
  const { id: _id, ...changes } = draft;
  return directory.updateServer(input.id, existing.version, changes);
}

/** Change an app at its current version, as the old tests updated an `mcp_servers` row. */
export async function changeServer(
  id: string,
  changes: Partial<Omit<ToolServerDraft, "id">>,
): Promise<ToolServer> {
  const directory = await useTestVault();
  const current = await directory.refreshServer(id);
  if (!current) throw new Error(`Intelligence has no app ${id}`);
  return directory.updateServer(id, current.version, changes);
}

/** The app as Intelligence holds it now, past this process's memory, or null. */
export async function storedServer(id: string): Promise<ToolServer | null> {
  return (await useTestVault()).client.toolServers.get(id);
}

/** Remove apps for good, and this deployment's rows that named them, as test cleanup. */
export async function removeServers(ids: Iterable<string>): Promise<void> {
  const directory = await useTestVault();
  for (const id of ids) {
    if (await directory.findServer(id)) await directory.removeServer(id);
  }
}

/** Remove every app the test project holds, for a test that must start from none. */
export async function removeAllApps(): Promise<void> {
  const directory = await useTestVault();
  const { servers } = await directory.client.toolServers.all();
  for (const server of servers) await directory.removeServer(server.id);
  const { connections } = await directory.client.connections.all();
  for (const connection of connections)
    await directory.removeConnection(connection.id);
}

// ---------------------------------------------------------------- connections

/** Record a person's grant on an app, as the old tests inserted an `mcp_user_credentials` row. */
export async function seedGrant(input: {
  serverId: string;
  userId: string;
  credentialId: string;
  scope?: string;
}): Promise<ServerGrant> {
  const directory = await useTestVault();
  const id = grantId(input.serverId, input.userId);
  const existing = await directory.findConnection(id);
  const written = existing
    ? await directory.updateConnection(id, existing.version, {
        credentialId: input.credentialId,
        scope: input.scope ?? "",
      })
    : await directory.createConnection({
        kind: "grant",
        id,
        serverId: input.serverId,
        userId: input.userId,
        credentialId: input.credentialId,
        scope: input.scope ?? "",
      });
  if (written.kind !== "grant") throw new Error(`${id} is not a grant`);
  return written;
}

/** Record a brokered account, as the old tests inserted a `brokered_connections` row. */
export async function seedBrokered(input: {
  provider?: "composio" | "arcade";
  app: string;
  holder?: "person" | "deployment";
  userId?: string | null;
  vendorUserId?: string;
  connectedBy?: string | null;
  connectedAt?: Date;
  verified?: boolean;
  verifiedAt?: Date | null;
  probeAction?: string | null;
}): Promise<BrokeredConnection> {
  const directory = await useTestVault();
  const provider = input.provider ?? "composio";
  const holder = input.holder ?? "person";
  const userId = holder === "person" ? (input.userId ?? null) : null;
  if (holder === "person" && !userId)
    throw new Error("A person's brokered account needs a userId.");
  const id = brokeredId(provider, input.app, holder, userId);
  const existing = await directory.findConnection(id);
  if (existing) await directory.removeConnection(id);
  const written = await directory.createConnection({
    kind: "brokered",
    id,
    provider,
    app: input.app,
    holder,
    userId,
    vendorUserId: input.vendorUserId ?? userId ?? `deployment:${randomUUID()}`,
    connectedBy: input.connectedBy ?? null,
    verified: input.verified ?? false,
    verifiedAt: input.verifiedAt ?? null,
    probeAction: input.probeAction ?? null,
    ...(input.connectedAt ? { connectedAt: input.connectedAt } : {}),
  });
  if (written.kind !== "brokered") throw new Error(`${id} is not brokered`);
  return written;
}

/** File a person under a name at a broker, as the old tests inserted a `brokered_identities` row. */
export async function seedIdentity(input: {
  provider?: "composio" | "arcade";
  userId: string;
  vendorUserId: string;
}): Promise<BrokeredIdentity> {
  const directory = await useTestVault();
  const provider = input.provider ?? "composio";
  const id = identityId(provider, input.userId);
  if (await directory.findConnection(id)) await directory.removeConnection(id);
  const written = await directory.createConnection({
    kind: "identity",
    id,
    provider,
    userId: input.userId,
    vendorUserId: input.vendorUserId,
  });
  if (written.kind !== "identity") throw new Error(`${id} is not an identity`);
  return written;
}

/** Every grant, brokered account and identity Intelligence holds now, past this process's memory. */
export async function storedConnections(): Promise<{
  grants: ServerGrant[];
  brokered: BrokeredConnection[];
  identities: BrokeredIdentity[];
}> {
  const { connections } = await (await useTestVault()).client.connections.all();
  return {
    grants: connections.filter((c): c is ServerGrant => c.kind === "grant"),
    brokered: connections.filter(
      (c): c is BrokeredConnection => c.kind === "brokered",
    ),
    identities: connections.filter(
      (c): c is BrokeredIdentity => c.kind === "identity",
    ),
  };
}

/** Remove connections for good, by a predicate over what Intelligence holds now. */
export async function removeConnectionsWhere(
  match: (
    connection: ServerGrant | BrokeredConnection | BrokeredIdentity,
  ) => boolean,
): Promise<number> {
  const directory = await useTestVault();
  const { connections } = await directory.client.connections.all();
  let removed = 0;
  for (const connection of connections) {
    if (!match(connection)) continue;
    if (await directory.removeConnection(connection.id)) removed += 1;
  }
  return removed;
}

/**
 * The plugin store's apps and connections, read from and written to Intelligence through this
 * instance's vault directory (`vault/directory.ts`), in the row shapes the store always used.
 *
 * WHY THIS FILE. `mcp_servers`, `mcp_user_credentials`, `brokered_connections` and
 * `brokered_identities` are Intelligence's now (`docs/contracts/connections.md` there), and the store
 * reads them on every turn and tool call. Every read here answers from memory; nothing here waits on
 * Intelligence except a write, a read-through for a record this instance has not heard of yet, and a
 * re-read after a version conflict. So a read is safe inside an OpenBot transaction, and a write is
 * never: a caller makes its writes here with no transaction open.
 *
 * WRITES ARE CONDITIONAL, AS THE SQL WAS. An update that used to say `WHERE account_mode IS NULL` takes
 * a `when` here: it is checked against the record as Intelligence last answered, and the write carries
 * that version (`If-Match`), so a change made elsewhere in between is read again and checked again
 * rather than overwritten. Upserts keyed on a natural key use the deterministic ids in
 * `vault/upgrade.ts`, so two replicas writing the same connection write the same record.
 */
import {
  type BrokeredConnection,
  type BrokeredIdentity,
  ConnectionRecordConflictError,
  ConnectionRecordExistsError,
  ConnectionRecordMissingError,
  type ServerGrant,
  type ToolServer,
  type ToolServerChanges,
  type ToolServerDraft,
} from "../../vault/client";
import { vault } from "../../vault/directory";
import { brokeredId, grantId, identityId } from "../../vault/ids";
import type { BrokerProvider } from "../access";

export type { BrokeredConnection, BrokeredIdentity, ServerGrant, ToolServer };

const ATTEMPTS = 4;

// ---------------------------------------------------------------- apps

/** Every app this deployment has added, from memory, ordered by id as the table's reads were. */
export function allServers(): ToolServer[] {
  return vault()
    .servers()
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
}

/** One app from memory, or undefined. For code that must not wait on Intelligence. */
export function peekServer(id: string): ToolServer | undefined {
  return vault().peekServer(id);
}

/** One app, from memory, reading through to Intelligence when this instance has not heard of it. */
export function findServer(id: string): Promise<ToolServer | null> {
  return vault().findServer(id);
}

/** The apps whose url is one of these, ordered by id: the "answering row" rule. */
export function serversAt(urls: Iterable<string>): ToolServer[] {
  const wanted = new Set(urls);
  return allServers().filter((server) => wanted.has(server.url));
}

/**
 * Add an app, or change the one already under this id: the old `INSERT … ON CONFLICT (id) DO UPDATE`.
 *
 * `onConflict` is what the old `DO UPDATE SET` wrote when the id was taken, computed from the record
 * that is there, so a field the old statement left alone is left alone here too.
 */
export async function upsertServer(
  draft: ToolServerDraft,
  onConflict: (existing: ToolServer) => ToolServerChanges,
): Promise<ToolServer> {
  const directory = vault();
  for (let attempt = 1; ; attempt++) {
    const existing = await directory.findServer(draft.id);
    try {
      if (!existing) return await directory.createServer(draft);
      return await directory.updateServer(
        existing.id,
        existing.version,
        onConflict(existing),
      );
    } catch (error) {
      const raced =
        error instanceof ConnectionRecordExistsError ||
        error instanceof ConnectionRecordConflictError ||
        error instanceof ConnectionRecordMissingError;
      if (!raced || attempt >= ATTEMPTS) throw error;
      await directory.refreshServer(draft.id);
    }
  }
}

/**
 * Change an app, when `when` holds for it as Intelligence holds it. The old `UPDATE … WHERE`.
 *
 * @returns The changed app, or null when there is no such app or `when` refused it.
 */
export async function updateServer(
  id: string,
  changes: ToolServerChanges | ((current: ToolServer) => ToolServerChanges),
  when: (current: ToolServer) => boolean = () => true,
): Promise<ToolServer | null> {
  const directory = vault();
  for (let attempt = 1; ; attempt++) {
    const current = await directory.findServer(id);
    if (!current || !when(current)) return null;
    try {
      return await directory.updateServer(
        id,
        current.version,
        typeof changes === "function" ? changes(current) : changes,
      );
    } catch (error) {
      if (error instanceof ConnectionRecordMissingError) {
        await directory.refreshServer(id);
        return null;
      }
      if (
        !(error instanceof ConnectionRecordConflictError) ||
        attempt >= ATTEMPTS
      )
        throw error;
      await directory.refreshServer(id);
    }
  }
}

/**
 * Remove an app for good. Its people's grants go with it in Intelligence, and this deployment's rows
 * that named it go through the directory's removal listeners (`vault/local-rows.ts`).
 *
 * @returns True when this call removed it.
 */
export async function removeServer(id: string): Promise<boolean> {
  const directory = vault();
  const existed = (await directory.findServer(id)) !== null;
  await directory.removeServer(id);
  return existed;
}

// ---------------------------------------------------------------- a person's grant on an app

export function allGrants(): ServerGrant[] {
  return vault()
    .connections()
    .filter(
      (connection): connection is ServerGrant => connection.kind === "grant",
    );
}

/** A person's grant on an app, from memory. */
export function grantFor(
  serverId: string,
  userId: string,
): ServerGrant | undefined {
  const held = vault().peekConnection(grantId(serverId, userId));
  return held?.kind === "grant" ? held : undefined;
}

/** A person's grant on an app, reading through to Intelligence when this instance has not heard of it. */
export async function findGrant(
  serverId: string,
  userId: string,
): Promise<ServerGrant | null> {
  const found = await vault().findConnection(grantId(serverId, userId));
  return found?.kind === "grant" ? found : null;
}

export function grantsOf(userId: string): ServerGrant[] {
  return allGrants().filter((grant) => grant.userId === userId);
}

export function grantsOn(serverId: string): ServerGrant[] {
  return allGrants().filter((grant) => grant.serverId === serverId);
}

/**
 * Point a person's grant on an app at a credential: the old upsert on `(server_id, user_id)`.
 */
export async function upsertGrant(input: {
  serverId: string;
  userId: string;
  credentialId: string;
  scope: string;
}): Promise<ServerGrant> {
  const directory = vault();
  const id = grantId(input.serverId, input.userId);
  for (let attempt = 1; ; attempt++) {
    const existing = await directory.findConnection(id);
    try {
      const written = existing
        ? await directory.updateConnection(id, existing.version, {
            credentialId: input.credentialId,
            scope: input.scope,
          })
        : await directory.createConnection({
            kind: "grant",
            id,
            serverId: input.serverId,
            userId: input.userId,
            credentialId: input.credentialId,
            scope: input.scope,
          });
      if (written.kind !== "grant") throw new Error(`${id} is not a grant.`);
      return written;
    } catch (error) {
      const raced =
        error instanceof ConnectionRecordExistsError ||
        error instanceof ConnectionRecordConflictError ||
        error instanceof ConnectionRecordMissingError;
      if (!raced || attempt >= ATTEMPTS) throw error;
      await directory.refreshConnection(id);
    }
  }
}

/** Remove a person's grants: every one of theirs, or theirs on one app. */
export async function removeGrants(filter: {
  userId: string;
  serverId?: string;
}): Promise<number> {
  let removed = 0;
  for (const grant of grantsOf(filter.userId)) {
    if (filter.serverId !== undefined && grant.serverId !== filter.serverId)
      continue;
    if (await vault().removeConnection(grant.id)) removed += 1;
  }
  return removed;
}

// ---------------------------------------------------------------- brokered accounts

export function allBrokered(provider?: BrokerProvider): BrokeredConnection[] {
  return vault()
    .connections()
    .filter(
      (connection): connection is BrokeredConnection =>
        connection.kind === "brokered" &&
        (provider === undefined || connection.provider === provider),
    );
}

/** What identifies one brokered account: the old `brokered_connections` row by holder. */
export type BrokeredKey =
  | { provider: BrokerProvider; app: string; holder: "person"; userId: string }
  | {
      provider: BrokerProvider;
      app: string;
      holder: "deployment";
      /** Matched too: every switch to Shared mints a new deployment identity (see `accountRow`). */
      vendorUserId?: string;
    };

const brokeredIdOf = (key: BrokeredKey) =>
  brokeredId(
    key.provider,
    key.app,
    key.holder,
    key.holder === "person" ? key.userId : null,
  );

const matches = (row: BrokeredConnection, key: BrokeredKey) =>
  key.holder === "person"
    ? true
    : key.vendorUserId === undefined || row.vendorUserId === key.vendorUserId;

/** One brokered account from memory, matching its identity for a deployment account. */
export function brokeredFor(key: BrokeredKey): BrokeredConnection | undefined {
  const held = vault().peekConnection(brokeredIdOf(key));
  return held?.kind === "brokered" && matches(held, key) ? held : undefined;
}

/** One brokered account, reading through to Intelligence when this instance has not heard of it. */
export async function findBrokered(
  key: BrokeredKey,
): Promise<BrokeredConnection | null> {
  const found = await vault().findConnection(brokeredIdOf(key));
  return found?.kind === "brokered" && matches(found, key) ? found : null;
}

/**
 * Write a brokered account: the old upsert on the holder's unique index. `onConflict` names what the
 * old `DO UPDATE SET` wrote over an existing account.
 */
export async function upsertBrokered(
  key: BrokeredKey,
  values: {
    vendorUserId: string;
    connectedBy?: string | null;
    connectedAt?: Date;
    verified: boolean;
    verifiedAt: Date | null;
    probeAction: string | null;
  },
  onConflict: (existing: BrokeredConnection) => {
    vendorUserId?: string;
    connectedBy?: string | null;
    connectedAt?: Date;
    verified?: boolean;
    verifiedAt?: Date | null;
    probeAction?: string | null;
  },
): Promise<BrokeredConnection> {
  const directory = vault();
  const id = brokeredIdOf(key);
  for (let attempt = 1; ; attempt++) {
    const existing = await directory.findConnection(id);
    try {
      const written =
        existing && existing.kind === "brokered"
          ? await directory.updateConnection(
              id,
              existing.version,
              onConflict(existing),
            )
          : await directory.createConnection({
              kind: "brokered",
              id,
              provider: key.provider,
              app: key.app,
              holder: key.holder,
              userId: key.holder === "person" ? key.userId : null,
              vendorUserId: values.vendorUserId,
              connectedBy: values.connectedBy ?? null,
              verified: values.verified,
              verifiedAt: values.verifiedAt,
              probeAction: values.probeAction,
              ...(values.connectedAt
                ? { connectedAt: values.connectedAt }
                : {}),
            });
      if (written.kind !== "brokered")
        throw new Error(`${id} is not a brokered account.`);
      return written;
    } catch (error) {
      const raced =
        error instanceof ConnectionRecordExistsError ||
        error instanceof ConnectionRecordConflictError ||
        error instanceof ConnectionRecordMissingError;
      if (!raced || attempt >= ATTEMPTS) throw error;
      await directory.refreshConnection(id);
    }
  }
}

/**
 * Change a brokered account that is still there, matching its identity. The old `UPDATE … WHERE`.
 *
 * @returns The changed account, or null when there is no such account any more.
 */
export async function updateBrokered(
  key: BrokeredKey,
  changes: {
    connectedAt?: Date;
    verified?: boolean;
    verifiedAt?: Date | null;
    probeAction?: string | null;
    vendorUserId?: string;
    connectedBy?: string | null;
  },
): Promise<BrokeredConnection | null> {
  const directory = vault();
  const id = brokeredIdOf(key);
  for (let attempt = 1; ; attempt++) {
    const current = await findBrokered(key);
    if (!current) return null;
    try {
      const written = await directory.updateConnection(
        id,
        current.version,
        changes,
      );
      return written.kind === "brokered" ? written : null;
    } catch (error) {
      if (error instanceof ConnectionRecordMissingError) {
        await directory.refreshConnection(id);
        return null;
      }
      if (
        !(error instanceof ConnectionRecordConflictError) ||
        attempt >= ATTEMPTS
      )
        throw error;
      await directory.refreshConnection(id);
    }
  }
}

/**
 * Remove brokered accounts. With a key, the one account (matching a deployment account's identity
 * when the key names one); with a filter, every account it matches.
 *
 * @returns How many this call removed.
 */
export async function removeBrokered(
  match: BrokeredKey | ((row: BrokeredConnection) => boolean),
): Promise<number> {
  const directory = vault();
  if (typeof match !== "function") {
    const current = await findBrokered(match);
    if (!current) return 0;
    return (await directory.removeConnection(current.id)) ? 1 : 0;
  }
  let removed = 0;
  for (const row of allBrokered()) {
    if (!match(row)) continue;
    if (await directory.removeConnection(row.id)) removed += 1;
  }
  return removed;
}

// ---------------------------------------------------------------- broker identities

export function identityFor(
  provider: BrokerProvider,
  userId: string,
): BrokeredIdentity | undefined {
  const held = vault().peekConnection(identityId(provider, userId));
  return held?.kind === "identity" ? held : undefined;
}

export async function findIdentity(
  provider: BrokerProvider,
  userId: string,
): Promise<BrokeredIdentity | null> {
  const found = await vault().findConnection(identityId(provider, userId));
  return found?.kind === "identity" ? found : null;
}

/** File a person under a name at a broker, unless they are filed already: the old `DO NOTHING`. */
export async function ensureIdentity(input: {
  provider: BrokerProvider;
  userId: string;
  vendorUserId: string;
}): Promise<BrokeredIdentity> {
  const existing = await findIdentity(input.provider, input.userId);
  if (existing) return existing;
  try {
    const created = await vault().createConnection({
      kind: "identity",
      id: identityId(input.provider, input.userId),
      provider: input.provider,
      userId: input.userId,
      vendorUserId: input.vendorUserId,
    });
    if (created.kind === "identity") return created;
  } catch (error) {
    if (!(error instanceof ConnectionRecordExistsError)) throw error;
  }
  const settled = await vault().refreshConnection(
    identityId(input.provider, input.userId),
  );
  if (settled?.kind !== "identity")
    throw new Error(`${input.userId} was not filed at ${input.provider}.`);
  return settled;
}

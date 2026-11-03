/**
 * Every secret's metadata, every app (tool server) and every connection this deployment has, held in
 * memory per server instance and kept fresh from Intelligence; and the secret values this instance
 * revealed a moment ago.
 *
 * WHY A CACHE. Apps and connections are read on every turn and every tool call, and a model key on
 * every run, and they live in Intelligence's vault and connections now rather than in this
 * deployment's database. Reading Intelligence on each of those would put a network round trip under
 * everything a person does. So each instance holds the whole set (a deployment's apps and connections
 * number in the thousands, not the millions) and reads it from memory, the way the Bot directory does.
 *
 * HOW IT STAYS FRESH, ACROSS REPLICAS. A write made here updates the cache from Intelligence's answer
 * at once, so this instance reads its own writes. Every other instance hears of it from Intelligence's
 * realtime gateway, which announces each change by id and version; the announcement is followed by a
 * read of that one record. Announcements can be lost, so everything is read again whenever the
 * subscription joins, which includes every reconnect, and on a timer. A miss reads through to
 * Intelligence, so a record made on another replica a moment ago is found before its announcement
 * arrives. Versions order what arrives: an older copy never replaces a newer one.
 *
 * SECRET VALUES. A value is revealed by the vault, which records every reveal: who asked, for which
 * person and which Bot, and why. A revealed value is kept here for a few minutes for the same reader
 * (secret, person, Bot, purpose), so a Bot's run of tool calls asks the vault once rather than once
 * per call, and every distinct reader still reaches the vault's record. Any announcement naming the
 * secret drops every value held for it at once; the time limit bounds how long a missed announcement
 * can leave a withdrawn secret in use. A value never leaves this process: nothing here returns one to
 * a browser.
 */
import {
  type Connection,
  type ConnectionChanges,
  type ConnectionDraft,
  type RevealedSecret,
  type SecretAccessor,
  type SecretDraft,
  SecretMissingError,
  type StoredSecret,
  type ToolServer,
  type ToolServerChanges,
  type ToolServerDraft,
  type VaultClient,
} from "./client";
import {
  type ConnectionChange,
  type ConnectionChangeSubscription,
  subscribeToConnectionChanges,
} from "./events";
import { idempotencyKey } from "./http";

/** Well inside the hour the gateway keeps a join code alive for; every full read renews it. */
const RESYNC_INTERVAL_MS = 15 * 60 * 1_000;
/** How long a miss is remembered, so a lookup of an id that does not exist does not hit Intelligence every time. */
const MISS_TTL_MS = 2_000;
/** How long a revealed value is kept for the same reader. */
export const SECRET_VALUE_TTL_MS = 5 * 60 * 1_000;

type Versioned = { id: string; version: number };

/**
 * One kind of record held in memory: the versions-only-move-forward rule, and the memory of what was
 * removed so a full read that started before a removal does not bring the record back.
 */
class RecordSet<T extends Versioned> {
  readonly records = new Map<string, T>();
  private readonly seenAt = new Map<string, number>();
  private readonly removedAt = new Map<string, number>();
  private readonly misses = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<T | null>>();

  constructor(private readonly read: (id: string) => Promise<T | null>) {}

  apply(record: T, confirmedAt = Date.now()): T {
    const removed = this.removedAt.get(record.id);
    if (removed !== undefined && removed > confirmedAt) return record;
    this.removedAt.delete(record.id);
    this.misses.delete(record.id);
    this.seenAt.set(
      record.id,
      Math.max(this.seenAt.get(record.id) ?? 0, confirmedAt),
    );
    const held = this.records.get(record.id);
    if (held && held.version > record.version) return held;
    this.records.set(record.id, record);
    return record;
  }

  /** Forgets a record. True when this instance held it. */
  forget(id: string): boolean {
    const had = this.records.delete(id);
    this.seenAt.delete(id);
    this.removedAt.set(id, Date.now());
    return had;
  }

  missed(id: string): boolean {
    const until = this.misses.get(id);
    return until !== undefined && until > Date.now();
  }

  readThrough(id: string): Promise<T | null> {
    const pending = this.inFlight.get(id);
    if (pending) return pending;
    const startedAt = Date.now();
    const read = this.read(id)
      .then((record) => {
        if (record) return this.apply(record, startedAt);
        const now = Date.now();
        if (this.misses.size > 5_000)
          for (const [held, until] of this.misses)
            if (until <= now) this.misses.delete(held);
        this.misses.set(id, now + MISS_TTL_MS);
        return null;
      })
      .finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, read);
    return read;
  }

  async find(id: string): Promise<T | null> {
    const held = this.records.get(id);
    if (held) return held;
    if (this.missed(id)) return null;
    return this.readThrough(id);
  }

  /**
   * Applies a complete listing. Returns the ids held, absent from it, and not confirmed since it
   * began: removed while nobody was listening.
   */
  replaceAll(listed: T[], startedAt: number): string[] {
    const ids = new Set<string>();
    for (const record of listed) {
      ids.add(record.id);
      this.apply(record, startedAt);
    }
    const gone: string[] = [];
    for (const id of [...this.records.keys()]) {
      if (ids.has(id)) continue;
      if ((this.seenAt.get(id) ?? 0) >= startedAt) continue;
      this.forget(id);
      gone.push(id);
    }
    return gone;
  }
}

export type ConnectionsDirectory = ReturnType<
  typeof createConnectionsDirectory
>;

export function createConnectionsDirectory(options: {
  client: VaultClient;
  /** The gateway address the runtime is configured with. Absent: no announcements, timer only. */
  gatewayWsUrl?: string;
  resyncIntervalMs?: number;
  valueTtlMs?: number;
  /** How announcements are subscribed to. The gateway's, unless a test drives them itself. */
  subscribe?: typeof subscribeToConnectionChanges;
}) {
  const { client } = options;
  const valueTtlMs = options.valueTtlMs ?? SECRET_VALUE_TTL_MS;
  const secrets = new RecordSet<StoredSecret>((id) => client.secrets.get(id));
  const servers = new RecordSet<ToolServer>((id) => client.toolServers.get(id));
  const connections = new RecordSet<Connection>((id) =>
    client.connections.get(id),
  );
  /** Revealed values by reader, and which readers each secret has, so one announcement drops them all. */
  const values = new Map<
    string,
    { value: string; version: number; expiresAt: number }
  >();
  const readersOf = new Map<string, Set<string>>();
  const serverRemovedListeners = new Set<
    (id: string) => Promise<void> | void
  >();
  let subscription: ConnectionChangeSubscription | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let resyncing: Promise<void> | undefined;
  let resyncAgain = false;

  const dropValues = (secretId: string) => {
    for (const reader of readersOf.get(secretId) ?? []) values.delete(reader);
    readersOf.delete(secretId);
  };

  const serverGone = async (id: string) => {
    for (const listener of serverRemovedListeners) {
      try {
        await listener(id);
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "app-removal-cleanup-failed",
            serverId: id,
            note: "The app is gone from Intelligence; rows here that named it were not all removed. The next boot's sweep retries.",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  };

  const heard = async (change: ConnectionChange) => {
    try {
      if (change.resource === "secret") {
        dropValues(change.id);
        const held = secrets.records.get(change.id);
        if (
          held &&
          held.version >= change.version &&
          change.change !== "deleted"
        )
          return;
        const record = await secrets.readThrough(change.id);
        if (!record) secrets.forget(change.id);
        return;
      }
      const set = change.resource === "tool_server" ? servers : connections;
      const held = set.records.get(change.id);
      if (held && held.version >= change.version && change.change !== "deleted")
        return;
      // Asked again first: an announcement can arrive after the id was made again.
      const record = await set.readThrough(change.id);
      if (record) return;
      const had = set.forget(change.id);
      if (
        change.resource === "tool_server" &&
        (had || change.change === "deleted")
      )
        await serverGone(change.id);
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "connection-change-read-failed",
          resource: change.resource,
          id: change.id,
          note: "The next full read picks the change up.",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  const readAll = async () => {
    const startedAt = Date.now();
    const [secretList, serverList, connectionList] = await Promise.all([
      client.secrets.all({ includeRevoked: true }),
      client.toolServers.all(),
      client.connections.all(),
    ]);
    for (const id of secrets.replaceAll(secretList.secrets, startedAt))
      dropValues(id);
    const removedServers = servers.replaceAll(serverList.servers, startedAt);
    connections.replaceAll(connectionList.connections, startedAt);
    for (const id of removedServers) await serverGone(id);
    const joinCode =
      connectionList.joinCode ?? serverList.joinCode ?? secretList.joinCode;
    const subscribed = subscription?.joinCode();
    if (subscribed && subscribed !== joinCode) subscription?.renew();
  };

  const resync = (): Promise<void> => {
    if (resyncing) {
      resyncAgain = true;
      return resyncing;
    }
    resyncing = (async () => {
      try {
        do {
          resyncAgain = false;
          await readAll();
        } while (resyncAgain);
      } finally {
        resyncing = undefined;
      }
    })();
    return resyncing;
  };

  const readerKey = (id: string, accessor: SecretAccessor) =>
    [id, accessor.userId ?? "", accessor.botId ?? "", accessor.purpose].join(
      "\u0000",
    );

  const directory = {
    client,

    async start() {
      if (options.gatewayWsUrl) {
        subscription = (options.subscribe ?? subscribeToConnectionChanges)({
          client,
          gatewayWsUrl: options.gatewayWsUrl,
          onChange: (change) => {
            void heard(change);
          },
          onJoined: () => {
            resync().catch((error: unknown) =>
              console.warn(
                JSON.stringify({
                  type: "connections-resync-failed",
                  error: error instanceof Error ? error.message : String(error),
                }),
              ),
            );
          },
        });
      }
      await resync();
      timer = setInterval(() => {
        resync().catch((error: unknown) =>
          console.warn(
            JSON.stringify({
              type: "connections-resync-failed",
              note: "Still serving the apps, connections and secrets this instance last read.",
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
      }, options.resyncIntervalMs ?? RESYNC_INTERVAL_MS);
      timer.unref?.();
    },

    stop() {
      clearInterval(timer);
      subscription?.stop();
    },

    subscribed: () => subscription?.joinCode() != null,
    resync,

    // ---- Secrets: metadata only ----

    /** Every secret this instance holds, revoked ones included. Never reaches Intelligence. */
    secrets: () => [...secrets.records.values()],
    /** From memory only, for code that must not wait on Intelligence. */
    peekSecret: (id: string) => secrets.records.get(id),
    /** From memory, reading through to Intelligence on a miss. Revoked secrets included. */
    findSecret: (id: string) => secrets.find(id),
    /** The live secret holding a name, from memory. At most one exists. */
    liveSecretByKey(key: {
      kind: StoredSecret["kind"];
      provider: string;
      keyId: string;
    }): StoredSecret | undefined {
      let newest: StoredSecret | undefined;
      for (const secret of secrets.records.values()) {
        if (
          secret.revokedAt === null &&
          secret.kind === key.kind &&
          secret.provider === key.provider &&
          secret.keyId === key.keyId &&
          (!newest || secret.createdAt > newest.createdAt)
        )
          newest = secret;
      }
      return newest;
    },

    async createSecret(
      draft: SecretDraft,
      key = idempotencyKey("secret-create"),
    ) {
      const created = secrets.apply(await client.secrets.create(draft, key));
      if (draft.replaces) {
        dropValues(draft.replaces);
        // The replaced secret was revoked in the same step; read it so its revocation shows here now.
        const replaced = await client.secrets.get(draft.replaces);
        if (replaced) secrets.apply(replaced);
      }
      return created;
    },

    async updateSecret(
      id: string,
      version: number,
      changes: { plaintext?: string; metadata?: Record<string, unknown> },
      key = idempotencyKey("secret-update"),
    ) {
      dropValues(id);
      return secrets.apply(
        await client.secrets.update(id, version, changes, key),
      );
    },

    async revokeSecret(
      id: string,
      key = idempotencyKey("secret-revoke"),
      version?: number,
    ) {
      dropValues(id);
      return secrets.apply(await client.secrets.revoke(id, key, version));
    },

    async purgeSecret(id: string, key = idempotencyKey("secret-purge")) {
      dropValues(id);
      await client.secrets.purge(id, key);
      secrets.forget(id);
    },

    /**
     * A live secret's value, for this reader. Asks the vault (which records the read) unless this
     * reader had it revealed within the last few minutes and nothing has changed it since.
     *
     * @throws SecretMissingError or SecretRevokedError when it cannot be spent.
     */
    async reveal(
      id: string,
      accessor: SecretAccessor,
    ): Promise<RevealedSecret> {
      const reader = readerKey(id, accessor);
      const held = values.get(reader);
      if (held && held.expiresAt > Date.now())
        return { id, version: held.version, value: held.value };
      values.delete(reader);
      const revealed = await client.secrets.reveal(id, accessor);
      // A value revealed while a change was in flight is still the vault's answer; an announcement
      // that lands after this drops it.
      values.set(reader, {
        value: revealed.value,
        version: revealed.version,
        expiresAt: Date.now() + valueTtlMs,
      });
      const readers = readersOf.get(id) ?? new Set<string>();
      readers.add(reader);
      readersOf.set(id, readers);
      return revealed;
    },

    /** Drops every value held for a secret, so the next use asks the vault. */
    forgetValues: dropValues,

    // ---- Apps (tool servers) ----

    servers: () => [...servers.records.values()],
    peekServer: (id: string) => servers.records.get(id),
    findServer: (id: string) => servers.find(id),
    /** Read this app from Intelligence now, whatever this instance holds. */
    async refreshServer(id: string) {
      const record = await servers.readThrough(id);
      if (!record && servers.forget(id)) await serverGone(id);
      return record;
    },
    async createServer(
      draft: ToolServerDraft,
      key = idempotencyKey("app-create"),
    ) {
      return servers.apply(await client.toolServers.create(draft, key));
    },
    async updateServer(
      id: string,
      version: number,
      changes: ToolServerChanges,
      key = idempotencyKey("app-update"),
    ) {
      return servers.apply(
        await client.toolServers.update(id, version, changes, key),
      );
    },
    /**
     * Removes an app for good, with its people's grants (Intelligence removes those in the same
     * step). The removal listeners run here and on every other instance.
     */
    async removeServer(id: string, key = idempotencyKey("app-remove")) {
      await client.toolServers.remove(id, key);
      servers.forget(id);
      for (const connection of [...connections.records.values()])
        if (connection.kind === "grant" && connection.serverId === id)
          connections.forget(connection.id);
      await serverGone(id);
    },
    onServerRemoved(listener: (id: string) => Promise<void> | void) {
      serverRemovedListeners.add(listener);
      return () => serverRemovedListeners.delete(listener);
    },

    // ---- Connections ----

    connections: () => [...connections.records.values()],
    peekConnection: (id: string) => connections.records.get(id),
    findConnection: (id: string) => connections.find(id),
    async refreshConnection(id: string) {
      const record = await connections.readThrough(id);
      if (!record) connections.forget(id);
      return record;
    },
    async createConnection(
      draft: ConnectionDraft,
      key = idempotencyKey("connection-create"),
    ) {
      return connections.apply(await client.connections.create(draft, key));
    },
    async updateConnection(
      id: string,
      version: number,
      changes: ConnectionChanges,
      key = idempotencyKey("connection-update"),
    ) {
      return connections.apply(
        await client.connections.update(id, version, changes, key),
      );
    },
    /** True when this call removed it, false when it was already gone. */
    async removeConnection(
      id: string,
      key = idempotencyKey("connection-remove"),
    ) {
      const removed = await client.connections.remove(id, key);
      connections.forget(id);
      return removed;
    },
  };
  return directory;
}

let installed: ConnectionsDirectory | undefined;

/** Make this the directory every secret, app and connection read and write in this process goes through. */
export function installConnectionsDirectory(
  directory: ConnectionsDirectory,
): ConnectionsDirectory {
  installed = directory;
  return directory;
}

/**
 * The vault and connections, as this process holds them.
 *
 * Throws when nothing installed a directory, rather than answering with nothing: an empty set of apps
 * looks like a deployment whose apps were all removed, and nothing about it would say why.
 */
export function vault(): ConnectionsDirectory {
  if (!installed) {
    throw new Error(
      "No vault directory is installed. The server installs one at boot (vault/directory.ts); a test installs the one in tests/support/vault.ts.",
    );
  }
  return installed;
}

export { SecretMissingError };

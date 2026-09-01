import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { CredentialStore } from "../credentials";
import type { Database } from "../db/client";
import {
  agentPreferences,
  agentProfiles,
  agents,
  deploymentPackages,
} from "../db/schema";
import {
  authFromConfiguration,
  retireReplacedKey,
  storeAgentAuth,
} from "./auth-header";
import {
  hashCallbackToken,
  mintCallbackToken,
  sameToken,
} from "./callback-token";
import { canCustomizeAgentAvatar, canManageAgent } from "./profile-policy";
import type {
  AgentActor,
  AgentProfile,
  CreateAgentInput,
} from "./profile-types";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type DatabaseExecutor = Pick<Database, "select"> | Pick<Transaction, "select">;

/** Something that can read profiles: the pool, or a caller's open transaction. */
export type ProfileReadExecutor = DatabaseExecutor;

export type AgentProfileStore = {
  list(actor: AgentActor, hidden?: boolean): Promise<AgentProfile[]>;
  get(actor: AgentActor, id: string): Promise<AgentProfile | null>;
  /** Read image bytes only for an actor who may access this profile. */
  avatar(actor: AgentActor, id: string): Promise<string | null>;
  /**
   * `get`, but on the caller's own transaction and holding the profile against deletion until that
   * transaction ends.
   *
   * A caller that writes rows referencing an agent has to validate it here rather than through
   * `get`. `get` borrows a second pooled connection, which deadlocks the caller's transaction once
   * every connection is held by one, and reads an unlocked snapshot, so a deletion committing
   * between the check and the insert leaves rows pointing at an agent that no longer runs.
   */
  getWithin(
    executor: ProfileReadExecutor,
    actor: AgentActor,
    id: string,
  ): Promise<AgentProfile | null>;
  create(actor: AgentActor, input: CreateAgentInput): Promise<AgentProfile>;
  update(
    actor: AgentActor,
    id: string,
    input: CreateAgentInput,
  ): Promise<AgentProfile>;
  setAvatar(
    actor: AgentActor,
    id: string,
    image: string | null,
  ): Promise<AgentProfile>;
  duplicate(actor: AgentActor, id: string): Promise<AgentProfile>;
  setHidden(actor: AgentActor, id: string, hidden: boolean): Promise<void>;
  softDelete(actor: AgentActor, id: string): Promise<void>;
  /**
   * Issue this agent a credential for calling tools back, and return it once.
   *
   * Returned rather than stored: only the hash is kept, so this is the one moment the token exists in
   * a readable form. Calling it again replaces the old one, which is how rotation works and how a
   * leaked token is retired.
   */
  issueCallbackToken(actor: AgentActor, id: string): Promise<string>;
  /** Take the credential away. The agent may talk, and may no longer call anything back. */
  revokeCallbackToken(actor: AgentActor, id: string): Promise<void>;
  /**
   * Which agent holds this token, if any.
   *
   * By hash, because that is all this side keeps. Not scoped to an actor: the caller is a machine
   * presenting a credential, and the credential is the whole of its claim.
   */
  agentForCallbackToken(hash: string): Promise<{ id: string } | null>;
};

export class AgentNotFoundError extends Error {
  constructor(id: string) {
    super(`Agent ${id} was not found.`);
    this.name = "AgentNotFoundError";
  }
}

export class AgentNotManageableError extends Error {
  constructor(id: string) {
    super(`Agent ${id} cannot be managed by this actor.`);
    this.name = "AgentNotManageableError";
  }
}

export class ProtectedAgentError extends Error {
  constructor(id: string) {
    super(`Agent ${id} is protected.`);
    this.name = "ProtectedAgentError";
  }
}

export class ManagedAgentUnavailableError extends Error {
  constructor() {
    super(
      "This deployment has no managed Bot. Give the coworker its own AG-UI endpoint.",
    );
    this.name = "ManagedAgentUnavailableError";
  }
}

const joinedProjection = {
  id: agents.id,
  name: agents.name,
  title: agentProfiles.title,
  roleDescription: agentProfiles.roleDescription,
  avatarSeed: agentProfiles.avatarSeed,
  hasCustomAvatar: sql<boolean>`${agentProfiles.avatarImage} is not null`,
  avatarUpdatedAt: agentProfiles.updatedAt,
  visibility: agentProfiles.visibility,
  ownerUserId: agentProfiles.ownerUserId,
  packageId: deploymentPackages.id,
  hiddenAt: agentPreferences.hiddenAt,
  deletedAt: agentProfiles.deletedAt,
  /* The hash, only so a surface can say whether one exists. It never leaves this module. */
  callbackTokenHash: agentProfiles.callbackTokenHash,
  configuration: agents.configuration,
};

function joinedProfiles(executor: DatabaseExecutor, actor: AgentActor) {
  return executor
    .select(joinedProjection)
    .from(agents)
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
    .leftJoin(
      agentPreferences,
      and(
        eq(agentPreferences.agentId, agents.id),
        eq(agentPreferences.userId, actor.id),
      ),
    )
    .leftJoin(deploymentPackages, eq(deploymentPackages.id, agents.packageId));
}

function accessFilter(actor: AgentActor) {
  if (actor.role === "admin") return undefined;

  return or(
    eq(agentProfiles.visibility, "public"),
    eq(agentProfiles.ownerUserId, actor.id),
  );
}

function mapProfile(
  row: Awaited<
    ReturnType<ReturnType<typeof joinedProfiles>["execute"]>
  >[number],
): AgentProfile {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    roleDescription: row.roleDescription,
    avatarSeed: row.avatarSeed,
    hasCustomAvatar: row.hasCustomAvatar,
    avatarUpdatedAt: row.avatarUpdatedAt,
    visibility: row.visibility,
    ownerUserId: row.ownerUserId,
    systemOwned: row.packageId !== null,
    hasCallbackToken: row.callbackTokenHash !== null,
    hidden: row.hiddenAt !== null,
    deletedAt: row.deletedAt,
    endpoint: endpointOf(row.configuration),
    // Whether a key is set, never which. The form needs to show "a key is set" so a person does not
    // wipe one by saving an unrelated edit; showing the value would put a secret in a screenshot.
    hasAuth: authFromConfiguration(row.configuration) !== null,
  };
}

/**
 * The AG-UI address this coworker runs on, read back out of its stored configuration.
 *
 * Needed so an edit does not destroy it. The edit form is the same form as create, so without the
 * current endpoint to fill it with, saving a change of title would submit an empty endpoint and
 * convert an external agent back into the built-in one. That failure is silent and total: the Bot
 * keeps working, so nothing looks broken, and it is simply no longer their agent.
 */
function endpointOf(configuration: unknown): string | null {
  if (!configuration || typeof configuration !== "object") return null;
  const endpoint = (configuration as { endpoint?: unknown }).endpoint;
  return typeof endpoint === "string" ? endpoint : null;
}

async function findAccessibleProfile(
  executor: DatabaseExecutor,
  actor: AgentActor,
  id: string,
): Promise<AgentProfile | null> {
  const [row] = await joinedProfiles(executor, actor).where(
    and(
      eq(agents.id, id),
      isNull(agentProfiles.deletedAt),
      accessFilter(actor),
    ),
  );
  return row ? mapProfile(row) : null;
}

async function lockProfileMutationRows(executor: DatabaseExecutor, id: string) {
  await executor
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, id))
    .for("update");
  await executor
    .select({ agentId: agentProfiles.agentId })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, id))
    .for("update");
}

/**
 * Share-lock a profile so it stays readable to concurrent callers but cannot be deleted or renamed
 * until this transaction ends. `lockProfileMutationRows` takes the exclusive counterpart, so a
 * deletion racing a reference blocks here instead of committing underneath it.
 */
async function lockProfileReadRow(executor: DatabaseExecutor, id: string) {
  await executor
    .select({ agentId: agentProfiles.agentId })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, id))
    .for("share");
}

function requireManageable(actor: AgentActor, profile: AgentProfile) {
  if (profile.systemOwned) throw new ProtectedAgentError(profile.id);
  if (!canManageAgent(actor, profile)) {
    throw new AgentNotManageableError(profile.id);
  }
}

function requireAvatarManageable(actor: AgentActor, profile: AgentProfile) {
  if (!canCustomizeAgentAvatar(actor, profile)) {
    throw new AgentNotManageableError(profile.id);
  }
}

function newAgentId() {
  return `agent_${crypto.randomUUID()}`;
}

/**
 * Which agent a token belongs to.
 *
 * Selected by hash and then compared in constant time. The lookup alone would be enough to identify
 * the row, and the comparison is what keeps a timing difference from confirming a partial guess
 * against an index.
 */
async function findByTokenHash(
  database: Database,
  hash: string,
): Promise<{ id: string } | null> {
  const rows = await database
    .select({
      agentId: agentProfiles.agentId,
      hash: agentProfiles.callbackTokenHash,
    })
    .from(agentProfiles)
    .where(
      and(
        eq(agentProfiles.callbackTokenHash, hash),
        isNull(agentProfiles.deletedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row?.hash) return null;
  return sameToken(row.hash, hash) ? { id: row.agentId } : null;
}

export function createAgentProfileStore(
  database: Database,
  managedAgentAgUiUrl: URL | undefined,
  /**
   * Where a customer agent's key is kept. Optional so a deployment without a vault still runs; an
   * agent with a key then simply cannot be created, which is better than storing it in the clear.
   */
  vault?: { store: CredentialStore; encryptionKey: string },
): AgentProfileStore {
  const managedConfiguration = managedAgentAgUiUrl
    ? { endpoint: managedAgentAgUiUrl.toString() }
    : undefined;

  return {
    async list(actor, hidden = false) {
      const rows = await joinedProfiles(database, actor).where(
        and(
          isNull(agentProfiles.deletedAt),
          accessFilter(actor),
          hidden
            ? isNotNull(agentPreferences.hiddenAt)
            : isNull(agentPreferences.hiddenAt),
        ),
      );
      return rows.map(mapProfile);
    },

    get(actor, id) {
      return findAccessibleProfile(database, actor, id);
    },

    async avatar(actor, id) {
      const profile = await findAccessibleProfile(database, actor, id);
      if (!profile) return null;
      const [row] = await database
        .select({ image: agentProfiles.avatarImage })
        .from(agentProfiles)
        .where(eq(agentProfiles.agentId, id))
        .limit(1);
      return row?.image ?? null;
    },

    async getWithin(executor, actor, id) {
      await lockProfileReadRow(executor, id);
      return findAccessibleProfile(executor, actor, id);
    },

    create(actor, input) {
      return database.transaction(async (transaction) => {
        const id = newAgentId();
        const endpoint = input.endpoint
          ? { endpoint: input.endpoint }
          : managedConfiguration;
        if (!endpoint) {
          throw new ManagedAgentUnavailableError();
        }
        await transaction.insert(agents).values({
          id,
          name: input.name,
          type: "remote_ag_ui",
          // Their endpoint if they gave one, ours if they did not. Validated before it reaches here;
          // see endpoint.ts for why a stored URL is a security decision and not a text field.
          //
          // The key, if there is one, goes to the vault and only its reference is stored here. See
          // auth-header.ts for why a bearer token must not sit next to the endpoint.
          configuration: {
            ...endpoint,
            ...(input.auth && vault
              ? {
                  auth: await storeAgentAuth({
                    store: vault.store,
                    encryptionKey: vault.encryptionKey,
                    agentId: id,
                    header: input.auth.header,
                    value: input.auth.value,
                    executor: transaction,
                  }),
                }
              : {}),
          },
        });
        await transaction.insert(agentProfiles).values({
          agentId: id,
          ownerUserId: actor.id,
          title: input.title,
          roleDescription: input.roleDescription,
          avatarSeed: id,
          visibility: input.visibility,
        });

        const profile = await findAccessibleProfile(transaction, actor, id);
        if (!profile) throw new AgentNotFoundError(id);
        return profile;
      });
    },

    update(actor, id, input) {
      return database.transaction(
        async (transaction) => {
          await lockProfileMutationRows(transaction, id);
          const profile = await findAccessibleProfile(transaction, actor, id);
          if (!profile) throw new AgentNotFoundError(id);
          requireManageable(actor, profile);

          const updatedAt = new Date();
          /**
           * The endpoint and the key change here too, not only at creation.
           *
           * The form sends both and the route validates both, so an edit that dropped them looked
           * like it had worked: the screen reported success and the Bot kept answering at the old
           * address, which is the worst way to move an endpoint. A key is replaced only when one is
           * supplied, because the form cannot show what is stored and sending nothing means "leave
           * it alone" rather than "remove it".
           */
          const [row] = await transaction
            .select({ configuration: agents.configuration })
            .from(agents)
            .where(eq(agents.id, id))
            .limit(1);
          const previous = (row?.configuration ?? {}) as Record<
            string,
            unknown
          >;
          const configuration = {
            ...previous,
            ...(input.endpoint ? { endpoint: input.endpoint } : {}),
            ...(input.auth && vault
              ? {
                  auth: await storeAgentAuth({
                    store: vault.store,
                    encryptionKey: vault.encryptionKey,
                    agentId: id,
                    header: input.auth.header,
                    value: input.auth.value,
                    // An agent that already has a live key is being edited, not
                    // first-created, so the vault rotates rather than inserting
                    // a second live row for the same agent id.
                    previousCredentialId: authFromConfiguration(
                      row?.configuration,
                    )?.credentialId,
                    executor: transaction,
                  }),
                }
              : {}),
          };

          /*
           * The key this one replaces is already retired, by the rotation above.
           *
           * `storeAgentAuth` locks the previous credential, revokes it and inserts the replacement
           * inside this transaction, so there is nothing left here to retire. A second revoke from
           * outside the transaction would wait on the row lock this transaction is holding and never
           * be released, because the transaction cannot commit until the call it is awaiting
           * returns: editing a Bot's key would hang until the statement timed out, and the timeout
           * would then be reported as a key that is still live.
           */
          await transaction
            .update(agents)
            .set({ name: input.name, configuration, updatedAt })
            .where(eq(agents.id, id));
          await transaction
            .update(agentProfiles)
            .set({
              title: input.title,
              roleDescription: input.roleDescription,
              visibility: input.visibility,
              updatedAt,
            })
            .where(eq(agentProfiles.agentId, id));

          const updated = await findAccessibleProfile(transaction, actor, id);
          if (!updated) throw new AgentNotFoundError(id);
          return updated;
        },
        { isolationLevel: "read committed" },
      );
    },

    setAvatar(actor, id, image) {
      return database.transaction(async (transaction) => {
        await lockProfileMutationRows(transaction, id);
        const profile = await findAccessibleProfile(transaction, actor, id);
        if (!profile) throw new AgentNotFoundError(id);
        requireAvatarManageable(actor, profile);

        await transaction
          .update(agentProfiles)
          .set({ avatarImage: image, updatedAt: new Date() })
          .where(eq(agentProfiles.agentId, id));

        const updated = await findAccessibleProfile(transaction, actor, id);
        if (!updated) throw new AgentNotFoundError(id);
        return updated;
      });
    },

    duplicate(actor, id) {
      return database.transaction(async (transaction) => {
        const source = await findAccessibleProfile(transaction, actor, id);
        if (!source) throw new AgentNotFoundError(id);
        const [sourceAvatar] = await transaction
          .select({ image: agentProfiles.avatarImage })
          .from(agentProfiles)
          .where(eq(agentProfiles.agentId, id))
          .limit(1);

        if (!managedConfiguration) {
          throw new ManagedAgentUnavailableError();
        }
        const duplicateId = newAgentId();
        await transaction.insert(agents).values({
          id: duplicateId,
          name: source.name,
          type: "remote_ag_ui",
          configuration: managedConfiguration,
        });
        await transaction.insert(agentProfiles).values({
          agentId: duplicateId,
          ownerUserId: actor.id,
          title: source.title,
          roleDescription: source.roleDescription,
          avatarSeed: source.avatarSeed,
          avatarImage: sourceAvatar?.image,
          visibility: "private",
        });

        const duplicate = await findAccessibleProfile(
          transaction,
          actor,
          duplicateId,
        );
        if (!duplicate) throw new AgentNotFoundError(duplicateId);
        return duplicate;
      });
    },

    setHidden(actor, id, hidden) {
      return database.transaction(async (transaction) => {
        const profile = await findAccessibleProfile(transaction, actor, id);
        if (!profile) throw new AgentNotFoundError(id);

        await transaction
          .insert(agentPreferences)
          .values({
            userId: actor.id,
            agentId: id,
            hiddenAt: hidden ? new Date() : null,
          })
          .onConflictDoUpdate({
            target: [agentPreferences.userId, agentPreferences.agentId],
            set: { hiddenAt: hidden ? new Date() : null },
          });
      });
    },

    softDelete(actor, id) {
      return database.transaction(
        async (transaction) => {
          await lockProfileMutationRows(transaction, id);
          const profile = await findAccessibleProfile(transaction, actor, id);
          if (!profile) throw new AgentNotFoundError(id);
          requireManageable(actor, profile);

          const deletedAt = new Date();
          await transaction
            .update(agentProfiles)
            .set({ deletedAt, updatedAt: deletedAt })
            .where(eq(agentProfiles.agentId, id));

          /*
           * And its key stops working.
           *
           * A deleted Bot left its credential in the vault, decryptable and still valid, with
           * nothing listing it and no screen able to reach it: deleting the Bot was the last chance
           * anybody had to retire it. The profile is a soft delete, deliberately, but the key is not
           * something to keep pending an undelete that would ask for a new one anyway.
           */
          if (vault) {
            const [row] = await transaction
              .select({ configuration: agents.configuration })
              .from(agents)
              .where(eq(agents.id, id))
              .limit(1);
            await retireReplacedKey(
              vault.store,
              (row?.configuration ?? {}) as Record<string, unknown>,
              {},
              // In this transaction, so the key is retired exactly when the deletion is. On its own
              // connection the revoke would commit even where the delete rolled back, leaving a Bot
              // that still exists and can no longer reach its endpoint.
              transaction,
            );
          }
        },
        { isolationLevel: "read committed" },
      );
    },

    issueCallbackToken(actor, id) {
      return database.transaction(
        async (transaction) => {
          await lockProfileMutationRows(transaction, id);
          const profile = await findAccessibleProfile(transaction, actor, id);
          if (!profile) throw new AgentNotFoundError(id);
          /*
           * Whoever may change the agent may credential it.
           *
           * The same gate as renaming it or repointing its endpoint, and repointing the endpoint is
           * the more dangerous of the two: it decides which process the token is for.
           */
          requireManageable(actor, profile);

          const token = mintCallbackToken();
          const issuedAt = new Date();
          await transaction
            .update(agentProfiles)
            .set({
              callbackTokenHash: hashCallbackToken(token),
              callbackTokenIssuedAt: issuedAt,
              updatedAt: issuedAt,
            })
            .where(eq(agentProfiles.agentId, id));

          // The only time it is readable. Nothing here writes it to a log.
          return token;
        },
        { isolationLevel: "read committed" },
      );
    },

    revokeCallbackToken(actor, id) {
      return database.transaction(
        async (transaction) => {
          await lockProfileMutationRows(transaction, id);
          const profile = await findAccessibleProfile(transaction, actor, id);
          if (!profile) throw new AgentNotFoundError(id);
          requireManageable(actor, profile);

          const now = new Date();
          await transaction
            .update(agentProfiles)
            .set({
              callbackTokenHash: null,
              callbackTokenIssuedAt: null,
              updatedAt: now,
            })
            .where(eq(agentProfiles.agentId, id));
        },
        { isolationLevel: "read committed" },
      );
    },

    agentForCallbackToken(hash) {
      return findByTokenHash(database, hash);
    },
  };
}

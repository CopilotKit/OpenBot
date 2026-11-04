/**
 * Better Auth's writes to a person, carried to Intelligence's organization directory.
 *
 * Better Auth owns sign-in: it makes a person the first time they arrive, writes the name and picture
 * an identity provider sends, verifies an address, and its SCIM plugin writes a person's directory
 * groups. It does all of that through its database adapter, often inside a transaction of its own (the
 * SCIM plugin's, or a first sign-in that makes the person and their account together). People live in
 * Intelligence now (people/directory), and an Intelligence call must never be made with an OpenBot
 * transaction open.
 *
 * So this wraps the adapter, as encrypt-sso-config.ts does, and changes nothing about what Better Auth
 * stores. A write to a person marks their row pending (`directoryPending`, in the same statement);
 * once the write has committed (at once outside a transaction, after the commit inside one) the person
 * is pushed to Intelligence. A push that fails leaves the row pending, and the directory's sweep pushes
 * it again. A sign-in account added or removed changes the identities the person signs in with, so it
 * marks the person pending too. An enterprise identity provider Better Auth's SSO plugin registers,
 * changes or removes is described to the directory the same way, after the write commits; its client
 * secret or signing certificate stays in this deployment's `sso_providers` row.
 *
 * Chosen over Better Auth's database hooks because the SCIM plugin writes a person's groups through the
 * adapter directly, where no hook runs, and over a custom adapter for the `user` model because every
 * read of a person (the session's, on every request) would then have to leave this database.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { PeopleDirectory } from "../people/directory/directory";

type Rowish = Record<string, unknown>;
type Where = { field: string; value: unknown; operator?: string }[];

type AdapterLike = {
  create: (data: never) => Promise<unknown>;
  update: (data: never) => Promise<unknown>;
  delete: (data: never) => Promise<unknown>;
  findMany: (data: never) => Promise<unknown>;
};

type RowishAdapter = {
  create: (data: Rowish) => Promise<Rowish | null>;
  update: (data: Rowish) => Promise<Rowish | null>;
  updateMany?: (data: Rowish) => Promise<unknown>;
  delete: (data: Rowish) => Promise<unknown>;
  deleteMany?: (data: Rowish) => Promise<unknown>;
  findMany: (data: Rowish) => Promise<Rowish[]>;
  transaction?: <T>(callback: (trx: RowishAdapter) => Promise<T>) => Promise<T>;
};

/** An identity provider as the directory describes it: never its secret. */
type ProviderRecord = {
  providerId: string;
  issuer: string;
  domain: string;
  protocol: "oidc" | "saml";
  registeredBy: string | null;
};

/** What a stretch of writes left for after it commits. */
type Afterwards = {
  push: Set<string>;
  purge: Set<string>;
  sweep: boolean;
  providers: Map<string, ProviderRecord | null>;
};

const PERSON = "user";
const ACCOUNT = "account";
const PROVIDER = "ssoProvider";

const afterwards = (): Afterwards => ({
  push: new Set(),
  purge: new Set(),
  sweep: false,
  providers: new Map(),
});

function providerRecord(row: Rowish | null | undefined): ProviderRecord | null {
  if (!row || typeof row.providerId !== "string") return null;
  return {
    providerId: row.providerId,
    issuer: String(row.issuer ?? ""),
    domain: String(row.domain ?? "").toLowerCase(),
    // A row carries one config or the other, and which one is the protocol.
    protocol: row.samlConfig ? "saml" : "oidc",
    registeredBy: typeof row.userId === "string" ? row.userId : null,
  };
}

/** What code running inside one of Better Auth's transactions asked to do once it commits. */
const afterCommit = new AsyncLocalStorage<Array<() => Promise<void>>>();

/**
 * Run `work` once the Better Auth transaction this is called from has committed, before Better Auth
 * answers the request; at once when called outside one. For a hook Better Auth runs inside its
 * transaction (the SCIM plugin's) that has to tell Intelligence something: no OpenBot transaction is
 * held open across the call, and the request still does not answer before it is done. A failure is
 * the request's failure, so the caller (a directory, say) sends it again.
 */
export async function afterPeopleCommit(
  work: () => Promise<void>,
): Promise<void> {
  const queued = afterCommit.getStore();
  if (queued) queued.push(work);
  else await work();
}

/** Run everything queued, all of it even when one fails; then raise the first failure. */
async function runQueued(queued: Array<() => Promise<void>>): Promise<void> {
  let failure: unknown;
  for (const work of queued) {
    try {
      await work();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

export function projectPeopleToDirectory<Options, Adapter extends AdapterLike>(
  createAdapter: (options: Options) => Adapter,
  directory: () => PeopleDirectory | undefined,
): (options: Options) => Adapter {
  return (options) =>
    wrap(
      createAdapter(options) as unknown as RowishAdapter,
      directory,
      null,
    ) as unknown as Adapter;
}

/** Run what a committed stretch of writes left. Never throws: the writes it follows have committed. */
async function settle(
  directory: PeopleDirectory | undefined,
  work: Afterwards,
): Promise<void> {
  if (!directory) return;
  for (const [providerId, record] of work.providers) {
    try {
      if (record)
        await directory.client.putIdentityProvider(
          record,
          `openbot-directory:identity-provider:${createHash("sha256").update(JSON.stringify(record)).digest("hex")}`,
        );
      else
        await directory.client.deleteIdentityProvider(
          providerId,
          `openbot-directory:identity-provider-removed:${createHash("sha256").update(providerId).digest("hex")}`,
        );
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "directory-identity-provider-write-failed",
          providerId,
          note: "The provider is registered here and signs people in; Intelligence's directory will learn of it when the Identity providers screen is next opened.",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  for (const id of work.purge) {
    try {
      await directory.client.purgePerson(
        id,
        `openbot-directory:purge:${createHash("sha256").update(id).digest("hex")}`,
      );
      // Better Auth removed the row itself, so no full read will: the listeners hear it from here.
      await directory.purged(id);
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "directory-purge-failed",
          personId: id,
          note: "Better Auth deleted this person here, and Intelligence could not be told. The next full read brings them back; delete them again.",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  for (const id of work.push) {
    if (work.purge.has(id)) continue;
    try {
      await directory.push(id);
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "directory-push-failed",
          personId: id,
          note: "The person is saved here and stays pending; the directory's sweep pushes them again.",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  if (work.sweep) void directory.pushPending();
}

function wrap(
  inner: RowishAdapter,
  directory: () => PeopleDirectory | undefined,
  /** The transaction's list, inside one. Null outside: then each write settles as soon as it is made. */
  inTransaction: Afterwards | null,
): RowishAdapter {
  const done = async (work: Afterwards) => {
    if (inTransaction) {
      for (const id of work.push) inTransaction.push.add(id);
      for (const id of work.purge) inTransaction.purge.add(id);
      inTransaction.sweep ||= work.sweep;
      for (const [id, record] of work.providers)
        inTransaction.providers.set(id, record);
      return;
    }
    await settle(directory(), work);
  };

  /** Mark the people these sign-in accounts belong to as pending, in the same stretch of writes. */
  const touchOwners = async (
    self: RowishAdapter,
    userIds: Iterable<string>,
  ) => {
    for (const userId of new Set(userIds))
      await self.update({
        model: PERSON,
        where: [{ field: "id", value: userId }],
        update: { directoryPending: true },
      });
  };

  const providersChanged = async (rows: (Rowish | null | undefined)[]) => {
    const work = afterwards();
    for (const row of rows) {
      const record = providerRecord(row);
      if (record) work.providers.set(record.providerId, record);
    }
    await done(work);
  };

  const providersRemoved = async (rows: Rowish[]) => {
    const work = afterwards();
    for (const row of rows)
      if (typeof row.providerId === "string")
        work.providers.set(row.providerId, null);
    await done(work);
  };

  const wrapTransaction =
    (begin: NonNullable<RowishAdapter["transaction"]>) =>
    async <T>(callback: (trx: RowishAdapter) => Promise<T>): Promise<T> => {
      // Nested: the outer stretch settles everything once it commits.
      if (inTransaction)
        return begin((trx) => callback(wrap(trx, directory, inTransaction)));
      const work = afterwards();
      const queued: Array<() => Promise<void>> = [];
      const result = await afterCommit.run(queued, () =>
        begin((trx) => callback(wrap(trx, directory, work))),
      );
      // Committed: only now is Intelligence told.
      await settle(directory(), work);
      await runQueued(queued);
      return result;
    };

  const self: RowishAdapter = {
    ...inner,

    async create(data) {
      if (data.model === PERSON) {
        const created = await inner.create({
          ...data,
          data: { ...(data.data as Rowish), directoryPending: true },
        });
        const id = created?.id;
        if (typeof id === "string") {
          const work = afterwards();
          work.push.add(id);
          await done(work);
        }
        return created;
      }
      const created = await inner.create(data);
      if (data.model === ACCOUNT && typeof created?.userId === "string")
        await touchOwners(self, [created.userId]);
      if (data.model === PROVIDER) await providersChanged([created]);
      return created;
    },

    async update(data) {
      if (data.model === PROVIDER) {
        const updated = await inner.update(data);
        await providersChanged([updated]);
        return updated;
      }
      if (data.model !== PERSON) return inner.update(data);
      const updated = await inner.update({
        ...data,
        update: { ...(data.update as Rowish), directoryPending: true },
      });
      const work = afterwards();
      if (typeof updated?.id === "string") work.push.add(updated.id);
      else work.sweep = true;
      await done(work);
      return updated;
    },

    ...(inner.updateMany
      ? {
          async updateMany(data: Rowish) {
            if (data.model !== PERSON) return inner.updateMany?.(data);
            const count = await inner.updateMany?.({
              ...data,
              update: { ...(data.update as Rowish), directoryPending: true },
            });
            const work = afterwards();
            work.sweep = true;
            await done(work);
            return count;
          },
        }
      : {}),

    async delete(data) {
      if (data.model === ACCOUNT) {
        const owners = await ownersOf(inner, data.where as Where);
        const result = await inner.delete(data);
        await touchOwners(self, owners);
        return result;
      }
      if (data.model === PROVIDER) {
        const removed = await inner.findMany({
          model: PROVIDER,
          where: data.where,
        });
        const result = await inner.delete(data);
        await providersRemoved(removed);
        return result;
      }
      if (data.model !== PERSON) return inner.delete(data);
      const ids = await idsOf(inner, PERSON, data.where as Where);
      const result = await inner.delete(data);
      const work = afterwards();
      for (const id of ids) work.purge.add(id);
      await done(work);
      return result;
    },

    ...(inner.deleteMany
      ? {
          async deleteMany(data: Rowish) {
            if (data.model === ACCOUNT) {
              const owners = await ownersOf(inner, data.where as Where);
              const result = await inner.deleteMany?.(data);
              await touchOwners(self, owners);
              return result;
            }
            if (data.model !== PERSON) return inner.deleteMany?.(data);
            const ids = await idsOf(inner, PERSON, data.where as Where);
            const result = await inner.deleteMany?.(data);
            const work = afterwards();
            for (const id of ids) work.purge.add(id);
            await done(work);
            return result;
          },
        }
      : {}),

    ...(inner.transaction
      ? { transaction: wrapTransaction(inner.transaction) }
      : {}),
  };
  return self;
}

async function idsOf(
  adapter: RowishAdapter,
  model: string,
  where: Where,
): Promise<string[]> {
  const rows = await adapter.findMany({ model, where });
  return rows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string");
}

async function ownersOf(
  adapter: RowishAdapter,
  where: Where,
): Promise<string[]> {
  const rows = await adapter.findMany({ model: ACCOUNT, where });
  return rows
    .map((row) => row.userId)
    .filter((id): id is string => typeof id === "string");
}

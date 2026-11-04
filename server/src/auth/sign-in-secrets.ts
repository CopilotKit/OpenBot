/**
 * The secrets Better Auth keeps for signing people in, held in Intelligence's vault.
 *
 * Better Auth stores, on a person's sign-in account, the access, refresh and ID tokens their identity
 * provider granted and the hash of their password; and, on an enterprise identity provider the SSO
 * plugin registered, its OIDC configuration (with the client secret for the company's directory) or
 * its SAML configuration (with its signing material). Every other secret this deployment keeps is in
 * the vault, under the organization's key, read back only by a recorded reveal (vault/), so these are
 * too: each value is a vault secret, and the column holds only a reference to it (`vault:<id>`).
 *
 * The seam is the adapter, as for the people (directory-adapter.ts): Better Auth reads and writes
 * every row through one, so wrapping it catches every path a value takes, the plugins' included. A
 * write stores the value in the vault first and the reference in the row; a changed value is stored
 * as a new secret that replaces the old one in the same step (the vault revokes it); a row removed
 * revokes its secrets. A read reveals each referenced value, in this server only, with the person it
 * belongs to named for the vault's access trail; the directory keeps a revealed value for a few
 * minutes, so a busy sign-in does not ask the vault for each request. Better Auth gets back exactly
 * what it wrote: the tokens it encrypted with its own secret, the hash it made, the configuration JSON.
 *
 * A value written before this (still in the column, or encrypted with `KEY_ENCRYPTION_KEY` as the
 * identity provider configurations were) is read as it is, and moved into the vault at boot by
 * sign-in-secrets-upgrade.ts.
 *
 * With no vault installed (a test that builds Better Auth alone) the values pass through untouched, as
 * the people do with no directory: the server installs the vault at boot, before Better Auth is made.
 *
 * No Better Auth transaction holds a database transaction open across the vault: the adapter is built
 * with `transaction: false` (auth/index.ts), so its `transaction` runs the callback on this adapter.
 */
import { randomUUID } from "node:crypto";
import { decryptSecret } from "../credentials";
import {
  SecretMissingError,
  SecretRevokedError,
  type SecretKind,
  type StoredSecret,
} from "../vault/client";
import type { ConnectionsDirectory } from "../vault/directory";

type Rowish = Record<string, unknown>;

type AdapterLike = {
  create: (data: never) => Promise<unknown>;
  update: (data: never) => Promise<unknown>;
  findOne: (data: never) => Promise<unknown>;
  findMany: (data: never) => Promise<unknown>;
};

type RowishAdapter = {
  create?: (data: Rowish) => Promise<unknown>;
  update?: (data: Rowish) => Promise<unknown>;
  updateMany?: (data: Rowish) => Promise<unknown>;
  delete?: (data: Rowish) => Promise<unknown>;
  deleteMany?: (data: Rowish) => Promise<unknown>;
  findOne?: (data: Rowish) => Promise<unknown>;
  findMany?: (data: Rowish) => Promise<unknown>;
  transaction?: <T>(callback: (trx: unknown) => Promise<T>) => Promise<T>;
};

/** What every sign-in secret carries in its metadata, so nothing else takes it for a credential. */
export const SIGN_IN_METADATA = "signIn";

/** Whether a vault secret is one of Better Auth's, rather than a credential, an app's or a login. */
export function isSignInSecret(
  secret: Pick<StoredSecret, "metadata">,
): boolean {
  return secret.metadata[SIGN_IN_METADATA] === true;
}

/** The fields this keeps in the vault, per model, and the kind of secret each is. */
export const SIGN_IN_FIELDS = {
  account: {
    accessToken: "mcp_user_token",
    refreshToken: "mcp_user_token",
    idToken: "mcp_user_token",
    password: "password_hash",
  },
  ssoProvider: {
    oidcConfig: "mcp_oauth_client",
    samlConfig: "mcp_oauth_client",
  },
} as const satisfies Record<string, Record<string, SecretKind>>;

type Model = keyof typeof SIGN_IN_FIELDS;

const REFERENCE = "vault:";

export function isVaultReference(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(REFERENCE);
}

export const vaultReference = (secretId: string) => `${REFERENCE}${secretId}`;

const secretIdOf = (reference: unknown) =>
  String(reference).slice(REFERENCE.length);

function isModel(model: unknown): model is Model {
  return typeof model === "string" && model in SIGN_IN_FIELDS;
}

function fieldsOf(model: Model): [string, SecretKind][] {
  return Object.entries(SIGN_IN_FIELDS[model]) as [string, SecretKind][];
}

/**
 * Who a row's secrets belong to and what the vault files them under. A person's account is theirs,
 * by provider; an identity provider is the deployment's.
 */
function ownerOf(model: Model, row: Rowish): string | null {
  return model === "account" && typeof row.userId === "string"
    ? row.userId
    : null;
}

function providerOf(model: Model, row: Rowish): string {
  return `sign-in:${model}:${String(row.providerId ?? "unknown")}`;
}

/** What `KEY_ENCRYPTION_KEY` produced for an identity provider's configuration, before the vault. */
function isLegacyEnvelope(value: string): boolean {
  return value.startsWith('{"version":1');
}

/**
 * Store one value, as a new secret, replacing `previous` (a reference already in the row) when it is a
 * live secret of the same name: the vault revokes it in the same step.
 */
export async function storeSignInSecret(
  vault: ConnectionsDirectory,
  model: Model,
  field: string,
  row: Rowish,
  value: string,
  options: { id?: string; name?: string; previous?: unknown } = {},
): Promise<string> {
  const kind = (SIGN_IN_FIELDS[model] as Record<string, SecretKind>)[field];
  if (!kind) throw new Error(`${model}.${field} is not a sign-in secret.`);
  const previous = isVaultReference(options.previous)
    ? vault.peekSecret(secretIdOf(options.previous))
    : undefined;
  const replaces =
    previous && previous.revokedAt === null ? previous : undefined;
  const created = await vault.createSecret({
    id: options.id ?? randomUUID(),
    kind,
    provider: replaces?.provider ?? providerOf(model, row),
    keyId: replaces?.keyId ?? options.name ?? `${randomUUID()}:${field}`,
    ownerUserId: replaces?.ownerUserId ?? ownerOf(model, row),
    metadata: { [SIGN_IN_METADATA]: true, model, field },
    plaintext: value,
    ...(replaces ? { replaces: replaces.id } : {}),
  });
  return vaultReference(created.id);
}

/** Revoke what a reference names; gone or revoked already is what was wanted. */
async function revokeReference(
  vault: ConnectionsDirectory,
  reference: unknown,
): Promise<void> {
  if (!isVaultReference(reference)) return;
  try {
    await vault.revokeSecret(secretIdOf(reference));
  } catch (error) {
    if (
      error instanceof SecretMissingError ||
      error instanceof SecretRevokedError
    )
      return;
    throw error;
  }
}

/** Put each value a write carries in the vault, and the reference in its place. */
async function toVault(
  vault: ConnectionsDirectory,
  model: Model,
  values: Rowish,
  row: Rowish,
  current: Rowish | null,
): Promise<{ values: Rowish; retired: unknown[] }> {
  const next = { ...values };
  const retired: unknown[] = [];
  for (const [field] of fieldsOf(model)) {
    if (!(field in values)) continue;
    const value = values[field];
    const before = current?.[field];
    if (typeof value === "string" && value && !isVaultReference(value)) {
      next[field] = await storeSignInSecret(vault, model, field, row, value, {
        previous: before,
      });
    } else if (value === null || value === undefined || value === "") {
      // Cleared: what the row named goes with it.
      retired.push(before);
    }
  }
  return { values: next, retired };
}

/** A row as Better Auth wrote it: each referenced value revealed, in this server only. */
async function fromVault<T>(
  vault: ConnectionsDirectory,
  model: Model,
  row: T,
  legacyKey: string,
): Promise<T> {
  if (!row || typeof row !== "object") return row;
  const next = { ...(row as Rowish) };
  for (const [field] of fieldsOf(model)) {
    const value = next[field];
    if (typeof value !== "string" || !value) continue;
    if (isVaultReference(value)) {
      try {
        next[field] = (
          await vault.reveal(secretIdOf(value), {
            purpose:
              model === "account" ? "sign_in" : "identity_provider_sign_in",
            userId: ownerOf(model, next),
          })
        ).value;
      } catch (error) {
        if (
          !(error instanceof SecretMissingError) &&
          !(error instanceof SecretRevokedError)
        )
          throw error;
        // A value nobody can spend: the honest answer is none, which Better Auth reads as not set.
        console.error(
          JSON.stringify({
            type: "sign-in-secret-unavailable",
            model,
            field,
            note: "The row names a vault secret that is revoked or gone. Signing in with it fails until it is set again.",
          }),
        );
        next[field] = null;
      }
    } else if (model === "ssoProvider" && isLegacyEnvelope(value)) {
      // Written under KEY_ENCRYPTION_KEY before the vault; the boot copy moves it.
      try {
        next[field] = await decryptSecret(legacyKey, value);
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "sso-config-decrypt-failed",
            field,
            note: "The stored identity provider config cannot be read with this KEY_ENCRYPTION_KEY. Sign-in through that provider will fail until it is re-registered.",
            error: String(error),
          }),
        );
        next[field] = null;
      }
    }
  }
  return next as T;
}

function touches(model: Model, values: unknown): boolean {
  if (!values || typeof values !== "object") return false;
  return fieldsOf(model).some(([field]) => field in (values as Rowish));
}

/**
 * Wrap an adapter factory so Better Auth's sign-in secrets live in the vault. `vault` is read on every
 * call: undefined passes everything through.
 */
export function keepSignInSecretsInVault<Options, Adapter extends AdapterLike>(
  createAdapter: (options: Options) => Adapter,
  vault: () => ConnectionsDirectory | undefined,
  legacyKey: string,
): (options: Options) => Adapter {
  return (options) => wrap(createAdapter(options), vault, legacyKey);
}

function wrap<T extends AdapterLike>(
  adapter: T,
  vaultOf: () => ConnectionsDirectory | undefined,
  legacyKey: string,
): T {
  const inner = adapter as unknown as RowishAdapter;
  const reveal = async (model: Model, result: unknown) => {
    const vault = vaultOf();
    if (!vault) return result;
    if (Array.isArray(result))
      return Promise.all(
        result.map((row) => fromVault(vault, model, row, legacyKey)),
      );
    return fromVault(vault, model, result, legacyKey);
  };
  /** The rows a where clause names, as stored (references, not values). */
  const rowsAt = async (model: Model, where: unknown): Promise<Rowish[]> =>
    ((await inner.findMany?.({ model, where })) as Rowish[] | null) ?? [];

  const wrapped: RowishAdapter = {
    ...(adapter as unknown as RowishAdapter),

    create: async (data) => {
      const model = data.model;
      const vault = vaultOf();
      if (!isModel(model) || !vault) return inner.create?.(data);
      const values = (data.data ?? {}) as Rowish;
      const stored = await toVault(vault, model, values, values, null);
      try {
        return await reveal(
          model,
          await inner.create?.({ ...data, data: stored.values }),
        );
      } catch (error) {
        // The row was not written: what was stored for it goes again.
        for (const [field] of fieldsOf(model))
          if (stored.values[field] !== values[field])
            await revokeReference(vault, stored.values[field]).catch(
              () => undefined,
            );
        throw error;
      }
    },

    update: async (data) => {
      const model = data.model;
      const vault = vaultOf();
      if (!isModel(model) || !vault) return inner.update?.(data);
      if (!touches(model, data.update))
        return reveal(model, await inner.update?.(data));
      const [current] = await rowsAt(model, data.where);
      const row = { ...(current ?? {}), ...(data.update as Rowish) };
      const stored = await toVault(
        vault,
        model,
        data.update as Rowish,
        row,
        current ?? null,
      );
      const result = await inner.update?.({ ...data, update: stored.values });
      for (const reference of stored.retired)
        await revokeReference(vault, reference);
      return reveal(model, result);
    },

    findOne: async (data) => {
      const result = await inner.findOne?.(data);
      return isModel(data.model) ? reveal(data.model, result) : result;
    },

    findMany: async (data) => {
      const result = await inner.findMany?.(data);
      return isModel(data.model) ? reveal(data.model, result) : result;
    },
  };

  if (inner.updateMany) {
    wrapped.updateMany = async (data) => {
      const model = data.model;
      const vault = vaultOf();
      if (!isModel(model) || !vault || !touches(model, data.update))
        return inner.updateMany?.(data);
      // One row at a time, so each keeps a secret of its own.
      const rows = await rowsAt(model, data.where);
      for (const current of rows) {
        const row = { ...current, ...(data.update as Rowish) };
        const stored = await toVault(
          vault,
          model,
          data.update as Rowish,
          row,
          current,
        );
        await inner.update?.({
          model,
          where: [{ field: "id", value: current.id }],
          update: stored.values,
        });
        for (const reference of stored.retired)
          await revokeReference(vault, reference);
      }
      return rows.length;
    };
  }

  for (const method of ["delete", "deleteMany"] as const) {
    const remove = inner[method];
    if (!remove) continue;
    wrapped[method] = async (data) => {
      const model = data.model;
      const vault = vaultOf();
      if (!isModel(model) || !vault) return remove(data);
      const rows = await rowsAt(model, data.where);
      const result = await remove(data);
      // Removed: every secret the rows named is revoked, after the rows are gone.
      for (const row of rows)
        for (const [field] of fieldsOf(model))
          await revokeReference(vault, row[field]);
      return result;
    };
  }

  const transaction = inner.transaction;
  if (typeof transaction === "function") {
    wrapped.transaction = <R>(callback: (trx: unknown) => Promise<R>) =>
      transaction.call(adapter, (trx: unknown) =>
        callback(wrap(trx as AdapterLike, vaultOf, legacyKey)),
      ) as Promise<R>;
  }

  return wrapped as unknown as T;
}

/**
 * Every sign-in secret a person holds, for good: when the person is purged, their accounts go with
 * their row by the foreign key, and this takes the secrets those accounts named.
 */
export async function purgeSignInSecretsOf(
  vault: Pick<ConnectionsDirectory, "secrets" | "purgeSecret">,
  userId: string,
): Promise<number> {
  let purged = 0;
  for (const secret of vault.secrets())
    if (isSignInSecret(secret) && secret.ownerUserId === userId) {
      await vault.purgeSecret(secret.id);
      purged += 1;
    }
  return purged;
}

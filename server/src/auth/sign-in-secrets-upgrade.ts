/**
 * Moving the sign-in secrets an existing deployment holds into Intelligence's vault, once, at boot.
 *
 * Before this release Better Auth kept them in its own columns: a person's provider tokens (encrypted
 * with Better Auth's secret) and password hash on `accounts`, and a company identity provider's
 * configuration on `sso_providers` (encrypted with `KEY_ENCRYPTION_KEY`, or plaintext from before
 * that). Each value is stored as a vault secret, the identity provider configuration decrypted with the
 * local key first, and the column is set to the reference (sign-in-secrets.ts), only where it still
 * holds the value read. Then the copy is verified BY COUNT: no column may still hold a value, and the
 * vault must hold every secret a column names. Only then is it recorded as done.
 *
 * SAFE TO RUN ANY NUMBER OF TIMES, FROM ANY NUMBER OF REPLICAS AT ONCE: under a lease
 * (`vault/leases.ts`) the replicas take turns, each secret's id is made from its row and field so a
 * second attempt finds it stored, and a column already holding a reference is left alone.
 *
 * LOUD ON A MISMATCH: a value the vault refuses, a configuration the local key cannot decrypt, or a
 * reference the vault does not hold stops the boot with what is wrong named, never a secret.
 */
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { decryptSecret } from "../credentials";
import type { Database } from "../db/client";
import { accounts, intelligenceCopies, ssoProviders } from "../db/schema";
import { SecretAlreadyExistsError } from "../vault/client";
import type { ConnectionsDirectory } from "../vault/directory";
import { holdSecretLease } from "../vault/leases";
import {
  isVaultReference,
  SIGN_IN_FIELDS,
  storeSignInSecret,
  vaultReference,
} from "./sign-in-secrets";

export const SIGN_IN_SECRETS_COPY_NAME = "sign-in-secrets";

export class SignInSecretsCopyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInSecretsCopyMismatchError";
  }
}

type Outcome =
  | { kind: "done-before" }
  | { kind: "copied"; moved: number; held: number };

/** A vault id made from the row and field: the same on every replica and every attempt. */
function secretIdFor(model: string, rowId: string, field: string): string {
  return `sign-in-${createHash("sha256").update(`${model}\n${rowId}\n${field}`).digest("hex").slice(0, 48)}`;
}

async function done(database: Database): Promise<boolean> {
  const [row] = await database
    .select({ name: intelligenceCopies.name })
    .from(intelligenceCopies)
    .where(eq(intelligenceCopies.name, SIGN_IN_SECRETS_COPY_NAME))
    .limit(1);
  return row !== undefined;
}

const ACCOUNT_FIELDS = Object.keys(SIGN_IN_FIELDS.account) as Array<
  keyof typeof SIGN_IN_FIELDS.account
>;
const PROVIDER_FIELDS = Object.keys(SIGN_IN_FIELDS.ssoProvider) as Array<
  keyof typeof SIGN_IN_FIELDS.ssoProvider
>;

/** Every value the columns still hold, and every reference they name. */
async function census(database: Database) {
  const accountRows = await database.select().from(accounts);
  const providerRows = await database.select().from(ssoProviders);
  const values: string[] = [];
  const references: string[] = [];
  const sort = (where: string, value: string | null) => {
    if (!value) return;
    if (isVaultReference(value)) references.push(value.slice("vault:".length));
    else values.push(where);
  };
  for (const row of accountRows)
    for (const field of ACCOUNT_FIELDS)
      sort(`account ${row.id} ${field}`, row[field]);
  for (const row of providerRows)
    for (const field of PROVIDER_FIELDS)
      sort(`identity provider ${row.providerId} ${field}`, row[field]);
  return { accountRows, providerRows, values, references };
}

async function store(
  vault: ConnectionsDirectory,
  model: "account" | "ssoProvider",
  field: string,
  row: Record<string, unknown>,
  rowId: string,
  value: string,
): Promise<string> {
  const id = secretIdFor(model, rowId, field);
  try {
    return await storeSignInSecret(vault, model, field, row, value, {
      id,
      name: `${rowId}:${field}`,
    });
  } catch (error) {
    // A replica, or an attempt that stopped before writing the column, stored it already.
    if (error instanceof SecretAlreadyExistsError) return vaultReference(id);
    throw error;
  }
}

export async function copySignInSecretsToVault(
  database: Database,
  vault: ConnectionsDirectory,
  keyEncryptionKey: string,
): Promise<Outcome> {
  if (await done(database)) return { kind: "done-before" };
  const lease = await holdSecretLease(database, "upgrade-copy:sign-in", {
    ttlMs: 10 * 60_000,
    waitMs: 10 * 60_000,
  });
  try {
    if (await done(database)) return { kind: "done-before" };
    const { accountRows, providerRows } = await census(database);
    const refused: string[] = [];
    let moved = 0;

    for (const row of accountRows) {
      for (const field of ACCOUNT_FIELDS) {
        const value = row[field];
        if (!value || isVaultReference(value)) continue;
        try {
          const reference = await store(
            vault,
            "account",
            field,
            row,
            row.id,
            value,
          );
          await database
            .update(accounts)
            .set({ [field]: reference })
            .where(and(eq(accounts.id, row.id), eq(accounts[field], value)));
          moved += 1;
        } catch (error) {
          refused.push(
            `account ${row.id} ${field}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    for (const row of providerRows) {
      for (const field of PROVIDER_FIELDS) {
        const value = row[field];
        if (!value || isVaultReference(value)) continue;
        try {
          // Encrypted with KEY_ENCRYPTION_KEY since that was added; plaintext from before it.
          const plaintext = value.startsWith('{"version":1')
            ? await decryptSecret(keyEncryptionKey, value)
            : value;
          const reference = await store(
            vault,
            "ssoProvider",
            field,
            row,
            row.providerId,
            plaintext,
          );
          await database
            .update(ssoProviders)
            .set({ [field]: reference })
            .where(
              and(
                eq(ssoProviders.providerId, row.providerId),
                eq(ssoProviders[field], value),
              ),
            );
          moved += 1;
        } catch (error) {
          refused.push(
            `identity provider ${row.providerId} ${field}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    if (refused.length > 0)
      throw new SignInSecretsCopyMismatchError(
        `${refused.length} sign-in secrets were not moved into Intelligence's vault, and this server will not start without them:\n${refused.join("\n")}`,
      );

    // Verified by count: nothing left in a column, and every reference held by the vault.
    const after = await census(database);
    if (after.values.length > 0)
      throw new SignInSecretsCopyMismatchError(
        `${after.values.length} sign-in secrets are still in this deployment's columns after the copy: ${after.values.join(", ")}`,
      );
    const { secrets } = await vault.client.secrets.all({
      includeRevoked: true,
    });
    const held = new Set(secrets.map((secret) => secret.id));
    const missing = after.references.filter((id) => !held.has(id));
    if (missing.length > 0)
      throw new SignInSecretsCopyMismatchError(
        `${after.references.length} sign-in secrets are named by this deployment and ${after.references.length - missing.length} are in Intelligence's vault. Missing: ${missing.join(", ")}`,
      );
    await database
      .insert(intelligenceCopies)
      .values({
        name: SIGN_IN_SECRETS_COPY_NAME,
        copied: after.references.length,
      })
      .onConflictDoNothing();
    console.info(
      JSON.stringify({
        type: "sign-in-secrets-copied-to-intelligence",
        moved,
        held: after.references.length,
      }),
    );
    return { kind: "copied", moved, held: after.references.length };
  } finally {
    await lease.release();
  }
}

/** For a test: how many values the sign-in columns still hold. */
export async function signInValuesLeft(database: Database): Promise<number> {
  const [row] = await database.execute<{ left: number }>(sql`
    select (
      (select count(*) from accounts where access_token is not null and access_token not like 'vault:%')
      + (select count(*) from accounts where refresh_token is not null and refresh_token not like 'vault:%')
      + (select count(*) from accounts where id_token is not null and id_token not like 'vault:%')
      + (select count(*) from accounts where password is not null and password not like 'vault:%')
      + (select count(*) from sso_providers where oidc_config is not null and oidc_config not like 'vault:%')
      + (select count(*) from sso_providers where saml_config is not null and saml_config not like 'vault:%')
    )::int as left`);
  return row?.left ?? 0;
}

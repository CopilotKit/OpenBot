/**
 * One holder at a time for a vault secret, across every replica, without a transaction held open.
 *
 * WHY. Trading a refresh token with a vendor that rotates them must happen one at a time: a vendor
 * refuses the second of two callers presenting the same token, and some withdraw the whole grant when
 * they see one reused. The trade used to run under a row lock on the local credential. The secret is
 * in Intelligence now, and no OpenBot transaction may stay open across a call to Intelligence or a
 * vendor, so the exclusion is a lease row in `secret_leases`: taken with one statement, released with
 * another, and expiring on its own if its holder dies.
 *
 * The lease also carries the vault version its last holder wrote, so the next holder can tell whether
 * the value it holds in memory is current without asking the vault.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { secretLeases } from "../db/schema";

export class SecretLeaseTimeoutError extends Error {
  constructor(key: string) {
    super(`Another server held ${key} for too long.`);
    this.name = "SecretLeaseTimeoutError";
  }
}

export type SecretLease = {
  /** The vault version the previous holder wrote, or null when none has. */
  version: number | null;
  /** Let go, recording the vault version this holder wrote, if it wrote one. */
  release(writtenVersion?: number): Promise<void>;
};

/** Long enough for a vendor token exchange and one vault write; short enough that a dead holder clears. */
const LEASE_TTL_MS = 30_000;
const WAIT_MS = 35_000;

export async function holdSecretLease(
  database: Database,
  key: string,
  options: { ttlMs?: number; waitMs?: number } = {},
): Promise<SecretLease> {
  const holder = crypto.randomUUID();
  const ttlMs = options.ttlMs ?? LEASE_TTL_MS;
  const deadline = Date.now() + (options.waitMs ?? WAIT_MS);
  for (let attempt = 0; ; attempt++) {
    const [taken] = await database
      .insert(secretLeases)
      .values({
        key,
        holder,
        expiresAt: sql`now() + make_interval(secs => ${ttlMs / 1000})`,
      })
      .onConflictDoUpdate({
        target: secretLeases.key,
        set: {
          holder,
          expiresAt: sql`now() + make_interval(secs => ${ttlMs / 1000})`,
        },
        setWhere: sql`${secretLeases.holder} IS NULL OR ${secretLeases.expiresAt} < now()`,
      })
      .returning({ version: secretLeases.version });
    if (taken) {
      return {
        version: taken.version,
        async release(writtenVersion) {
          await database
            .update(secretLeases)
            .set({
              holder: null,
              expiresAt: sql`now()`,
              ...(writtenVersion === undefined
                ? {}
                : { version: writtenVersion }),
            })
            .where(
              and(eq(secretLeases.key, key), eq(secretLeases.holder, holder)),
            );
        },
      };
    }
    if (Date.now() >= deadline) throw new SecretLeaseTimeoutError(key);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(50 * 2 ** Math.min(attempt, 4), 500)),
    );
  }
}

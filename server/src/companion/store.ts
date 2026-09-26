/**
 * The phone-companion pairing store: mint a code, spend it once, remember the phone.
 *
 * The shape is OpenMausBot-style: an administrator mints a short code on the deployment, the phone
 * reads that code and spends it exactly once, and from then on the phone can pull a compact "what
 * is my Bot doing" card and answer the approvals its Bot asks for. The phone never writes anything
 * of its own — approvals ride the existing approval flow, surfaced in the activity payload.
 *
 * The exchange is deliberately the only clever part. A code is a row in a table; spending it is a
 * delete that returns what it deleted. "Still in the table" is the whole meaning of "still valid",
 * so single-use is a property of the storage, not of a flag some later code path forgets to check.
 * Everything else — mint, check-in, status — is plain reads and upserts on two tiny tables.
 */

import { and, eq, lt } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  companionBindings,
  companionPairingCodes,
} from "../db/schema/companion";

/** How long a code is worth spending, from the moment it was minted. */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

/** The unambiguous alphabet: no 0/O or 1/I/L, because a code is read off a screen by a person. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 6;

/** A binding as the outside world sees it. */
export type CompanionBinding = {
  agentId: string;
  phoneId: string;
  pairedAt: Date;
  lastSeenAt: Date;
};

export type ExchangeRefusal = "malformed" | "unknown" | "expired";

/**
 * A code, uppercase and exactly six characters of the unambiguous alphabet.
 *
 * Normalised here rather than at each caller, so a phone sending lowercase still pairs: the code
 * exists to be retyped by a person, and case is not a security property of it.
 */
export function normaliseCode(input: string): string {
  return input.trim().toUpperCase();
}

export function isPairingCodeShape(input: string): boolean {
  const code = normaliseCode(input);
  return (
    code.length === PAIRING_CODE_LENGTH &&
    [...code].every((character) => CODE_ALPHABET.includes(character))
  );
}

/** Pull six characters from the deployment's own randomness, not a seeded or time-based source. */
function randomCode(): string {
  const bytes = new Uint32Array(PAIRING_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return [...bytes]
    .map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length])
    .join("");
}

/** A pairing code plus the two moments that define its life. */
export type Pairing = {
  agentId: string;
  code: string;
  mintedAt: Date;
  expiresAt: Date;
};

/** The pure half of mint: a fresh code and the moment it dies, decided without touching storage. */
export function mintPairing(agentId: string, now: Date = new Date()): Pairing {
  return {
    agentId,
    code: randomCode(),
    mintedAt: now,
    expiresAt: new Date(now.getTime() + PAIRING_CODE_TTL_MS),
  };
}

/**
 * The pure half of exchange: given the row a code spent, may it still bind?
 *
 * Expired is checked after the spend on purpose (the store calls this with the deleted row): an
 * expired code is refused AND consumed, so nobody can watch the table and spend the code the
 * moment it turns ten minutes old. A refusal here leaves nothing behind either way.
 */
export function spendOutcome(
  spent: Pairing,
  now: Date,
): { ok: true; agentId: string } | { ok: false; refusal: ExchangeRefusal } {
  if (spent.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, refusal: "expired" };
  }
  return { ok: true, agentId: spent.agentId };
}

export type CompanionStore = {
  /** Mint a fresh code for a Bot, replacing any code it already had. Ten minutes, one use. */
  mint: (agentId: string, now?: Date) => Promise<string>;
  /**
   * Spend a code, binding the phone that presented it to the Bot the code names.
   *
   * Refusals are reasons, not exceptions, so the route can answer in one shape and the phone can
   * show a person what to do next. `unknown` covers a wrong code and a used one alike: from the
   * phone's side there is nothing to do but ask for a fresh code, and telling a prober which of
   * the two they hit is a free oracle.
   */
  exchange: (
    code: string,
    phoneId: string,
    now?: Date,
  ) => Promise<
    { ok: true; agentId: string } | { ok: false; refusal: ExchangeRefusal }
  >;
  /** The binding for a Bot, if a phone holds one. */
  binding: (agentId: string) => Promise<CompanionBinding | undefined>;
  /** A phone's heartbeat. Also the last step of pairing, so a fresh pair reads as alive. */
  touch: (agentId: string, phoneId: string, now?: Date) => Promise<void>;
  /** Drop expired code rows so the table stays the size of "codes in flight". */
  sweep: (now?: Date) => Promise<number>;
};

/**
 * The store a deployment uses, backed by Postgres. There is no in-memory fallback on this path: a
 * pairing has to survive the server restarting or the phone has to pair again every deploy, and
 * "works until the next release" is not a pairing.
 */
export function createCompanionStore(database: Database): CompanionStore {
  return {
    mint: async (agentId, now = new Date()) => {
      const pairing = mintPairing(agentId, now);
      // Upsert: minting for a Bot that already has a live code replaces it, so a code left on a
      // screen nobody is looking at cannot be spent after the administrator moved on.
      await database
        .insert(companionPairingCodes)
        .values(pairing)
        .onConflictDoUpdate({
          target: companionPairingCodes.agentId,
          set: {
            code: pairing.code,
            mintedAt: pairing.mintedAt,
            expiresAt: pairing.expiresAt,
          },
        });
      return pairing.code;
    },

    exchange: async (rawCode, phoneId, now = new Date()) => {
      const code = normaliseCode(rawCode);
      if (!isPairingCodeShape(code)) {
        return { ok: false, refusal: "malformed" as const };
      }

      // The spend. One statement, one row: delete the code and read back what it named. A second
      // phone presenting the same code finds nothing, because the row is gone — that is the
      // single-use guarantee, and it holds without any flag anyone has to remember to set.
      const spent = await database
        .delete(companionPairingCodes)
        .where(eq(companionPairingCodes.code, code))
        .returning({
          agentId: companionPairingCodes.agentId,
          mintedAt: companionPairingCodes.mintedAt,
          expiresAt: companionPairingCodes.expiresAt,
        });

      const row = spent[0];
      if (!row) return { ok: false, refusal: "unknown" as const };

      const outcome = spendOutcome(
        {
          code,
          agentId: row.agentId,
          mintedAt: row.mintedAt,
          expiresAt: row.expiresAt,
        },
        now,
      );
      if (!outcome.ok) return outcome;

      // One phone per Bot: a new pairing replaces the old one, in the open, in one row.
      await database
        .insert(companionBindings)
        .values({
          agentId: outcome.agentId,
          phoneId,
          pairedAt: now,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: companionBindings.agentId,
          set: { phoneId, pairedAt: now, lastSeenAt: now },
        });
      return outcome;
    },

    binding: async (agentId) => {
      const rows = await database
        .select()
        .from(companionBindings)
        .where(eq(companionBindings.agentId, agentId))
        .limit(1);
      return rows[0];
    },

    touch: async (agentId, phoneId, now = new Date()) => {
      // Guarded by the binding's own phoneId, so one phone cannot move another's heartbeat. A
      // no-op when no row matches, which only happens if pairing was undone mid-flight.
      await database
        .update(companionBindings)
        .set({ lastSeenAt: now })
        .where(
          and(
            eq(companionBindings.agentId, agentId),
            eq(companionBindings.phoneId, phoneId),
          ),
        );
    },

    sweep: async (now = new Date()) => {
      const gone = await database
        .delete(companionPairingCodes)
        .where(lt(companionPairingCodes.expiresAt, now))
        .returning({ agentId: companionPairingCodes.agentId });
      return gone.length;
    },
  };
}

/**
 * The same store, in memory. For tests of the exchange protocol, which do not need Postgres to
 * prove a code dies when spent — the same reasoning as the snapshot store's in-memory twin, and
 * for the same reason: single-process tests of decision logic.
 */
export function createInMemoryCompanionStore(): CompanionStore {
  const codes = new Map<string, Pairing>();
  const bindings = new Map<string, CompanionBinding>();

  return {
    mint: async (agentId, now = new Date()) => {
      const pairing = mintPairing(agentId, now);
      codes.set(agentId, pairing);
      return pairing.code;
    },

    exchange: async (rawCode, phoneId, now = new Date()) => {
      const code = normaliseCode(rawCode);
      if (!isPairingCodeShape(code)) {
        return { ok: false, refusal: "malformed" as const };
      }
      const entry = [...codes.values()].find(
        (candidate) => candidate.code === code,
      );
      if (!entry) return { ok: false, refusal: "unknown" as const };
      codes.delete(entry.agentId); // The spend. Same rule as the table: gone means used.

      const outcome = spendOutcome(entry, now);
      if (!outcome.ok) return outcome;

      bindings.set(outcome.agentId, {
        agentId: outcome.agentId,
        phoneId,
        pairedAt: now,
        lastSeenAt: now,
      });
      return outcome;
    },

    binding: async (agentId) => bindings.get(agentId),

    touch: async (agentId, phoneId, now = new Date()) => {
      const held = bindings.get(agentId);
      if (held && held.phoneId === phoneId) held.lastSeenAt = now;
    },

    sweep: async (now = new Date()) => {
      let gone = 0;
      for (const [agentId, pairing] of codes) {
        if (pairing.expiresAt.getTime() <= now.getTime()) {
          codes.delete(agentId);
          gone += 1;
        }
      }
      return gone;
    },
  };
}

import { randomBytes } from "node:crypto";
import { brokeredProvenance } from "./access";
import { type Decides, type SchemeKind, schemeKind } from "./broker";

/**
 * Whose account a brokered call reaches, decided in one place.
 *
 * Every other reader — the gate before a call, the transport, the audit row, the memory sync — asks
 * this, so the account a person was checked against and the account the call ran in cannot be two
 * answers that happened to agree.
 */

export const ACCOUNT_MODES = ["personal", "shared"] as const;
export type AccountMode = (typeof ACCOUNT_MODES)[number];

export const HOLDERS = ["person", "deployment"] as const;
export type Holder = (typeof HOLDERS)[number];

/** Who a broker is asked to act for. The broker sends `vendorUserId` and never chooses the holder. */
export type AccountRef =
  | { holder: "person"; userId: string; vendorUserId: string }
  | { holder: "deployment"; vendorUserId: string };

/**
 * A PERSON'S ACCOUNT, AND WHY ITS TWO IDS ARE ONE VALUE.
 *
 * `userId` and `vendorUserId` are different CONCEPTS — who the account belongs to here, and the
 * name the vendor files it under — and they are kept as two fields because the deployment holder
 * proves they can differ: its vendor id is minted by {@link mintDeploymentVendorUserId} and has no
 * local user at all. FOR A PERSON THEY ARE THE SAME VALUE ON PURPOSE, for both providers:
 *
 * - Neither vendor issues a user handle. Composio's `user_id` and Arcade's `user_id` are both a
 *   string the CALLER chooses and the vendor files connections under, so "the vendor's id for this
 *   person" is whatever this deployment sends, and what it sends is the person's own id.
 * - Every person connection that exists was made that way. Before shared accounts the Composio
 *   adapter was handed the local user id directly, and migration 0052 backfilled
 *   `vendor_user_id = user_id` for every person row it carried over. Sending anything else now
 *   would ask the vendor about an identity nobody connected under, and every existing connection
 *   would read as absent.
 * - Arcade echoes the id back: a return leg's settled `userId` is compared to the attempt's stored
 *   `vendor_user_id`, which was minted from this ref.
 *
 * SO DO NOT "FIX" THE COLLAPSE BY DERIVING A DIFFERENT VENDOR ID HERE without migrating every
 * stored person row and every vendor-side connection with it. And do not read the collapse as
 * licence to use one field for the other: a store lookup by person matches `user_id`, a vendor call
 * sends `vendorUserId`, and code that crosses them is only right by coincidence. This is the one
 * place a person's ref is minted from a local id; a ref read back from a stored row goes through
 * {@link asAccountRef} and carries the row's own `vendor_user_id`.
 */
export function personAccount(userId: string): AccountRef {
  return { holder: "person", userId, vendorUserId: userId };
}

export function asAccountMode(value: unknown): AccountMode | null {
  return value === "personal" || value === "shared" ? value : null;
}

/**
 * A STORED `(holder, user_id)` PAIR READ BACK AS THE ACCOUNT IT NAMES, or `null` when it names no
 * account this deployment may act in.
 *
 * THE POINT IS THE `null`, AND IT EXISTS BECAUSE THE OTHER READING IS SILENT. A row that says
 * `person` and carries no user id was for years rebuilt as `{ holder: "deployment" }` by a ternary
 * whose else-branch quietly absorbed it — and a reference is not a label: it is what a revoke, a
 * grant read and a call are aimed at. Aimed one holder out, a disconnect somebody asked for ends
 * the DEPLOYMENT's connection and leaves theirs live, or ends the deployment's on one person's
 * behalf. Both failures look exactly like success from the browser that asked.
 *
 * THE TWO REFUSALS ARE THE DATABASE'S OWN CHECK, RESTATED WHERE TYPESCRIPT CAN SEE IT.
 * `brokered_connections_holder_check` and `pending_authorizations_holder_check` both hold
 * `(person AND user_id IS NOT NULL) OR (deployment AND user_id IS NULL)`, so for a row that came
 * out of either table every refusal here is already impossible — which is the whole reason to
 * refuse rather than to coerce. An impossible state answered with a plain `null` is a caller's
 * refusal; the same state absorbed into the other holder is a wrong act with no trace. The empty
 * string is refused with the null, because a CHECK for `IS NOT NULL` does not stop `''` and `''` is
 * nobody's user id.
 *
 * `holder` IS TAKEN AS `string` ON PURPOSE. drizzle's `$type<>` is erased at runtime, so a column
 * declared as the pair can still deliver a third word; a parameter typed as the union would let the
 * compiler promise what only the CHECK enforces.
 */
export function asAccountRef(stored: {
  holder: string;
  userId: string | null;
  vendorUserId: string;
}): AccountRef | null {
  if (stored.holder === "person") {
    return stored.userId
      ? {
          holder: "person",
          userId: stored.userId,
          vendorUserId: stored.vendorUserId,
        }
      : null;
  }
  if (stored.holder === "deployment") {
    return stored.userId
      ? null
      : { holder: "deployment", vendorUserId: stored.vendorUserId };
  }
  return null;
}

export type AccountAnswer =
  | { kind: "none" }
  | { kind: "person"; userId: string }
  | { kind: "deployment" }
  | { kind: "ambiguous"; message: string };

export function accountFor(
  row: {
    title: string;
    provenance: string;
    authScheme: string | null;
    accountMode: string | null;
  },
  credentialActorId: string,
): AccountAnswer {
  if (!brokeredProvenance(row.provenance)) return { kind: "none" };

  const kind = schemeKind(row.authScheme);
  type _AccountForDecides = Decides<
    SchemeKind,
    {
      key: "has an account, chosen by the mode";
      consent: "has an account, chosen by the mode";
      none: "has no account in either mode, so the mode is not read";
      unreadable: "is treated as having an account, which is the closed direction";
    }
  >;
  if (kind === "none") return { kind: "none" };

  const mode = asAccountMode(row.accountMode);
  type _ModeDecides = Decides<
    AccountMode,
    {
      personal: "the credential actor's own account — the asker, or a Team Bot's owner";
      shared: "the deployment's one account, whoever asked";
    }
  >;
  if (mode === "personal") return { kind: "person", userId: credentialActorId };
  if (mode === "shared") return { kind: "deployment" };
  return {
    kind: "ambiguous",
    message: `${row.title} wasn't called because nobody has chosen whether it uses each person's account or a shared one. An admin can choose on its Plugins page.`,
  };
}

export const DEPLOYMENT_VENDOR_PREFIX = "openbot-deployment:";

/**
 * The identity a deployment's own account is held under at the vendor.
 *
 * THE RANDOM PART IS WHAT RULES OUT A COLLISION WITH A PERSON. Better Auth's ids never contain a
 * colon, but organization-auth mode takes user ids verbatim from its authority, so the prefix alone
 * promises nothing. Minted once per switch to Shared and stored; never recomputed.
 */
export function mintDeploymentVendorUserId(
  deploymentId: string,
  random: () => string = () => randomBytes(16).toString("base64url"),
): string {
  const named = deploymentId.trim();
  if (!named) {
    throw new Error(
      "A deployment with no id cannot hold a shared account; set DEPLOYMENT_ID.",
    );
  }
  return `${DEPLOYMENT_VENDOR_PREFIX}${named}:${random()}`;
}

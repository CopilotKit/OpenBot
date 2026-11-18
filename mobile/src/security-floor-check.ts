/**
 * The phone app's side of the security floor (security-floor.ts, a copy of shared/security-floor.ts):
 * whether this build must stop and ask to be updated.
 *
 * Hermes has no WebCrypto Ed25519, so the floor's signature is checked with @noble/curves, in strict
 * RFC 8032 mode like WebCrypto and the desktop app. Verifying needs no random numbers.
 *
 * The app is built for one OpenBot (EXPO_PUBLIC_SERVER_URL). The floor holds only when that OpenBot
 * is one the floor names in `cloud`, so an app built for a company's own OpenBot never stops.
 *
 * Nothing here imports React Native, so tests drive every decision as it runs on the phone.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  belowFloor,
  type Ed25519Verify,
  type FloorStore,
  floorApplies,
  heldSecurityFloor,
  refreshSecurityFloor,
  type SecurityFloor,
} from "./security-floor";
import { SECURITY_FLOOR_ADDRESSES } from "./security-floor-addresses";

/** Ed25519 as RFC 8032 has it (no ZIP 215 leniency), for a phone with no WebCrypto Ed25519. */
export const nobleVerify: Ed25519Verify = async (
  publicKey,
  signature,
  message,
) => ed25519.verify(signature, message, publicKey, { zip215: false });

/** Whether this build may run: blocked names the release to update to. */
export type FloorDecision =
  | { blocked: false }
  | { blocked: true; update: string };

/** Where the app is and what it is: the OpenBot it was built for, and its own release. */
export type FloorPlace = { origin: string; release: string | undefined };

/** The decision a floor makes for this build. No floor, a company's OpenBot or no release: runs. */
export function floorDecision(
  floor: SecurityFloor | null,
  { origin, release }: FloorPlace,
): FloorDecision {
  if (!release || !floorApplies(floor, { origin })) return { blocked: false };
  const update = belowFloor(floor, "mobile", release);
  return update ? { blocked: true, update } : { blocked: false };
}

export type FloorCheck = FloorPlace & {
  store: FloorStore;
  keys?: readonly string[];
  verify?: Ed25519Verify;
  addresses?: readonly string[];
  fetch?: typeof globalThis.fetch;
};

/** The decision from the floor this phone kept, with no network: what holds offline and at launch. */
export async function heldFloorDecision(
  check: FloorCheck,
): Promise<FloorDecision> {
  const floor = await heldSecurityFloor({
    store: check.store,
    keys: check.keys,
    verify: check.verify ?? nobleVerify,
  });
  return floorDecision(floor, check);
}

/**
 * Reads the published floor, keeps it when it verifies with a higher serial, and decides by the
 * floor that holds now. Offline, or when the published one is older or doesn't verify, that is the
 * kept one.
 */
export async function refreshedFloorDecision(
  check: FloorCheck,
): Promise<FloorDecision> {
  const floor = await refreshSecurityFloor({
    store: check.store,
    keys: check.keys,
    verify: check.verify ?? nobleVerify,
    addresses: check.addresses ?? SECURITY_FLOOR_ADDRESSES,
    ...(check.fetch ? { fetch: check.fetch } : {}),
  });
  return floorDecision(floor, check);
}

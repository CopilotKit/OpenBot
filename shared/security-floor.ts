/**
 * The security floor: the lowest safe version of each OpenBot app, which CopilotKit raises only when
 * a release has a security problem. Below it, an app shows one notice and nothing else until it is
 * updated.
 *
 * The floor is a small signed document published next to the update feed (`security-floor.json`
 * beside `latest.json`). The updater's own `latest.json` can't carry it: Tauri's signatures cover the
 * installers, not the feed, so a field there would be unauthenticated. So the floor carries its own
 * Ed25519 signature over the exact bytes of its payload, and an app acts on it only once that
 * signature verifies against a key built into the app (`security-floor.json` in this folder). Each
 * app names where it reads the floor itself (`SECURITY_FLOOR_ADDRESSES` in the Recorder and the phone
 * app, `ADDRESSES` in security_floor.rs); tests/security-floor-addresses.test.ts holds them equal.
 *
 * Only up: an app keeps the floor with the highest `serial` it has verified and ignores any with a
 * lower or equal one, so a replayed old floor can't lift a block. Offline, the kept floor still
 * holds. An app that has never verified a floor runs as normal.
 *
 * Never for a company's own OpenBot. OpenBot Desktop's own back end (Desktop contained) always
 * follows the floor, because it ships with the app. Any other OpenBot follows it only when the floor
 * names its address in `cloud`, which lists OpenBot Cloud's addresses and nothing else.
 *
 * The same rules are in Rust for OpenBot Desktop (desktop/src-tauri/src/security_floor.rs), and both
 * read the documents in shared/fixtures/security-floor/cases.json.
 */
import config from "./security-floor.json";

/** The file's name, beside `latest.json`. */
export const SECURITY_FLOOR_FILE = "security-floor.json";

/** What the payload says it is, so no other signed JSON can pass for a floor. */
export const SECURITY_FLOOR_KIND = "openbot-security-floor";

/** The Ed25519 public keys a floor must be signed with: each the raw 32 bytes, in base64. */
export const SECURITY_FLOOR_KEYS: readonly string[] = config.keys;

/** The largest floor read. A real one is a few hundred bytes. */
export const SECURITY_FLOOR_LARGEST = 64 * 1024;

/** The notice every app shows below the floor, in these words. */
export const SECURITY_FLOOR_HEADING =
  "This version of OpenBot has a security problem.";
export const SECURITY_FLOOR_LINE = "Update to keep using it.";
export const SECURITY_FLOOR_SENTENCE = `${SECURITY_FLOOR_HEADING} ${SECURITY_FLOOR_LINE}`;
export const SECURITY_FLOOR_ACTION = "Update and restart";

/**
 * The apps a floor can name. `backend` is the server OpenBot Desktop runs on this computer, which
 * the app upgrades before it starts it.
 */
export const FLOOR_APPS = ["desktop", "backend", "mobile", "recorder"] as const;
export type FloorApp = (typeof FLOOR_APPS)[number];

export type SecurityFloor = {
  /** Raised by one each time the floor is published. The highest verified wins. */
  serial: number;
  /** When it was signed, for people reading it. Nothing decides by it. */
  issued: string;
  /** The lowest safe release of each app it names. An app it doesn't name has no floor. */
  floors: Partial<Record<FloorApp, string>>;
  /** The OpenBot Cloud addresses (origins) it applies to, besides OpenBot Desktop's own back end. */
  cloud: readonly string[];
};

/** The published document: the payload's exact bytes and a signature over them, both in base64. */
export type SignedFloor = { payload: string; signature: string };

/** Ed25519 verification, so an app without WebCrypto's Ed25519 (the phone app) can bring its own. */
export type Ed25519Verify = (
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
) => Promise<boolean>;

/** WebCrypto's Ed25519: in Chrome 137 and later, Safari 17, Firefox 129, Node 22.13 and Bun. */
export const webCryptoVerify: Ed25519Verify = async (
  publicKey,
  signature,
  message,
) => {
  const key = await crypto.subtle.importKey(
    "raw",
    publicKey as BufferSource,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    signature as BufferSource,
    message as BufferSource,
  );
};

export type Verified =
  | { ok: true; floor: SecurityFloor; text: string }
  | { ok: false; reason: string };

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function fromBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !BASE64.test(text)) return null;
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** An `https` origin, written exactly as its origin. */
function isOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The payload, read strictly. Fields and apps it doesn't know are left out, so a later floor that
 * names a new app still holds for the apps this one knows.
 */
export function readFloorPayload(
  bytes: Uint8Array,
): SecurityFloor | { reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { reason: "its payload is not JSON" };
  }
  if (!isObject(value)) return { reason: "its payload is not an object" };
  if (value.kind !== SECURITY_FLOOR_KIND)
    return { reason: `its payload is not a ${SECURITY_FLOOR_KIND}` };
  const { serial, issued, floors, cloud } = value;
  if (typeof serial !== "number" || !Number.isSafeInteger(serial) || serial < 1)
    return { reason: "its serial is not a whole number from 1" };
  if (typeof issued !== "string") return { reason: "it names no issue time" };
  if (!isObject(floors)) return { reason: "it lists no floors" };
  const read: Partial<Record<FloorApp, string>> = {};
  for (const app of FLOOR_APPS) {
    const release = floors[app];
    if (release === undefined) continue;
    if (typeof release !== "string" || !RELEASE.test(release))
      return { reason: `its ${app} floor is not a release such as 1.2.0` };
    read[app] = release;
  }
  const origins = cloud ?? [];
  if (!Array.isArray(origins) || !origins.every(isOrigin))
    return { reason: "its cloud list is not a list of https origins" };
  return { serial, issued, floors: read, cloud: origins };
}

/**
 * The floor in `text`, when its signature over its payload verifies against one of `keys`. Nothing
 * in the payload is read before that.
 */
export async function verifySecurityFloor(
  text: string,
  keys: readonly string[] = SECURITY_FLOOR_KEYS,
  verify: Ed25519Verify = webCryptoVerify,
): Promise<Verified> {
  if (text.length > SECURITY_FLOOR_LARGEST)
    return { ok: false, reason: "it is larger than any floor" };
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return { ok: false, reason: "it is not JSON" };
  }
  if (
    !isObject(envelope) ||
    typeof envelope.payload !== "string" ||
    typeof envelope.signature !== "string"
  )
    return { ok: false, reason: "it is not a signed floor" };
  const payload = fromBase64(envelope.payload);
  const signature = fromBase64(envelope.signature);
  if (!payload || !signature || signature.length !== 64)
    return { ok: false, reason: "it is not a signed floor" };
  let signed = false;
  for (const key of keys) {
    const publicKey = fromBase64(key);
    if (publicKey?.length !== 32) continue;
    try {
      if (await verify(publicKey, signature, payload)) {
        signed = true;
        break;
      }
    } catch {
      // A key the platform can't read verifies nothing.
    }
  }
  if (!signed)
    return { ok: false, reason: "it is not signed by a key this app trusts" };
  const floor = readFloorPayload(payload);
  if ("reason" in floor) return { ok: false, reason: floor.reason };
  return { ok: true, floor, text };
}

/** Major, minor and patch. A candidate or internal build of 1.2.0 counts as 1.2.0. */
function release(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative when `a` is the earlier release, by major, minor and patch. */
export function compareReleases(a: string, b: string): number {
  const x = release(a);
  const y = release(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * The floor's release for `app` when `version` is below it: the version to update to. Null when
 * it is at or above the floor, the floor doesn't name the app, or the version can't be read.
 */
export function belowFloor(
  floor: SecurityFloor | null,
  app: FloorApp,
  version: string,
): string | null {
  const lowest = floor?.floors[app];
  if (!lowest || !release(version)) return null;
  return compareReleases(version, lowest) < 0 ? lowest : null;
}

/**
 * Whether the floor holds where this app is: always for OpenBot Desktop's own back end, and for any
 * other OpenBot only when the floor names its address in `cloud`. A company's own OpenBot never
 * appears there, so an app connected to one ignores the floor.
 */
export function floorApplies(
  floor: SecurityFloor | null,
  where: { contained: true } | { origin: string },
): boolean {
  if (!floor) return false;
  if ("contained" in where) return true;
  let origin: string;
  try {
    origin = new URL(where.origin).origin;
  } catch {
    return false;
  }
  return floor.cloud.includes(origin);
}

/** Whether `candidate` replaces `held`: only a higher serial does. */
export function replacesFloor(
  held: SecurityFloor | null,
  candidate: SecurityFloor,
): boolean {
  return !held || candidate.serial > held.serial;
}

/** Where an app keeps the signed floor it has verified, exactly as it was published. */
export type FloorStore = {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
};

export type FloorOptions = {
  store: FloorStore;
  keys?: readonly string[];
  verify?: Ed25519Verify;
};

/** The kept floor, verified again as it is read, so a changed copy on the device counts for nothing. */
export async function heldSecurityFloor({
  store,
  keys,
  verify,
}: FloorOptions): Promise<SecurityFloor | null> {
  let text: string | null = null;
  try {
    text = await store.read();
  } catch {
    return null;
  }
  if (!text) return null;
  const held = await verifySecurityFloor(text, keys, verify);
  return held.ok ? held.floor : null;
}

/**
 * Reads the published floor and keeps it when it verifies and its serial is higher than the kept
 * one's. Answers the floor that holds now: the new one, or the kept one when the published one is
 * older, unsigned, tampered with, missing or can't be reached.
 *
 * `addresses` come from the app, never from shared/: every self-hosted OpenBot ships shared/, and
 * nothing it runs may name where CopilotKit publishes the floor.
 */
export async function refreshSecurityFloor({
  store,
  keys,
  verify,
  addresses,
  fetch: get = fetch,
  timeoutMs = 30_000,
}: FloorOptions & {
  addresses: readonly string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<SecurityFloor | null> {
  const held = await heldSecurityFloor({ store, keys, verify });
  // Built with no key, no floor could verify: nothing is read.
  if ((keys ?? SECURITY_FLOOR_KEYS).length === 0) return held;
  for (const address of addresses) {
    let text: string;
    // A controller and a timer, not AbortSignal.timeout: React Native's AbortSignal has no timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await get(address, {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) continue;
      text = await response.text();
    } catch {
      continue;
    } finally {
      clearTimeout(timer);
    }
    const published = await verifySecurityFloor(text, keys, verify);
    if (!published.ok) continue;
    if (!replacesFloor(held, published.floor)) return held;
    try {
      await store.write(published.text);
    } catch {
      // Kept for this run only; the next check reads it again.
    }
    return published.floor;
  }
  return held;
}

/**
 * Signs a new security floor (shared/security-floor.ts), for the Security floor workflow
 * (.github/workflows/security-floor.yml), which runs only after a required reviewer approves it.
 *
 *   bun scripts/security-floor-sign.ts             sign a new floor from the variables below
 *   bun scripts/security-floor-sign.ts --public    print the public key of SECURITY_FLOOR_SIGNING_KEY,
 *                                                  in the form shared/security-floor.json lists keys
 *
 * Env:
 *   SECURITY_FLOOR_SIGNING_KEY  the Ed25519 private key, PKCS#8 PEM (`openssl genpkey -algorithm ed25519`)
 *   FLOOR_DESKTOP, FLOOR_BACKEND, FLOOR_MOBILE, FLOOR_RECORDER
 *                               each app's new floor, such as 1.1.2; empty keeps the published one,
 *                               `none` removes it
 *   FLOOR_CLOUD                 OpenBot Cloud's addresses, comma-separated https origins; empty keeps
 *                               the published list, `none` empties it
 *   FLOOR_LOWER                 `true` to allow a floor lower than the published one, to undo a
 *                               floor raised by mistake
 *   LATEST_RELEASE              the Latest stable release, such as v1.1.2: no floor may be above it,
 *                               or an app below it would have no update to reach
 *   PREVIOUS                    the floor published now, when there is one
 *   OUT                         where to write the new one (default security-floor.json)
 *
 * The new serial is the published one's plus one, and the result is verified against the keys the
 * apps carry before it is written, so a floor signed with any other key fails here, not in the apps.
 */
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  compareReleases,
  FLOOR_APPS,
  type FloorApp,
  SECURITY_FLOOR_KEYS,
  SECURITY_FLOOR_KIND,
  type SecurityFloor,
  type SignedFloor,
  verifySecurityFloor,
} from "../shared/security-floor";

const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type FloorRequest = {
  /** Each app's new floor; undefined keeps the previous one, null removes it. */
  floors: Partial<Record<FloorApp, string | null>>;
  /** OpenBot Cloud's addresses; undefined keeps the previous list. */
  cloud?: readonly string[];
  lower?: boolean;
  latestRelease: string;
  previous: SecurityFloor | null;
  issued?: Date;
};

/** The new payload, or why it can't be signed. */
export function nextFloor(request: FloorRequest): SecurityFloor {
  const { previous } = request;
  const floors: Partial<Record<FloorApp, string>> = {
    ...(previous?.floors ?? {}),
  };
  for (const app of FLOOR_APPS) {
    const wanted = request.floors[app];
    if (wanted === undefined) continue;
    if (wanted === null) {
      if (floors[app] && !request.lower)
        throw new Error(
          `Removing the ${app} floor lowers it. Set FLOOR_LOWER=true to do that on purpose.`,
        );
      delete floors[app];
      continue;
    }
    const release = wanted.replace(/^v/, "");
    if (!RELEASE.test(release))
      throw new Error(`${app}: ${wanted} is not a release such as 1.1.2.`);
    const before = floors[app];
    if (before && compareReleases(release, before) < 0 && !request.lower)
      throw new Error(
        `${app}: ${release} is lower than the published floor ${before}. Set FLOOR_LOWER=true to lower it on purpose.`,
      );
    floors[app] = release;
  }
  const latest = request.latestRelease.replace(/^v/, "");
  if (!RELEASE.test(latest))
    throw new Error(
      `LATEST_RELEASE ${request.latestRelease} is not a stable release such as v1.1.2.`,
    );
  for (const app of FLOOR_APPS) {
    const release = floors[app];
    if (release && compareReleases(release, latest) > 0)
      throw new Error(
        `${app}: ${release} is above the Latest release ${latest}, so every ${app} would be blocked with no update to reach. Publish the fixed release first.`,
      );
  }
  const cloud = request.cloud ?? previous?.cloud ?? [];
  for (const origin of cloud) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`${origin} is not an address.`);
    }
    if (parsed.protocol !== "https:" || parsed.origin !== origin)
      throw new Error(
        `${origin} is not an https origin such as https://cloud.example.`,
      );
  }
  if (Object.keys(floors).length === 0)
    throw new Error("A floor names at least one app.");
  return {
    serial: (previous?.serial ?? 0) + 1,
    issued: (request.issued ?? new Date()).toISOString(),
    floors,
    cloud: [...cloud],
  };
}

/** The published document for `floor`, signed with `privateKeyPem`. */
export function signFloor(
  floor: SecurityFloor,
  privateKeyPem: string,
): SignedFloor {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("SECURITY_FLOOR_SIGNING_KEY is not an Ed25519 key.");
  const payload = Buffer.from(
    `${JSON.stringify({ kind: SECURITY_FLOOR_KIND, ...floor }, null, 2)}\n`,
  );
  const signature = sign(null, payload, key);
  return {
    payload: payload.toString("base64"),
    signature: signature.toString("base64"),
  };
}

/** The raw 32-byte public key of `privateKeyPem`, in base64, as shared/security-floor.json lists it. */
export function publicKeyOf(privateKeyPem: string): string {
  const jwk = createPublicKey(createPrivateKey(privateKeyPem)).export({
    format: "jwk",
  });
  if (jwk.crv !== "Ed25519" || typeof jwk.x !== "string")
    throw new Error("SECURITY_FLOOR_SIGNING_KEY is not an Ed25519 key.");
  return Buffer.from(jwk.x, "base64url").toString("base64");
}

function floorVariable(name: string): string | null | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  return value === "none" ? null : value;
}

async function main() {
  const pem = process.env.SECURITY_FLOOR_SIGNING_KEY;
  if (!pem) throw new Error("SECURITY_FLOOR_SIGNING_KEY is not set.");
  if (process.argv.includes("--public")) {
    console.log(publicKeyOf(pem));
    return;
  }
  const keys = SECURITY_FLOOR_KEYS;
  if (!keys.includes(publicKeyOf(pem)))
    throw new Error(
      "SECURITY_FLOOR_SIGNING_KEY is not one of the keys the apps carry (shared/security-floor.json). Apps would ignore what it signs.",
    );
  let previous: SecurityFloor | null = null;
  const previousPath = process.env.PREVIOUS;
  if (previousPath && existsSync(previousPath)) {
    const published = await verifySecurityFloor(
      readFileSync(previousPath, "utf8"),
      keys,
    );
    if (!published.ok)
      throw new Error(
        `The published floor does not verify: ${published.reason}. Look at it before signing another.`,
      );
    previous = published.floor;
  }
  const cloud = floorVariable("FLOOR_CLOUD");
  const floor = nextFloor({
    floors: {
      desktop: floorVariable("FLOOR_DESKTOP"),
      backend: floorVariable("FLOOR_BACKEND"),
      mobile: floorVariable("FLOOR_MOBILE"),
      recorder: floorVariable("FLOOR_RECORDER"),
    },
    cloud:
      cloud === undefined
        ? undefined
        : cloud === null
          ? []
          : cloud
              .split(",")
              .map((origin) => origin.trim())
              .filter(Boolean),
    lower: process.env.FLOOR_LOWER === "true",
    latestRelease: process.env.LATEST_RELEASE ?? "",
    previous,
  });
  const text = `${JSON.stringify(signFloor(floor, pem), null, 2)}\n`;
  const check = await verifySecurityFloor(text, keys);
  if (!check.ok || check.floor.serial !== floor.serial)
    throw new Error("The signed floor does not verify. Nothing was written.");
  const out = process.env.OUT || "security-floor.json";
  writeFileSync(out, text);
  console.log(JSON.stringify(check.floor, null, 2));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(
      `::error::${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}

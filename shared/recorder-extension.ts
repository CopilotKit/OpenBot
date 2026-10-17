import config from "./recorder-extension.json";

export const RECORDER_NATIVE_HOST: string = config.nativeHost;

/** The Recorder's one id, in every build, in Chrome and Edge. */
export const RECORDER_EXTENSION_ID: string = config.extensionId;

/** Chrome's extension id: SHA-256 of the DER public key, first 32 hex digits mapped 0-f -> a-p. */
export async function extensionIdFromPublicKey(
  base64Der: string,
): Promise<string> {
  const der = Uint8Array.from(atob(base64Der.trim()), (character) =>
    character.charCodeAt(0),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", der));
  const hex = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return Array.from(hex.slice(0, 32), (digit) =>
    String.fromCharCode(97 + Number.parseInt(digit, 16)),
  ).join("");
}

/** The fixed id first, then each extra id (forks and self-signed builds), deduplicated. */
export function recorderExtensionIds(options?: {
  extra?: readonly string[];
}): string[] {
  return [...new Set([RECORDER_EXTENSION_ID, ...(options?.extra ?? [])])];
}

const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})\/?$/;

/**
 * `chrome-extension://<id>` with or without the trailing slash, for an id in `ids`. Edge's native messaging page shows
 * its `allowed_origins` in the `chrome-extension://<id>/` form:
 * https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging
 */
export function extensionIdFromOrigin(
  origin: string | null | undefined,
  ids: readonly string[],
): string | null {
  const match = origin ? EXTENSION_ORIGIN.exec(origin) : null;
  return match && ids.includes(match[1]) ? match[1] : null;
}

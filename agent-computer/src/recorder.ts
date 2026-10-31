/**
 * The built OpenBot Recorder this computer puts into a person's browser.
 *
 * A person's browser never opens without it: the whole point of the OpenBot Browser is that the
 * Recorder is already there and already connected. So the directory is checked before a launch, and
 * a computer whose `OPENBOT_RECORDER_DIR` is unset, relative, or points at something that is not a
 * built Recorder refuses to open one, saying which of those it was. The usual mistake is pointing it
 * at `extension/` (the source) rather than `extension/dist` (what `bun run build` writes), and that
 * has no `manifest.json`.
 *
 * Its own file, free of Playwright, so the rule can be tested against real directories without a
 * browser, for the reason `bot-id.ts` and `authorisation.ts` are separate.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { RECORDER_DIR_ENV } from "../../shared/openbot-browser";

export type Recorder = {
  /** The built Recorder, absolute. */
  dir: string;
  /** Its extension id, which its manifest key fixes in Chrome, Edge and Chromium alike. */
  id: string;
  /** Its service worker's script, as its manifest names it, relative to `dir`. */
  worker: string;
};

export type RecorderLookup =
  | { ok: true; recorder: Recorder }
  | { ok: false; error: string };

/**
 * The id Chrome gives an extension whose manifest carries a `key`.
 *
 * The first 128 bits of the SHA-256 of the public key's DER bytes, written in hex and then spelled
 * with the letters a to p instead of 0 to f. Worked out here rather than asked of the browser because
 * the managed launch loads the Recorder by flag, which answers nothing, and the computer still has to
 * know which service worker and which tabs are the Recorder's.
 * https://developer.chrome.com/docs/extensions/reference/manifest/key
 */
export function extensionIdFromKey(key: string): string {
  const digest = createHash("sha256")
    .update(Buffer.from(key, "base64"))
    .digest("hex")
    .slice(0, 32);
  return [...digest]
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    .join("");
}

const notARecorder = (dir: string, why: string): RecorderLookup => ({
  ok: false,
  error: `${RECORDER_DIR_ENV} (${dir}) is not a built OpenBot Recorder: ${why} Point it at the Recorder's build output, extension/dist after bun run build.`,
});

/**
 * The Recorder in `dir`, or why there is none.
 *
 * Read afresh for every open rather than once at boot, so a Recorder rebuilt in place is the one the
 * next browser gets, and a computer that started before the build finished is not stuck refusing.
 */
export async function findRecorder(
  configured: string | undefined,
): Promise<RecorderLookup> {
  const dir = configured?.trim();
  if (!dir) {
    return {
      ok: false,
      error: `This computer has no OpenBot Recorder, so it cannot open a person's browser: set ${RECORDER_DIR_ENV} to the built Recorder (extension/dist).`,
    };
  }
  if (!isAbsolute(dir)) {
    return {
      ok: false,
      error: `${RECORDER_DIR_ENV} must be an absolute path, not ${JSON.stringify(dir)}.`,
    };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  } catch {
    return notARecorder(dir, "it has no readable manifest.json.");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    return notARecorder(dir, "its manifest.json is not an object.");
  const fields = manifest as {
    manifest_version?: unknown;
    background?: { service_worker?: unknown };
    key?: unknown;
  };
  if (fields.manifest_version !== 3)
    return notARecorder(dir, "its manifest is not Manifest V3.");
  const worker = fields.background?.service_worker;
  if (typeof worker !== "string" || !worker)
    return notARecorder(dir, "its manifest names no service worker.");
  const workerFile = await stat(join(dir, worker)).catch(() => null);
  if (!workerFile?.isFile())
    return notARecorder(dir, `its service worker ${worker} is missing.`);
  // Without a key the id would follow the directory's path, and nothing that knows the Recorder by
  // its one id (its native host, the server's list of Recorder origins) would recognise it.
  if (typeof fields.key !== "string" || !fields.key.trim())
    return notARecorder(
      dir,
      "its manifest has no key, so its id is not fixed.",
    );
  return {
    ok: true,
    recorder: { dir, id: extensionIdFromKey(fields.key), worker },
  };
}

/** Any of the Recorder's own pages: never one of the person's tabs. */
export function isRecorderPage(url: string, recorderId: string): boolean {
  return url.startsWith(`chrome-extension://${recorderId}/`);
}

/**
 * The Recorder's setup and connect pages.
 *
 * Both exist for a browser a person installed the Recorder into by hand: setup asks for the
 * microphone and connect asks for an OpenBot. In a browser OpenBot opened, the microphone is granted
 * at launch and the connection is handed in, so neither has anything left to ask, and the browser
 * closes either one the moment it appears.
 */
export function isRecorderSetupPage(url: string, recorderId: string): boolean {
  if (!isRecorderPage(url, recorderId)) return false;
  const path = new URL(url).pathname;
  return path === "/setup.html" || path === "/connect.html";
}

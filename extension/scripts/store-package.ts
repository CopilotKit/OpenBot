// The Recorder's two store packages, made from the built Recorder (`bun run build` at the repository root first):
// `chrome-web-store.zip` for the Chrome Web Store and `edge-add-ons.zip` for Edge Add-ons. Neither store accepts the
// manifest's `key` field, so both packages leave it out. The Chrome package carries the Recorder's private key instead,
// as `key.pem` at the zip's root: the Chrome docs say an item's first upload keeps the id that key gives when key.pem
// sits in the extension's top directory, so the store copy keeps the Recorder's one fixed id
// (https://chromium.googlesource.com/chromium/src/+/refs/tags/60.0.3112.1/chrome/common/extensions/docs/templates/articles/packaging.html).
// Edge Add-ons always assigns its own id, so its package carries no key.
//
// The private key is read from the path in OPENBOT_RECORDER_SIGNING_KEY, else ~/.config/openbot-recorder, and goes
// nowhere but into the Chrome zip, built in memory: it is never printed and never written to disk on its own. The zips
// are refused anywhere inside a git work tree, so a package holding the key cannot be committed by accident.
//
//   bun extension/scripts/store-package.ts <folder outside git> [--dist <built Recorder>]
import { spawnSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import { type Zippable, zipSync } from "fflate";
import { verifyDist } from "./verify-dist";

export const CHROME_PACKAGE = "chrome-web-store.zip";
export const EDGE_PACKAGE = "edge-add-ons.zip";
/** Where the Chrome Web Store looks for the key on a new item's first upload. */
export const KEY_FILE = "key.pem";
export const SIGNING_KEY_VARIABLE = "OPENBOT_RECORDER_SIGNING_KEY";
/** The Chrome Web Store refuses an upload whose manifest description is longer, and shows it as the item's summary:
 * https://developer.chrome.com/docs/webstore/prepare */
export const DESCRIPTION_MAX = 132;
/** Every entry gets the same time, so the same build makes the same package. */
const ENTRY_TIME = new Date(2026, 0, 1);

/** A refusal the person can act on: its message is printed alone, with no stack. */
export class StorePackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorePackageError";
  }
}

/** The path in OPENBOT_RECORDER_SIGNING_KEY, else the key's home in the person's own config. */
export function signingKeyPath(
  env: Record<string, string | undefined>,
  home: string,
): string {
  const configured = env[SIGNING_KEY_VARIABLE]?.trim();
  return configured
    ? configured
    : path.join(home, ".config", "openbot-recorder", "recorder-extension.pem");
}

/** The id Chrome gives an extension: the first 128 bits of the SHA-256 of its public key, each hex digit as a to p. */
export function extensionIdFor(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  const digest = createHash("sha256").update(der).digest("hex");
  return [...digest.slice(0, 32)]
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    .join("");
}

function publicKeyFromManifest(value: unknown): KeyObject {
  if (typeof value !== "string" || value.length === 0)
    throw new StorePackageError(
      "The built manifest has no key, so the Recorder's id is not fixed. Build it with `bun run build` at the repository root.",
    );
  return createPublicKey({
    key: Buffer.from(value, "base64"),
    format: "der",
    type: "spki",
  });
}

/**
 * The signing key as Chrome's own packer writes it (PKCS#8 PEM), checked against the public key the built manifest
 * carries: a key that does not match would give the store item another id. The error names the path, never the key.
 */
export function readSigningKey(keyPath: string, manifestKey: unknown): string {
  if (!existsSync(keyPath))
    throw new StorePackageError(
      `No signing key at ${keyPath}. Put the path to the Recorder's private key in ${SIGNING_KEY_VARIABLE}.`,
    );
  let key: KeyObject;
  try {
    key = createPrivateKey(readFileSync(keyPath));
  } catch {
    throw new StorePackageError(`${keyPath} is not a private key in PEM form.`);
  }
  const expected = publicKeyFromManifest(manifestKey);
  const actual = createPublicKey(key);
  if (
    !actual
      .export({ type: "spki", format: "der" })
      .equals(expected.export({ type: "spki", format: "der" }))
  )
    throw new StorePackageError(
      `The key at ${keyPath} gives the id ${extensionIdFor(actual)}, not the built Recorder's ${extensionIdFor(expected)}. Use the key that matches extension/keys/public-key.txt.`,
    );
  return key.export({ type: "pkcs8", format: "pem" }).toString();
}

function listFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return found.sort();
}

/** The manifest both stores take: the built one without `key`, which neither store accepts. */
export function storeManifest(
  manifest: Record<string, unknown>,
): Record<string, unknown> {
  const { key: _key, ...rest } = manifest;
  return rest;
}

/**
 * Both packages, in memory, from a built Recorder that `verifyDist` passes as a release of `rootVersion`. Refuses a
 * build with a key file in it (it would reach the Edge package), a dotfile (Finder's .DS_Store), or a description the
 * Chrome Web Store would refuse.
 */
export function storePackages(input: {
  dist: string;
  rootVersion: string;
  keyPath: string;
}): {
  chrome: Uint8Array;
  edge: Uint8Array;
  id: string;
  version: string;
  files: number;
} {
  const { dist, rootVersion, keyPath } = input;
  if (!existsSync(path.join(dist, "manifest.json")))
    throw new StorePackageError(
      `No built Recorder at ${dist}. Run \`bun run build\` at the repository root first.`,
    );
  const problems = verifyDist(dist, { variant: "release", rootVersion });
  if (problems.length > 0)
    throw new StorePackageError(
      `The build at ${dist} is not a release build of ${rootVersion}:\n${problems.join("\n")}`,
    );

  const manifest = JSON.parse(
    readFileSync(path.join(dist, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  const description = String(manifest.description ?? "");
  if (description.length > DESCRIPTION_MAX)
    throw new StorePackageError(
      `The manifest description is ${description.length} characters; the Chrome Web Store takes at most ${DESCRIPTION_MAX}.`,
    );
  const names = listFiles(dist);
  const stray = names.filter(
    (name) =>
      name.toLowerCase().endsWith(".pem") ||
      name.split("/").some((part) => part.startsWith(".")),
  );
  if (stray.length > 0)
    throw new StorePackageError(
      `The build at ${dist} holds files no store package may carry: ${stray.join(", ")}.`,
    );

  const privateKey = readSigningKey(keyPath, manifest.key);
  const id = extensionIdFor(publicKeyFromManifest(manifest.key));

  const contents: Zippable = {};
  for (const name of names) {
    if (name === "manifest.json") continue;
    contents[name] = readFileSync(path.join(dist, name));
  }
  // Written as the build writes it, so the only difference is the missing key.
  contents["manifest.json"] = new TextEncoder().encode(
    `${JSON.stringify(storeManifest(manifest), null, 2)}\n`,
  );
  const options = { mtime: ENTRY_TIME, level: 9 } as const;
  return {
    chrome: zipSync(
      { ...contents, [KEY_FILE]: new TextEncoder().encode(privateKey) },
      options,
    ),
    edge: zipSync(contents, options),
    id,
    version: String(manifest.version),
    files: names.length,
  };
}

/** True when `dir`, or the nearest folder above it that exists, is inside a git work tree. */
export function insideGitWorkTree(dir: string): boolean {
  let existing = path.resolve(dir);
  while (!existsSync(existing)) existing = path.dirname(existing);
  const answer = spawnSync(
    "git",
    ["-C", existing, "rev-parse", "--is-inside-work-tree"],
    { encoding: "utf8" },
  );
  return answer.status === 0 && answer.stdout.trim() === "true";
}

async function main() {
  const root = path.resolve(import.meta.dir, "..", "..");
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: { dist: { type: "string" } },
    allowPositionals: true,
  });
  const [out] = positionals;
  if (!out || positionals.length > 1) {
    console.error(
      "Usage: bun extension/scripts/store-package.ts <folder outside git> [--dist <built Recorder>]",
    );
    process.exit(2);
  }
  const outDir = path.resolve(out);
  try {
    if (insideGitWorkTree(outDir))
      throw new StorePackageError(
        `${outDir} is inside a git work tree. The Chrome package holds the Recorder's private key, so write it to a folder outside git.`,
      );
    const rootVersion = (
      JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    const made = storePackages({
      dist: path.resolve(values.dist ?? path.join(root, "extension", "dist")),
      rootVersion,
      keyPath: signingKeyPath(process.env, homedir()),
    });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, CHROME_PACKAGE), made.chrome, {
      mode: 0o600,
    });
    writeFileSync(path.join(outDir, EDGE_PACKAGE), made.edge);
    console.log(
      [
        `OpenBot Recorder ${made.version}, ${made.files} files, id ${made.id}${made.id === RECORDER_EXTENSION_ID ? " (the Recorder's fixed id)" : ""}`,
        `${path.join(outDir, CHROME_PACKAGE)}: no manifest key, ${KEY_FILE} at its root (${made.chrome.length} bytes)`,
        `${path.join(outDir, EDGE_PACKAGE)}: no manifest key, no key file (${made.edge.length} bytes)`,
      ].join("\n"),
    );
  } catch (error) {
    if (!(error instanceof StorePackageError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}

if (import.meta.main) await main();

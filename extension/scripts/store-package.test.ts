// The store packages, made the way David makes them: the script run as a command against a built Recorder, with a
// throwaway signing key made here (never the Recorder's real one), and the zips it writes opened again.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import {
  CHROME_PACKAGE,
  EDGE_PACKAGE,
  extensionIdFor,
  KEY_FILE,
  SIGNING_KEY_VARIABLE,
  signingKeyPath,
} from "./store-package";

const SCRIPT = join(import.meta.dir, "store-package.ts");
const REPO = join(import.meta.dir, "..", "..");
const ROOT_VERSION = (
  JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
    version: string;
  }
).version;

type Throwaway = { pem: string; body: string; spki: string; id: string };

function throwawayKey(): Throwaway {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    pem,
    // The base64 between the PEM's armour lines: what must never be printed or reach the Edge package.
    body: pem.split("\n").slice(1, -2).join(""),
    spki: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    id: extensionIdFor(publicKey),
  };
}

let roots: string[] = [];
const scratch = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};
beforeEach(() => {
  roots = [];
});
afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** A built Recorder as `bun run build` writes it, its manifest carrying `key`'s public half. */
function builtRecorder(
  key: Throwaway,
  overrides: Record<string, string> = {},
): { dist: string; files: Record<string, string> } {
  const manifest = {
    manifest_version: 3,
    name: "OpenBot Recorder",
    version: ROOT_VERSION,
    description:
      "Record a task in your browser so an OpenBot Bot can learn to do it.",
    icons: { "16": "icons/16.png", "128": "icons/128.png" },
    action: {
      default_popup: "popup.html",
      default_icon: { "16": "icons/16.png" },
    },
    background: { service_worker: "service-worker.js", type: "module" },
    options_page: "options.html",
    permissions: ["storage", "debugger"],
    host_permissions: ["<all_urls>"],
    storage: { managed_schema: "managed_schema.json" },
    key: key.spki,
  };
  const files: Record<string, string> = {
    "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "service-worker.js": "console.log('worker');",
    "popup.html": '<script type="module" src="./assets/popup.js"></script>',
    "options.html": '<link rel="stylesheet" href="./assets/options.css">',
    "offscreen.html":
      '<script type="module" src="./assets/offscreen.js"></script>',
    "assets/popup.js": "console.log('popup');",
    "content.js": "(function(){console.log('content');})();",
    "page-network.js": "(function(){console.log('page');})();",
    "managed_schema.json": "{}",
    "icons/16.png": "png16",
    "icons/128.png": "png128",
    ...overrides,
  };
  const dist = scratch("store-package-dist-");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dist, name)), { recursive: true });
    writeFileSync(join(dist, name), content);
  }
  return { dist, files };
}

function keyFile(key: Throwaway): string {
  const path = join(scratch("store-package-key-"), "throwaway.pem");
  writeFileSync(path, key.pem, { mode: 0o600 });
  return path;
}

function run(args: string[], keyPath: string) {
  const result = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
    env: { ...process.env, [SIGNING_KEY_VARIABLE]: keyPath },
  });
  return {
    code: result.exitCode,
    out: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

const text = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

test("the Chrome package is the built Recorder without the manifest key and with key.pem at its root; Edge's has no key at all", () => {
  const key = throwawayKey();
  const { dist, files } = builtRecorder(key);
  const out = join(scratch("store-package-out-"), "packages");

  const result = run([out, "--dist", dist], keyFile(key));
  expect(result.code).toBe(0);
  expect(result.out).toContain(`id ${key.id}`);
  expect(result.out).not.toContain(key.body);

  const chrome = unzipSync(readFileSync(join(out, CHROME_PACKAGE)));
  const edge = unzipSync(readFileSync(join(out, EDGE_PACKAGE)));
  const built = Object.keys(files).sort();
  expect(Object.keys(chrome).sort()).toEqual([...built, KEY_FILE].sort());
  expect(Object.keys(edge).sort()).toEqual(built);

  const { key: _key, ...withoutKey } = JSON.parse(files["manifest.json"]);
  for (const zip of [chrome, edge]) {
    const manifest = JSON.parse(text(zip["manifest.json"]) ?? "{}");
    expect("key" in manifest).toBe(false);
    expect(manifest).toEqual(withoutKey);
    for (const name of built.filter((name) => name !== "manifest.json"))
      expect(text(zip[name])).toBe(files[name]);
  }

  // The key Chrome reads is the one whose public half the build carries, in the PKCS#8 form Chrome's packer writes.
  const packed = text(chrome[KEY_FILE]) ?? "";
  expect(packed.startsWith("-----BEGIN PRIVATE KEY-----\n")).toBe(true);
  expect(
    createPublicKey(createPrivateKey(packed))
      .export({ type: "spki", format: "der" })
      .toString("base64"),
  ).toBe(key.spki);

  for (const bytes of Object.values(edge))
    expect(text(bytes)).not.toContain(key.body);
});

test("a key that is not the build's own is refused, names both ids, and writes nothing", () => {
  const key = throwawayKey();
  const other = throwawayKey();
  const { dist } = builtRecorder(key);
  const out = join(scratch("store-package-out-"), "packages");

  const result = run([out, "--dist", dist], keyFile(other));
  expect(result.code).toBe(1);
  expect(result.out).toContain(`gives the id ${other.id}`);
  expect(result.out).toContain(key.id);
  expect(result.out).not.toContain(other.body);
  expect(existsSync(out)).toBe(false);
});

test("a folder inside a git work tree is refused, since the Chrome package holds the private key", () => {
  const key = throwawayKey();
  const { dist } = builtRecorder(key);
  const inside = join(REPO, "extension", "store-package-refused");

  const result = run([inside, "--dist", dist], keyFile(key));
  expect(result.code).toBe(1);
  expect(result.out).toContain("inside a git work tree");
  expect(existsSync(inside)).toBe(false);
});

test("an e2e build, or a build holding a key file that would reach the Edge package, is refused", () => {
  const key = throwawayKey();
  const out = join(scratch("store-package-out-"), "packages");
  const keyPath = keyFile(key);

  const e2e = builtRecorder(key, {
    "service-worker.js": "globalThis.RECORDER_E2E = true;",
  });
  const hook = run([out, "--dist", e2e.dist], keyPath);
  expect(hook.code).toBe(1);
  expect(hook.out).toContain("e2e-only hook");

  const stray = builtRecorder(key, { "key.pem": key.pem });
  const pem = run([out, "--dist", stray.dist], keyPath);
  expect(pem.code).toBe(1);
  expect(pem.out).toContain("no store package may carry: key.pem");
  expect(pem.out).not.toContain(key.body);

  expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
});

test("the signing key comes from OPENBOT_RECORDER_SIGNING_KEY, else from ~/.config/openbot-recorder", () => {
  expect(signingKeyPath({ [SIGNING_KEY_VARIABLE]: "/keys/r.pem" }, "/u")).toBe(
    "/keys/r.pem",
  );
  expect(signingKeyPath({}, "/u")).toBe(
    "/u/.config/openbot-recorder/recorder-extension.pem",
  );
  expect(signingKeyPath({ [SIGNING_KEY_VARIABLE]: "  " }, "/u")).toBe(
    "/u/.config/openbot-recorder/recorder-extension.pem",
  );
});

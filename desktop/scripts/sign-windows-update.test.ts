/**
 * The Windows signing run's sign-update job, run as the workflow runs it: the real Tauri CLI signs
 * with a key made for the test, and the real minisign checks the signature against the public key
 * the app is built with.
 *
 * minisign is installed where the release regressions run (desktop-macos-signing.yml), which sets
 * OPENBOT_REQUIRE_MINISIGN so a missing one fails there instead of skipping.
 */
import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const script = join(root, "desktop/scripts/sign-windows-update.sh");
const tauri = join(root, "desktop/node_modules/.bin/tauri");
const realOverlay = join(
  root,
  "desktop/src-tauri/tauri.windows-signing.conf.json",
);
const minisign = Bun.which("minisign");
if (!minisign && process.env.OPENBOT_REQUIRE_MINISIGN === "1") {
  throw new Error("minisign is not installed, and these tests must run here.");
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function temp() {
  const dir = mkdtempSync(join(tmpdir(), "sign-windows-update-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A key pair made the way the real one was, `tauri signer generate`, with a password. */
function keyPair(dir: string) {
  const password = "test-password";
  const path = join(dir, "updater.key");
  const made = Bun.spawnSync(
    [tauri, "signer", "generate", "--ci", "-p", password, "-w", path, "-f"],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(made.exitCode).toBe(0);
  return {
    privateKey: readFileSync(path, "utf8"),
    password,
    pubkey: readFileSync(`${path}.pub`, "utf8").trim(),
  };
}

/** The real Windows overlay with another public key, as a key rotated in one place would leave it. */
function overlayWith(dir: string, pubkey: string) {
  const overlay = JSON.parse(readFileSync(realOverlay, "utf8"));
  overlay.plugins.updater.pubkey = pubkey;
  const path = join(dir, "tauri.windows-signing.conf.json");
  writeFileSync(path, JSON.stringify(overlay));
  return path;
}

/** The signing job's artifact, laid out as download-artifact leaves it. */
function artifact(dir: string, record: Record<string, string>) {
  const artifacts = join(dir, "artifacts");
  const nsis = join(artifacts, "src-tauri/target/release/bundle/nsis");
  mkdirSync(nsis, { recursive: true });
  writeFileSync(join(artifacts, "build-version.json"), JSON.stringify(record));
  const installer = join(nsis, "OpenBot_0.3.2_x64-setup.exe");
  // Bytes that stand for the Authenticode-signed installer; the signature covers whatever is here.
  writeFileSync(installer, crypto.getRandomValues(new Uint8Array(4096)));
  return { artifacts, installer };
}

function sign(
  dir: string,
  artifacts: string,
  key: { privateKey: string; password: string },
  overlay: string,
) {
  const result = Bun.spawnSync(["bash", script], {
    cwd: dir,
    env: {
      ...process.env,
      ARTIFACTS: artifacts,
      OVERLAY: overlay,
      TAURI_SIGNING_PRIVATE_KEY: key.privateKey,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: key.password,
      RUNNER_TEMP: dir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString() + result.stderr.toString(),
  };
}

const stable = { version: "0.3.2", channel: "release" };

/** minisign's own verdict on a Tauri signature file, the way the updater reads it. */
function verifies(dir: string, file: string, pubkey: string) {
  writeFileSync(join(dir, "check.pub"), Buffer.from(pubkey, "base64"));
  writeFileSync(
    join(dir, "check.minisig"),
    Buffer.from(readFileSync(`${file}.sig`, "utf8"), "base64"),
  );
  return (
    Bun.spawnSync([
      minisign as string,
      "-V",
      "-q",
      "-p",
      join(dir, "check.pub"),
      "-m",
      file,
      "-x",
      join(dir, "check.minisig"),
    ]).exitCode === 0
  );
}

test.skipIf(!minisign)(
  "the installer is signed for the updater with the key whose public half the app carries",
  () => {
    const dir = temp();
    const key = keyPair(dir);
    const { artifacts, installer } = artifact(dir, stable);
    const result = sign(dir, artifacts, key, overlayWith(dir, key.pubkey));
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      "Signed OpenBot_0.3.2_x64-setup.exe for the updater",
    );
    expect(verifies(dir, installer, key.pubkey)).toBe(true);
    // The private key never reaches the log.
    expect(result.out).not.toContain(key.privateKey.trim());
    // Over these exact bytes: one byte more and it no longer verifies.
    writeFileSync(
      installer,
      Buffer.concat([readFileSync(installer), Buffer.from([0])]),
    );
    expect(verifies(dir, installer, key.pubkey)).toBe(false);
  },
  30_000,
);

// The real overlay carries the production public key, which this test key is not the pair of. A
// signature every installed app would refuse fails the job rather than reaching latest.json.
test.skipIf(!minisign)(
  "a key that is not the pair of the app's public key fails the job",
  () => {
    const dir = temp();
    const key = keyPair(dir);
    const { artifacts } = artifact(dir, stable);
    const result = sign(dir, artifacts, key, realOverlay);
    expect(result.code).toBe(1);
    expect(result.out).toContain(
      "does not verify against plugins.updater.pubkey in tauri.windows-signing.conf.json",
    );
  },
  30_000,
);

test("a pinned build has no updater to sign for", () => {
  const dir = temp();
  const { artifacts } = artifact(dir, {
    ...stable,
    version: "0.3.2-rc.1",
    pinned: "v0.3.2-rc.1",
  });
  const result = sign(
    dir,
    artifacts,
    { privateKey: "unused", password: "" },
    realOverlay,
  );
  expect(result.code).toBe(1);
  expect(result.out).toContain("a pinned build has no updater to sign for");
});

test("anything but exactly one installer is not signed", () => {
  const dir = temp();
  const { artifacts, installer } = artifact(dir, stable);
  writeFileSync(installer.replace("0.3.2_x64", "0.3.2_arm64"), "second");
  const result = sign(
    dir,
    artifacts,
    { privateKey: "unused", password: "" },
    realOverlay,
  );
  expect(result.code).toBe(1);
  expect(result.out).toContain("Expected one signed -setup.exe");
});

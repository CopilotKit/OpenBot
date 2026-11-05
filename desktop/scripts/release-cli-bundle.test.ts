/**
 * Release builds carry the Intelligence CLI.
 *
 * The standalone app sets up Intelligence only through the CLI it bundles; a build without it
 * cannot get past Account. The signed builds are the ones people install, and the Mac one is what
 * the in-place updater puts on every Mac, so both signing workflows are held to bundling it here,
 * and the scripts that sign and check the Mac bundle are run on a stand-in.
 */
import { afterEach, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..", "..");
const scripts = import.meta.dir;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function workflow(name: string): string {
  return readFileSync(join(repository, ".github", "workflows", name), "utf8");
}

/** The text of the step called `name`, up to the next step. */
function step(text: string, name: string): string {
  const start = text.indexOf(`- name: ${name}\n`);
  expect(start, `no step "${name}"`).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.search(/\n {6}- (name|uses):/);
  return next === -1 ? rest : rest.slice(0, next);
}

test("the bundle overlay puts the CLI in the app's resources", () => {
  const overlay = JSON.parse(
    readFileSync(
      join(repository, "desktop/src-tauri/tauri.bundled-cli.conf.json"),
      "utf8",
    ),
  );
  expect(overlay.bundle.resources).toEqual({ "cli-bundle/": "cli-bundle/" });
});

test("the signed Mac build bundles, signs and checks the CLI", () => {
  const text = workflow("desktop-macos-signing.yml");
  const bundle = step(text, "Bundle the Intelligence CLI");
  expect(bundle).toContain("bun desktop/scripts/cli-bundle.ts darwin");
  expect(bundle).toContain("darwin-aarch64) arch=arm64");
  expect(bundle).toContain("darwin-x86_64) arch=x64");
  const sign = step(text, "Sign the bundled CLI's binaries");
  expect(sign).toContain("desktop/scripts/sign-cli-bundle.sh");
  const build = step(text, "Build, sign and notarize");
  expect(build).toContain('OPENBOT_BUNDLED_CLI: "1"');
  expect(build).toContain("--config src-tauri/tauri.bundled-cli.conf.json");
  // Bundled and signed before the build pins the runtime's digest.
  expect(text.indexOf("- name: Bundle the Intelligence CLI")).toBeLessThan(
    text.indexOf("- name: Sign the bundled CLI's binaries"),
  );
  expect(text.indexOf("- name: Sign the bundled CLI's binaries")).toBeLessThan(
    text.indexOf("- name: Build, sign and notarize"),
  );
  const verify = step(
    text,
    "Verify the signature, Gatekeeper and the notarization ticket",
  );
  expect(verify).toContain(
    'desktop/scripts/verify-cli-bundle.sh "$app" developer-id',
  );
});

test("the signed Windows build bundles the CLI and checks the installer has it", () => {
  const text = workflow("desktop-signing.yml");
  expect(step(text, "Bundle the Intelligence CLI")).toContain(
    "bun desktop/scripts/cli-bundle.ts win32 x64",
  );
  const build = step(text, "Build and sign");
  expect(build).toContain('OPENBOT_BUNDLED_CLI: "1"');
  expect(build).toContain("--config src-tauri/tauri.bundled-cli.conf.json");
  const verify = step(
    text,
    "Verify the installer carries the Intelligence CLI",
  );
  expect(verify).toContain("cli-bundle\\runtime\\node.exe");
  expect(verify).toContain("cli-bundle\\cli\\index.js");
});

/** A stand-in OpenBot.app: a signed main program and, unless `withCli` is false, a CLI bundle. */
function standInApp(withCli = true): string {
  const root = mkdtempSync(join(tmpdir(), "openbot-cli-bundle-"));
  directories.push(root);
  const app = join(root, "OpenBot.app");
  const macos = join(app, "Contents", "MacOS");
  mkdirSync(macos, { recursive: true });
  copyFileSync("/usr/bin/true", join(macos, "openbot-desktop"));
  if (withCli) {
    const bundle = join(app, "Contents", "Resources", "cli-bundle");
    mkdirSync(join(bundle, "runtime"), { recursive: true });
    mkdirSync(join(bundle, "cli", "node_modules", "addon"), {
      recursive: true,
    });
    copyFileSync("/usr/bin/true", join(bundle, "runtime", "node"));
    // A native module npm installed, signed by somebody else.
    copyFileSync(
      "/usr/bin/true",
      join(bundle, "cli", "node_modules", "addon", "addon.node"),
    );
    writeFileSync(join(bundle, "cli", "index.js"), "console.log('cli');\n");
  }
  return app;
}

function run(command: string[]) {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  return {
    code: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

const onMac = process.platform === "darwin";

test.if(onMac)("an app with no CLI fails the check", () => {
  const app = standInApp(false);
  const checked = run([join(scripts, "verify-cli-bundle.sh"), app, "adhoc"]);
  expect(checked.code).not.toBe(0);
  expect(checked.output).toContain("has no bundled CLI");
});

test.if(onMac)(
  "every Mach-O in the bundle is signed hardened, and the runtime without get-task-allow",
  () => {
    const app = standInApp();
    const bundle = join(app, "Contents", "Resources", "cli-bundle");
    // As Node ships: get-task-allow, which notarization refuses.
    const debuggable = join(bundle, "debuggable.plist");
    writeFileSync(
      debuggable,
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>com.apple.security.get-task-allow</key><true/></dict></plist>\n',
    );
    const node = join(bundle, "runtime", "node");
    expect(
      run([
        "codesign",
        "--force",
        "--sign",
        "-",
        "--options",
        "runtime",
        "--entitlements",
        debuggable,
        node,
      ]).code,
    ).toBe(0);
    rmSync(debuggable);
    const before = run([join(scripts, "verify-cli-bundle.sh"), app, "adhoc"]);
    expect(before.code).not.toBe(0);

    const signed = run([
      join(scripts, "sign-cli-bundle.sh"),
      bundle,
      "-",
      join(repository, "desktop/src-tauri/cli-bundle.entitlements.plist"),
    ]);
    expect(signed.code, signed.output).toBe(0);
    expect(signed.output).toContain("1 other Mach-O files");
    const after = run([join(scripts, "verify-cli-bundle.sh"), app, "adhoc"]);
    expect(after.code, after.output).toBe(0);
    expect(after.output).toContain("2 Mach-O files");
    // The runtime keeps what V8 needs under the hardened runtime, and nothing more.
    const entitlements = run([
      "codesign",
      "-d",
      "--entitlements",
      "-",
      "--xml",
      node,
    ]);
    expect(entitlements.output).toContain("com.apple.security.cs.allow-jit");
    expect(entitlements.output).not.toContain("get-task-allow");
  },
);

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
import { CLI_OVERLAY, planSignedBuild, type Runner } from "./signed-build";

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

test("the signed Mac build goes through signed-build.ts and checks the CLI it carries", () => {
  const text = workflow("desktop-macos-signing.yml");
  expect(step(text, "Build, sign and notarize")).toContain(
    'bun desktop/scripts/signed-build.ts darwin "$ARCH"',
  );
  expect(
    step(text, "Verify the signature, Gatekeeper and the notarization ticket"),
  ).toContain('desktop/scripts/verify-cli-bundle.sh "$app" developer-id');
});

test("the signed Windows build goes through signed-build.ts and checks the installer has the CLI", () => {
  const text = workflow("desktop-signing.yml");
  expect(step(text, "Build and sign")).toContain("signed-build.ts win32 x64");
  const verify = step(
    text,
    "Verify the installer carries the Intelligence CLI",
  );
  expect(verify).toContain("cli-bundle\\runtime\\node.exe");
  expect(verify).toContain("cli-bundle\\cli\\index.js");
});

/** A desktop/ folder signed-build.ts can plan for, with the bundled CLI's overlay. */
function signedDesktop(): string {
  const dir = mkdtempSync(join(tmpdir(), "openbot-signed-cli-"));
  directories.push(dir);
  mkdirSync(join(dir, "src-tauri"));
  for (const file of [
    "src-tauri/tauri.macos-signing.conf.json",
    "src-tauri/tauri.windows-signing.conf.json",
    "src-tauri/tauri.bundled-cli.conf.json",
  ]) {
    copyFileSync(join(repository, "desktop", file), join(dir, file));
  }
  writeFileSync(
    join(dir, "build-version.json"),
    JSON.stringify({
      version: "0.3.0",
      sourceSha: "a".repeat(40),
      channel: "release",
    }),
  );
  return dir;
}

function plannedCommands(
  platform: "darwin" | "win32",
  signingIdentity?: string,
) {
  const dir = signedDesktop();
  const calls: string[][] = [];
  const run: Runner = (cmd) => {
    calls.push(cmd);
    return { code: 0, stdout: "", stderr: "" };
  };
  const plan = planSignedBuild({
    desktop: dir,
    platform,
    arch: platform === "darwin" ? "arm64" : "x64",
    overlay:
      platform === "darwin"
        ? "src-tauri/tauri.macos-signing.conf.json"
        : "src-tauri/tauri.windows-signing.conf.json",
    repository: "CopilotKit/OpenBot",
    workDir: join(dir, "work"),
    bun: "bun",
    run,
    signingIdentity,
  });
  return { plan, calls: calls.map((call) => call.join(" ")) };
}

test("a signed Mac build bundles the CLI, then signs its binaries before the build pins them", () => {
  const { plan, calls } = plannedCommands(
    "darwin",
    "Developer ID Application: Example (TEAM123456)",
  );
  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain("scripts/cli-bundle.ts darwin arm64");
  expect(calls[1]).toContain("scripts/sign-cli-bundle.sh");
  expect(calls[1]).toContain("Developer ID Application: Example (TEAM123456)");
  expect(calls[1]).toContain("cli-bundle.entitlements.plist");
  expect(plan.configs).toContain(CLI_OVERLAY);
  expect(plan.env.OPENBOT_BUNDLED_CLI).toBe("1");
});

test("a signed Windows build bundles the CLI and signs nothing in it itself", () => {
  const { plan, calls } = plannedCommands("win32");
  expect(calls).toEqual([
    expect.stringContaining("scripts/cli-bundle.ts win32 x64"),
  ]);
  expect(plan.configs).toContain(CLI_OVERLAY);
  expect(plan.env.OPENBOT_BUNDLED_CLI).toBe("1");
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

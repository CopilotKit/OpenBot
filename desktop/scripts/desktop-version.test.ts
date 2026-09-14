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

const directories: string[] = [];
const cargo =
  '[package]\nname = "openbot-desktop"\nversion = "0.0.10"\n\n[dependencies]\nexample = "0.0.10"\n';
const lock =
  'version = 4\n\n[[package]]\nname = "example"\nversion = "0.0.10"\n\n[[package]]\nname = "openbot-desktop"\nversion = "0.0.10"\ndependencies = ["example"]\n';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openbot-desktop-version-"));
  directories.push(root);
  mkdirSync(join(root, "desktop/src-tauri"), { recursive: true });
  mkdirSync(join(root, "desktop/scripts"));
  const write = (path: string, text: string) =>
    writeFileSync(join(root, path), text);
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  write("package.json", '{"version":"0.0.10"}');
  write(
    "desktop/src-tauri/tauri.conf.json",
    '{"version":"../../package.json"}',
  );
  write("desktop/src-tauri/Cargo.toml", cargo);
  write("desktop/src-tauri/Cargo.lock", lock);
  copyFileSync(
    join(import.meta.dir, "desktop-version.ts"),
    join(root, "desktop/scripts/desktop-version.ts"),
  );
  const run = (command: string) => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        join(root, "desktop/scripts/desktop-version.ts"),
        command,
      ],
      { cwd: tmpdir() },
    );
    return {
      code: result.exitCode,
      stderr: result.stderr.toString(),
      stdout: result.stdout.toString(),
    };
  };
  return { root, write, read, run };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("the checked-in Tauri version resolves the root release number", () => {
  const config = JSON.parse(
    readFileSync(
      resolve(import.meta.dir, "../src-tauri/tauri.conf.json"),
      "utf8",
    ),
  );
  expect(config.version).toBe("../../package.json");
});

test("sync changes only the desktop package versions and check rejects drift", () => {
  const f = fixture();
  f.write("package.json", '{"version":"0.0.11"}');
  expect(f.run("check").stderr).toContain("version drift");
  expect(f.run("sync").code).toBe(0);
  expect(f.read("desktop/src-tauri/Cargo.toml")).toBe(
    cargo.replace('version = "0.0.10"', 'version = "0.0.11"'),
  );
  expect(f.read("desktop/src-tauri/Cargo.lock")).toBe(
    lock.replace(
      'name = "openbot-desktop"\nversion = "0.0.10"',
      'name = "openbot-desktop"\nversion = "0.0.11"',
    ),
  );
  expect(f.run("check").code).toBe(0);
});

test.each([
  "{}",
  '{"version":10}',
  '{"version":"0.0.0"}',
  '{"version":"01.2.3"}',
  '{"version":"0.0.10-beta.1"}',
  "{",
])("rejects invalid root release metadata: %s", (json) => {
  const f = fixture();
  f.write("package.json", json);
  expect(f.run("sync").code).toBe(1);
  expect(f.read("desktop/src-tauri/Cargo.toml")).toBe(cargo);
});

test.each([
  "package.json",
  "desktop/src-tauri/Cargo.toml",
  "desktop/src-tauri/Cargo.lock",
])("rejects a missing version source: %s", (path) => {
  const f = fixture();
  rmSync(join(f.root, path));
  expect(f.run("check").code).toBe(1);
});

test.each([
  ["desktop/src-tauri/tauri.conf.json", '{"version":"0.0.10"}'],
  [
    "desktop/src-tauri/Cargo.toml",
    cargo.replace('version = "0.0.10"', 'version = "0.0.9"'),
  ],
  [
    "desktop/src-tauri/Cargo.lock",
    lock.replace(
      'name = "openbot-desktop"\nversion = "0.0.10"',
      'name = "openbot-desktop"\nversion = "0.0.9"',
    ),
  ],
  ["desktop/src-tauri/Cargo.toml", '[package]\nname = "openbot-desktop"\n'],
  [
    "desktop/src-tauri/Cargo.lock",
    '[[package]]\nname = "example"\nversion = "0.0.10"\n',
  ],
  ["desktop/src-tauri/Cargo.toml", "[package"],
  ["desktop/src-tauri/Cargo.lock", "[[package"],
])("rejects stale or malformed native metadata: %s", (path, value) => {
  const f = fixture();
  f.write(path, value);
  expect(f.run("check").code).toBe(1);
  expect(f.run("internal").code).toBe(1);
});

test.each(["internal", "release"])(
  "%s emits actual commit identity and compatible macOS metadata",
  (channel) => {
    const f = fixture();
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-C", f.root, ...args]);
      expect(result.exitCode).toBe(0);
      return result.stdout.toString().trim();
    };
    git("init", "--quiet");
    git(
      "-c",
      "user.name=Version test",
      "-c",
      "user.email=version@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "fixture",
    );
    const sourceSha = git("rev-parse", "HEAD");
    const version =
      channel === "internal"
        ? `0.0.10-internal.g${sourceSha.slice(0, 12)}`
        : "0.0.10";
    expect(f.run(channel).code).toBe(0);
    expect(JSON.parse(f.read("desktop/build-version.json"))).toEqual({
      version,
      releaseVersion: "0.0.10",
      sourceSha,
      channel,
    });
    expect(
      JSON.parse(f.read("desktop/src-tauri/tauri.build-version.conf.json")),
    ).toEqual({
      version,
      bundle: { macOS: { infoPlist: "build-version.plist" } },
    });
    const plist = f.read("desktop/src-tauri/build-version.plist");
    for (const [key, value] of Object.entries({
      CFBundleShortVersionString: "0.0.10",
      CFBundleVersion: "0.0.10",
      OpenBotBuildVersion: version,
      OpenBotSourceRevision: sourceSha,
    })) {
      expect(plist).toContain(`<key>${key}</key><string>${value}</string>`);
    }
    expect(f.read("desktop/src-tauri/Cargo.toml")).toBe(cargo);
    expect(f.read("desktop/src-tauri/Cargo.lock")).toBe(lock);
  },
);

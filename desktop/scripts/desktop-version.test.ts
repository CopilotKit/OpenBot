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
  // desktop-version.ts imports this file relatively.
  mkdirSync(join(root, "scripts"));
  copyFileSync(
    join(import.meta.dir, "../../scripts/release-version.ts"),
    join(root, "scripts/release-version.ts"),
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

/** Runs git in `root`, and fails the test on any error. */
function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync([
    "git",
    "-C",
    root,
    "-c",
    "user.name=Version test",
    "-c",
    "user.email=version@example.invalid",
    "-c",
    "commit.gpgsign=false",
    ...args,
  ]);
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
}

/** A fixture repository with one empty commit. Returns the commit. */
function firstCommit(root: string) {
  git(root, "init", "--quiet");
  git(root, "commit", "--allow-empty", "--quiet", "-m", "fixture");
  return git(root, "rev-parse", "HEAD");
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

test("macOS microphone capture has a nonempty system permission description", () => {
  // Tauri merges this conventional file even when a build-version plist is supplied.
  const plist = readFileSync(
    resolve(import.meta.dir, "../src-tauri/Info.plist"),
    "utf8",
  );
  expect(plist).toMatch(
    /<key>NSMicrophoneUsageDescription<\/key>\s*<string>\s*[^<\s][^<]*<\/string>/,
  );
});

test("macOS speech recognition for narration has a nonempty system permission description", () => {
  // Without it, asking for speech recognition ends the app (SFSpeechRecognizer.requestAuthorization).
  const plist = readFileSync(
    resolve(import.meta.dir, "../src-tauri/Info.plist"),
    "utf8",
  );
  expect(plist).toMatch(
    /<key>NSSpeechRecognitionUsageDescription<\/key>\s*<string>\s*[^<\s][^<]*<\/string>/,
  );
});

test("macOS signing uses the audio-input entitlement for microphone capture", () => {
  const native = resolve(import.meta.dir, "../src-tauri");
  const config = JSON.parse(
    readFileSync(join(native, "tauri.conf.json"), "utf8"),
  );
  expect(config.bundle.macOS.entitlements).toBe("./Entitlements.plist");
  const plist = readFileSync(
    join(native, config.bundle.macOS.entitlements),
    "utf8",
  );
  expect(plist).toMatch(
    /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\s*\/>/,
  );
});

test("macOS can ask Docker Desktop to quit while OpenBot updates it", () => {
  // Without both, macOS refuses the Apple event without asking (docker_desktop_update::quit).
  const native = resolve(import.meta.dir, "../src-tauri");
  expect(readFileSync(join(native, "Info.plist"), "utf8")).toMatch(
    /<key>NSAppleEventsUsageDescription<\/key>\s*<string>\s*[^<\s][^<]*<\/string>/,
  );
  expect(readFileSync(join(native, "Entitlements.plist"), "utf8")).toMatch(
    /<key>com\.apple\.security\.automation\.apple-events<\/key>\s*<true\s*\/>/,
  );
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
  '{"version":"0.0.0-rc.1"}',
  '{"version":"0.0.10-alpha.1"}',
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
    const sourceSha = firstCommit(f.root);
    // An internal build comes after the release package.json names, so it is the next patch's.
    const numeric = channel === "internal" ? "0.0.11" : "0.0.10";
    const version =
      channel === "internal"
        ? `0.0.11-internal.1.g${sourceSha.slice(0, 12)}`
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
      CFBundleShortVersionString: numeric,
      CFBundleVersion: numeric,
      OpenBotBuildVersion: version,
      OpenBotSourceRevision: sourceSha,
    })) {
      expect(plist).toContain(`<key>${key}</key><string>${value}</string>`);
    }
    expect(f.read("desktop/src-tauri/Cargo.toml")).toBe(cargo);
    expect(f.read("desktop/src-tauri/Cargo.lock")).toBe(lock);
  },
);

test("a release candidate syncs whole and keeps macOS metadata numeric", () => {
  const f = fixture();
  f.write("package.json", '{"version":"0.3.0-rc.1"}');
  expect(f.run("sync").code).toBe(0);
  expect(f.read("desktop/src-tauri/Cargo.toml")).toContain(
    'version = "0.3.0-rc.1"',
  );
  expect(f.read("desktop/src-tauri/Cargo.lock")).toContain(
    'name = "openbot-desktop"\nversion = "0.3.0-rc.1"',
  );
  const sourceSha = firstCommit(f.root);
  expect(f.run("internal").code).toBe(0);
  const version = `0.3.0-rc.1.internal.1.g${sourceSha.slice(0, 12)}`;
  expect(JSON.parse(f.read("desktop/build-version.json"))).toEqual({
    version,
    releaseVersion: "0.3.0-rc.1",
    sourceSha,
    channel: "internal",
  });
  const plist = f.read("desktop/src-tauri/build-version.plist");
  for (const key of ["CFBundleShortVersionString", "CFBundleVersion"]) {
    expect(plist).toContain(`<key>${key}</key><string>0.3.0</string>`);
  }
  // After the candidate it was built from, and before the next candidate and the release.
  // `0.3.0-rc.1-internal.…` ordered after rc.2 as well, because `1-internal` is text.
  expect(Bun.semver.order(version, "0.3.0-rc.1")).toBe(1);
  expect(Bun.semver.order(version, "0.3.0-rc.2")).toBe(-1);
  expect(Bun.semver.order(version, "0.3.0-rc.10")).toBe(-1);
  expect(Bun.semver.order(version, "0.3.0")).toBe(-1);
});

/*
 * Installed over the released 0.3.3, the internal build 0.3.3-internal.860.g3b400d2c…, made from
 * main after the release, was a prerelease of 0.3.3 and so ordered before it: the Windows installer
 * said a newer version was already installed and chose "Uninstall before installing". package.json
 * names the last release, so an internal build is a prerelease of the next patch instead.
 */
test("an internal build made after a release orders after it and before the next release", () => {
  const f = fixture();
  f.write("package.json", '{"version":"0.3.3"}');
  expect(f.run("sync").code).toBe(0);
  const sourceSha = firstCommit(f.root);
  expect(f.run("internal").code).toBe(0);
  const version = JSON.parse(f.read("desktop/build-version.json")).version;
  expect(version).toBe(`0.3.4-internal.1.g${sourceSha.slice(0, 12)}`);
  expect(Bun.semver.order(version, "0.3.3")).toBe(1);
  expect(Bun.semver.order("0.3.3", version)).toBe(-1);
  // Before whichever release comes next, so that release still installs over it as an upgrade.
  for (const next of ["0.3.4", "0.4.0", "1.0.0"]) {
    expect(Bun.semver.order(version, next)).toBe(-1);
  }
  // The numeric fields move forward with it on macOS, as Tauri's Windows fields (0.3.4.0) do.
  const plist = f.read("desktop/src-tauri/build-version.plist");
  for (const key of ["CFBundleShortVersionString", "CFBundleVersion"]) {
    expect(plist).toContain(`<key>${key}</key><string>0.3.4</string>`);
  }
  // The release build of the same tree is still the plain release version.
  expect(f.run("release").code).toBe(0);
  expect(JSON.parse(f.read("desktop/build-version.json")).version).toBe(
    "0.3.3",
  );
});

/*
 * The orders above use Bun.semver.order. The Windows installer's SemverCompare (nsis_tauri_utils)
 * and the app's updater compare with the `semver` crate, which follows semver precedence; so does
 * Bun, shown by the precedence example semver.org gives.
 */
test("the comparison these tests use is semver precedence", () => {
  const precedence = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
  ];
  expect([...precedence].reverse().sort(Bun.semver.order)).toEqual(precedence);
});

/*
 * The Windows installer compares the version it installs with the one installed, by semver, and
 * semver compares a prerelease identifier that is not a number as text. Named after the commit
 * alone, 0.3.1-internal.g4400ba023e0c (the later build) sorted before 0.3.1-internal.gd298debe26f2,
 * and the installer said a newer version was already installed. `Bun.semver.order` follows the
 * same semver precedence as the `semver` crate the installer's SemverCompare and the app use.
 */
test("a later internal build orders after an earlier one whatever their hashes", () => {
  const f = fixture();
  const earlier = firstCommit(f.root);
  expect(f.run("internal").code).toBe(0);
  const first = JSON.parse(f.read("desktop/build-version.json")).version;
  // The next commit, chosen so its hash sorts before the earlier one's, as 4400ba02 did d298debe.
  const tree = git(f.root, "rev-parse", "HEAD^{tree}");
  let later = "";
  for (let attempt = 0; !later; attempt += 1) {
    const sha = git(
      f.root,
      "commit-tree",
      tree,
      "-p",
      earlier,
      "-m",
      `next ${attempt}`,
    );
    if (sha.slice(0, 12) < earlier.slice(0, 12)) later = sha;
  }
  git(f.root, "update-ref", "HEAD", later);
  expect(f.run("internal").code).toBe(0);
  const second = JSON.parse(f.read("desktop/build-version.json")).version;
  expect(Bun.semver.order(first, second)).toBe(-1);
  expect(Bun.semver.order(second, first)).toBe(1);
  expect(first).toBe(`0.0.11-internal.1.g${earlier.slice(0, 12)}`);
  expect(second).toBe(`0.0.11-internal.2.g${later.slice(0, 12)}`);
  // Both order after the release package.json names, and before the next one.
  for (const build of [first, second]) {
    expect(Bun.semver.order(build, "0.0.10")).toBe(1);
    expect(Bun.semver.order(build, "0.0.11")).toBe(-1);
  }
});

test("an internal build refuses a shallow checkout, whose commit count is wrong", () => {
  const f = fixture();
  git(f.root, "init", "--quiet");
  git(f.root, "add", "-A");
  git(f.root, "commit", "--quiet", "-m", "fixture");
  git(f.root, "commit", "--allow-empty", "--quiet", "-m", "next");
  const shallow = mkdtempSync(join(tmpdir(), "openbot-desktop-version-"));
  directories.push(shallow);
  rmSync(shallow, { recursive: true });
  const clone = Bun.spawnSync([
    "git",
    "clone",
    "--quiet",
    "--depth",
    "1",
    `file://${f.root}`,
    shallow,
  ]);
  expect(clone.exitCode).toBe(0);
  const result = Bun.spawnSync(
    [
      process.execPath,
      join(shallow, "desktop/scripts/desktop-version.ts"),
      "internal",
    ],
    { cwd: tmpdir() },
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("shallow");
  // A release build needs no count, so a shallow checkout still builds one.
  const release = Bun.spawnSync(
    [
      process.execPath,
      join(shallow, "desktop/scripts/desktop-version.ts"),
      "release",
    ],
    { cwd: tmpdir() },
  );
  expect(release.exitCode).toBe(0);
});

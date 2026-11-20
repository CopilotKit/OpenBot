/** Root package.json owns release versions; generated overlays identify each build. */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  formatVersion,
  parseVersion,
  type Version,
} from "../../scripts/release-version";

const root = resolve(import.meta.dir, "../..");
const native = "desktop/src-tauri/";
const packageName = "openbot-desktop";
const read = (path: string) => readFileSync(join(root, path), "utf8");
const write = (path: string, text: string) =>
  writeFileSync(join(root, path), text);
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function version(value: unknown, label: string, allowPlaceholder = false) {
  let parsed: Version | undefined;
  try {
    parsed = typeof value === "string" ? parseVersion(value) : undefined;
  } catch {
    parsed = undefined;
  }
  if (
    !parsed ||
    [parsed.major, parsed.minor, parsed.patch].some((part) => part > 65535) ||
    (!allowPlaceholder &&
      parsed.major === 0 &&
      parsed.minor === 0 &&
      parsed.patch === 0)
  ) {
    throw new Error(
      `${label}: expected a non-placeholder release version (major.minor.patch with an optional -rc.N or -beta.N)`,
    );
  }
  return formatVersion(parsed);
}

function state() {
  const manifest: unknown = JSON.parse(read("package.json"));
  const releaseVersion = version(
    object(manifest) ? manifest.version : undefined,
    "package.json",
  );
  const config: unknown = JSON.parse(read(`${native}tauri.conf.json`));
  if (!object(config) || config.version !== "../../package.json") {
    throw new Error('tauri.conf.json version must be "../../package.json"');
  }
  const cargoText = read(`${native}Cargo.toml`);
  const lockText = read(`${native}Cargo.lock`);
  const cargoDocument = Bun.TOML.parse(cargoText);
  const lockDocument = Bun.TOML.parse(lockText);
  const cargo = "package" in cargoDocument ? cargoDocument.package : undefined;
  const packages = "package" in lockDocument ? lockDocument.package : undefined;
  const entries = Array.isArray(packages)
    ? packages.filter((entry) => object(entry) && entry.name === packageName)
    : [];
  if (!object(cargo) || cargo.name !== packageName || entries.length !== 1) {
    throw new Error(
      `Cargo.toml and Cargo.lock must each contain one ${packageName} package`,
    );
  }
  const locked = entries[0];
  if (!object(locked))
    throw new Error("Cargo.lock desktop package is malformed");
  return {
    releaseVersion,
    cargoText,
    lockText,
    cargoVersion: version(cargo.version, "Cargo.toml", true),
    lockVersion: version(locked.version, "Cargo.lock", true),
  };
}

function replaceVersion(text: string, releaseVersion: string, lock: boolean) {
  let changed = 0;
  const result = text
    .split(/(?=^[ \t]*\[)/m)
    .map((section) => {
      const matches = lock
        ? /^[ \t]*\[\[package\]\]/.test(section) &&
          /^[ \t]*name[ \t]*=[ \t]*["']openbot-desktop["']/m.test(section)
        : /^[ \t]*\[package\]/.test(section);
      if (!matches) return section;
      return section.replace(
        /^([ \t]*version[ \t]*=[ \t]*)(?:"[^"\r\n]*"|'[^'\r\n]*')/m,
        (_, prefix: string) => {
          changed += 1;
          return `${prefix}"${releaseVersion}"`;
        },
      );
    })
    .join("");
  if (changed !== 1)
    throw new Error(
      "Expected exactly one desktop package version to synchronize",
    );
  Bun.TOML.parse(result);
  return result;
}

/**
 * An internal build's version, ordered after the release package.json names and before the next:
 * `X.Y.(Z+1)-internal.<commits>.g<commit>` after the release `X.Y.Z`, and
 * `X.Y.Z-rc.N.internal.<commits>.g<commit>` after the candidate `X.Y.Z-rc.N` (or `-beta.N`).
 *
 * Installers and the app order versions by semver (https://semver.org/#spec-item-11), where a
 * prerelease orders before its own release. package.json names the last release, so every build
 * from the tree comes after it, yet `0.3.3-internal.860.g…`, built after 0.3.3 was released, read
 * as older than 0.3.3 and the Windows installer offered to uninstall the "newer" 0.3.3 first. A
 * prerelease of the next patch orders after X.Y.Z and before X.Y.(Z+1) and every later release.
 * More identifiers after a candidate's order after rc.N, and `N` still orders it before rc.(N+1).
 *
 * semver compares a prerelease identifier that is a number as a number and any other as text.
 * Named after the commit alone, two internal builds ordered by their hashes (`g4400ba…` before
 * `gd298de…`), so the number of commits before the hash orders a later commit after an earlier one.
 */
function internalVersion(
  releaseVersion: string,
  commits: number,
  sourceSha: string,
) {
  const build = `internal.${commits}.g${sourceSha.slice(0, 12)}`;
  const release = parseVersion(releaseVersion);
  if (release.pre) return `${releaseVersion}.${build}`;
  // Windows keeps each part of the numeric version in 16 bits (see `version`).
  if (release.patch >= 65535) {
    throw new Error(
      `${releaseVersion}: the next patch does not fit a Windows version field`,
    );
  }
  return `${formatVersion({ ...release, patch: release.patch + 1 })}-${build}`;
}

/** The commits in HEAD's history. A shallow checkout has only some of them, so it is refused. */
function commitCount() {
  const shallow = Bun.spawnSync(
    ["git", "rev-parse", "--is-shallow-repository"],
    { cwd: root },
  );
  if (shallow.stdout.toString().trim() !== "false") {
    throw new Error(
      "An internal build is numbered by its commit count, and this checkout is shallow or not a repository. Check out the full history (actions/checkout with fetch-depth: 0).",
    );
  }
  const count = Bun.spawnSync(["git", "rev-list", "--count", "HEAD"], {
    cwd: root,
  });
  const text = count.stdout.toString().trim();
  if (count.exitCode !== 0 || !/^[1-9][0-9]*$/.test(text)) {
    throw new Error(
      `Could not count the source commits: ${count.stderr.toString().trim()}`,
    );
  }
  return Number(text);
}

function main(command: string | undefined) {
  if (!["sync", "check", "internal", "release"].includes(command ?? "")) {
    throw new Error(
      "Usage: bun desktop/scripts/desktop-version.ts sync|check|internal|release",
    );
  }
  const current = state();
  const { releaseVersion } = current;
  if (command === "sync") {
    // Validate both replacements before writing either file; dependencies stay byte-for-byte intact.
    const cargo = replaceVersion(current.cargoText, releaseVersion, false);
    const lock = replaceVersion(current.lockText, releaseVersion, true);
    write(`${native}Cargo.toml`, cargo);
    write(`${native}Cargo.lock`, lock);
  } else if (
    current.cargoVersion !== releaseVersion ||
    current.lockVersion !== releaseVersion
  ) {
    throw new Error(
      `Desktop version drift: root=${releaseVersion}, Cargo.toml=${current.cargoVersion}, Cargo.lock=${current.lockVersion}; run desktop-version.ts sync`,
    );
  }
  if (command === "sync" || command === "check") {
    console.log(`Desktop release version: ${releaseVersion}`);
    return;
  }
  const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });
  const sourceSha = git.stdout.toString().trim();
  if (git.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error(
      `Could not resolve the source commit: ${git.stderr.toString().trim()}`,
    );
  }
  const buildVersion =
    command === "internal"
      ? internalVersion(releaseVersion, commitCount(), sourceSha)
      : releaseVersion;
  const metadata = {
    version: buildVersion,
    releaseVersion,
    sourceSha,
    channel: command,
  };
  // Tauri copies semver into both Apple keys unchanged. Keep those numeric while
  // retaining the complete internal identity in custom plist keys and app metadata.
  // They are the build version's major.minor.patch, the same numbers Tauri puts in
  // the Windows fixed version fields, so neither platform's numbers go backwards.
  const numeric = buildVersion.split("-")[0];
  const fields = {
    CFBundleShortVersionString: numeric,
    CFBundleVersion: numeric,
    OpenBotBuildVersion: buildVersion,
    OpenBotSourceRevision: sourceSha,
  };
  write(
    `${native}build-version.plist`,
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n${Object.entries(
      fields,
    )
      .map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
      .join("\n")}\n</dict></plist>\n`,
  );
  write(
    `${native}tauri.build-version.conf.json`,
    json({
      version: buildVersion,
      bundle: { macOS: { infoPlist: "build-version.plist" } },
    }),
  );
  write("desktop/build-version.json", json(metadata));
  console.log(json(metadata).trim());
}

if (import.meta.main) {
  try {
    main(process.argv[2]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

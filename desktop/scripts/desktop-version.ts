/** Root package.json owns release versions; generated overlays identify each build. */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

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
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) ||
    value.split(".").some((part) => Number(part) > 65535) ||
    (!allowPlaceholder && value === "0.0.0")
  ) {
    throw new Error(
      `${label}: expected a non-placeholder numeric release version (major.minor.patch)`,
    );
  }
  return value;
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
      ? `${releaseVersion}-internal.g${sourceSha.slice(0, 12)}`
      : releaseVersion;
  const metadata = {
    version: buildVersion,
    releaseVersion,
    sourceSha,
    channel: command,
  };
  // Tauri copies semver into both Apple keys unchanged. Keep those numeric while
  // retaining the complete internal identity in custom plist keys and app metadata.
  const fields = {
    CFBundleShortVersionString: releaseVersion,
    CFBundleVersion: releaseVersion,
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

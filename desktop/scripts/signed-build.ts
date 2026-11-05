/**
 * Builds a signed installer the same way desktop-build.yml builds the unsigned one it replaces.
 *
 * The signing workflows build their own app, so a signed installer is a separate build from the
 * ad-hoc one a release first carries. It must still be the same product:
 *
 * - A candidate or beta is pinned to the images its release was published with. The release's own
 *   `container-images.json` is compiled in through `OPENBOT_PINNED_DEPLOYMENT`, exactly as
 *   desktop-build.yml pins the unsigned candidate, so whoever installs the signed candidate runs
 *   the images the final will ship. build.rs refuses a manifest from another commit.
 * - A pinned build carries no updater. It never asks `releases/latest` for anything, and it makes
 *   no updater archive, so the updater key never signs one. The signing overlay is copied without
 *   its updater for that build.
 * - The Intelligence CLI is bundled whenever the tree can bundle one, as desktop-build.yml does.
 *
 * Usage, from anywhere, after desktop-version.ts has written desktop/build-version.json:
 *
 *   bun desktop/scripts/signed-build.ts <darwin|win32> <arm64|x64> <overlay> [tauri build args...]
 *
 * `overlay` is the signing overlay, relative to desktop/. Writes `pinned` (the release tag, or
 * empty) and `updater` (`true` or `false`) to $GITHUB_OUTPUT when it is set.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPrerelease } from "../../scripts/release-version";

export type Platform = "darwin" | "win32";
export type Arch = "arm64" | "x64";

export type Runner = (
  cmd: string[],
  cwd: string,
) => { code: number; stdout: string; stderr: string };

export type Plan = {
  /** The release this build is pinned to, or null for an ordinary build. */
  pinned: string | null;
  /** Whether the build carries the updater and makes updater archives. */
  updater: boolean;
  /** The `--config` overlays, relative to desktop/, in the order Tauri merges them. */
  configs: string[];
  /** Set for the build. */
  env: Record<string, string>;
  /** Removed from the build's environment. */
  unset: string[];
};

export const CLI_OVERLAY = "src-tauri/tauri.bundled-cli.conf.json";
export const PINNED_OVERLAY = "src-tauri/tauri.signed-pinned.conf.json";
const BUILD_VERSION_OVERLAY = "src-tauri/tauri.build-version.conf.json";
const UPDATER_KEYS = [
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
];

type Json = Record<string, unknown>;

function object(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(path: string): Json {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!object(value)) throw new Error(`${path} is not a JSON object.`);
  return value;
}

function runChecked(run: Runner, cmd: string[], cwd: string): string {
  const result = run(cmd, cwd);
  if (result.code !== 0) {
    throw new Error(`${cmd.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** The overlay without the updater: no `plugins.updater` and no updater archives. */
export function withoutUpdater(overlay: Json): Json {
  const copy = structuredClone(overlay);
  if (object(copy.plugins)) {
    delete copy.plugins.updater;
    if (Object.keys(copy.plugins).length === 0) delete copy.plugins;
  }
  if (object(copy.bundle)) delete copy.bundle.createUpdaterArtifacts;
  return copy;
}

/**
 * Decides how a signed installer is built, and prepares what that needs: the pinned manifest,
 * the overlay without its updater, and the bundled CLI.
 */
export function planSignedBuild(options: {
  desktop: string;
  platform: Platform;
  arch: Arch;
  overlay: string;
  repository: string;
  workDir: string;
  bun: string;
  run: Runner;
}): Plan {
  const { desktop, platform, arch, overlay, repository, workDir, run } =
    options;
  const recordPath = join(desktop, "build-version.json");
  const record = readJson(recordPath);
  const version = String(record.version ?? "");
  const plan: Plan = {
    pinned: null,
    updater: false,
    configs: [],
    env: {},
    unset: [],
  };

  // A release build of a candidate or beta. An internal build is named after its commit and has
  // no release to pin to.
  if (record.channel === "release" && isPrerelease(version)) {
    const tag = `v${version}`;
    if (!repository) {
      throw new Error(
        `${tag} is a candidate, and pinning it needs GITHUB_REPOSITORY to find its release.`,
      );
    }
    mkdirSync(workDir, { recursive: true });
    runChecked(
      run,
      [
        "gh",
        "release",
        "download",
        tag,
        "--repo",
        repository,
        "--pattern",
        "container-images.json",
        "--dir",
        workDir,
        "--clobber",
      ],
      desktop,
    );
    const manifestPath = join(workDir, "container-images.json");
    const manifest = readJson(manifestPath);
    if (manifest.version !== tag) {
      throw new Error(
        `The container-images.json on ${tag} names ${String(manifest.version)}, not ${tag}.`,
      );
    }
    if (manifest.commit !== record.sourceSha) {
      throw new Error(
        `The container-images.json on ${tag} was built from ${String(manifest.commit)}, but this build is ${String(record.sourceSha)}. Sign the release from its tag.`,
      );
    }
    plan.pinned = tag;
    plan.env.OPENBOT_PINNED_DEPLOYMENT = manifestPath;
    plan.unset.push(...UPDATER_KEYS);
    writeFileSync(
      recordPath,
      `${JSON.stringify({ ...record, pinned: tag }, null, 2)}\n`,
    );
  }

  const signing = readJson(join(desktop, overlay));
  if (plan.pinned) {
    writeFileSync(
      join(desktop, PINNED_OVERLAY),
      `${JSON.stringify(withoutUpdater(signing), null, 2)}\n`,
    );
    plan.configs.push(PINNED_OVERLAY);
  } else {
    plan.configs.push(overlay);
    plan.updater = object(signing.plugins) && "updater" in signing.plugins;
  }
  plan.configs.push(BUILD_VERSION_OVERLAY);

  // A tree from before the bundled CLI existed has no overlay to add it, and builds without one,
  // as desktop-build.yml does. cli-bundle.ts records the CLI in build-version.json, after the pin
  // above, so the record keeps both.
  if (existsSync(join(desktop, CLI_OVERLAY))) {
    runChecked(
      run,
      [options.bun, join(desktop, "scripts", "cli-bundle.ts"), platform, arch],
      desktop,
    );
    plan.configs.push(CLI_OVERLAY);
    plan.env.OPENBOT_BUNDLED_CLI = "1";
  }
  return plan;
}

/** The `bun run tauri build` command line for a plan. */
export function buildCommand(
  bun: string,
  plan: Plan,
  extra: string[],
): string[] {
  return [
    bun,
    "run",
    "tauri",
    "build",
    ...plan.configs.flatMap((config) => ["--config", config]),
    ...extra,
  ];
}

/** The environment the build runs with: this one, with the plan's changes. */
export function buildEnv(
  base: Record<string, string | undefined>,
  plan: Plan,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !plan.unset.includes(key)) env[key] = value;
  }
  return { ...env, ...plan.env };
}

const realRun: Runner = (cmd, cwd) => {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    code: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

function main(argv: string[]) {
  const [platform, arch, overlay, ...extra] = argv;
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error(`Platform must be darwin or win32, got "${platform}".`);
  }
  if (arch !== "arm64" && arch !== "x64") {
    throw new Error(`Architecture must be arm64 or x64, got "${arch}".`);
  }
  if (!overlay)
    throw new Error("Name the signing overlay, relative to desktop/.");
  const desktop = join(import.meta.dir, "..");
  const bun = process.execPath;
  const plan = planSignedBuild({
    desktop,
    platform,
    arch,
    overlay,
    repository: process.env.GITHUB_REPOSITORY ?? "",
    workDir: join(process.env.RUNNER_TEMP ?? tmpdir(), "signed-build"),
    bun,
    run: realRun,
  });
  console.log(
    plan.pinned
      ? `Pinned to ${plan.pinned}, with no updater.`
      : `Not pinned. Updater: ${plan.updater}.`,
  );
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `pinned=${plan.pinned ?? ""}\nupdater=${plan.updater}\n`,
    );
  }
  const command = buildCommand(bun, plan, extra);
  console.log(command.slice(1).join(" "));
  const build = Bun.spawnSync(command, {
    cwd: desktop,
    env: buildEnv(process.env, plan),
    stdout: "inherit",
    stderr: "inherit",
  });
  if (build.exitCode !== 0) {
    throw new Error(`tauri build exited with ${build.exitCode}.`);
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

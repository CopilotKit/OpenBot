#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseReleaseManifest,
  type ReleaseManifest,
} from "../shared/release-manifest";
export interface ReleaseBuildOptions {
  repositoryRoot: string;
  outputDirectory: string;
  repository: string;
  distributionId: string;
  channel: string;
  version: string;
  commit: string;
  upstreamRepository: string;
  upstreamCommit: string;
  compatibility: ReleaseManifest["compatibility"];
  upgrade: ReleaseManifest["upgrade"];
  images: ReleaseManifest["artifacts"]["images"];
}
function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function validateSource(
  options: Pick<
    ReleaseBuildOptions,
    "repositoryRoot" | "commit" | "upstreamCommit"
  >,
): void {
  for (const commit of [options.commit, options.upstreamCommit]) {
    if (
      !/^[0-9a-f]{40}$/.test(commit) ||
      git(
        options.repositoryRoot,
        "rev-parse",
        "--verify",
        `${commit}^{commit}`,
      ) !== commit
    )
      throw new Error(`Unavailable exact source commit ${commit}`);
  }
  git(
    options.repositoryRoot,
    "merge-base",
    "--is-ancestor",
    options.upstreamCommit,
    options.commit,
  );
}
function manifest(
  options: ReleaseBuildOptions,
  sha256: string,
): ReleaseManifest {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository) ||
    !/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(options.version)
  )
    throw new Error("Expected owner/repo and release vMAJOR.MINOR.PATCH");
  const registry = `ghcr.io/${options.repository.toLowerCase()}`;
  for (const image of Object.values(options.images)) {
    if (
      !image.reference.startsWith(`${registry}@sha256:`) &&
      !image.reference.startsWith(`${registry}-`)
    )
      throw new Error(
        `Image is not owned by this distribution: ${image.reference}`,
      );
  }
  const modified =
    git(options.repositoryRoot, "rev-parse", `${options.commit}^{tree}`) !==
    git(
      options.repositoryRoot,
      "rev-parse",
      `${options.upstreamCommit}^{tree}`,
    );
  return parseReleaseManifest({
    schemaVersion: 1,
    distribution: {
      id: options.distributionId,
      repository: options.repository,
      channel: options.channel,
    },
    version: options.version,
    source: {
      commit: options.commit,
      upstreamRepository: options.upstreamRepository,
      upstreamCommit: options.upstreamCommit,
      modified,
    },
    artifacts: {
      source: {
        url: `https://github.com/${options.repository}/releases/download/${options.version}/openbot-source.tar.gz`,
        sha256,
      },
      images: options.images,
    },
    compatibility: options.compatibility,
    upgrade: options.upgrade,
  });
}

/** Emits an exact Git archive; untracked and uncommitted working files never enter release assets. */
export function createReleaseArtifacts(
  options: ReleaseBuildOptions,
): ReleaseManifest {
  validateSource(options);
  manifest(options, "0".repeat(64)); // Complete preflight before output mutation.
  mkdirSync(options.outputDirectory, { recursive: true });
  const archive = resolve(options.outputDirectory, "openbot-source.tar.gz");
  git(
    options.repositoryRoot,
    "archive",
    "--format=tar.gz",
    "--prefix=openbot/",
    `--output=${archive}`,
    options.commit,
  );
  const release = manifest(
    options,
    createHash("sha256").update(readFileSync(archive)).digest("hex"),
  );
  writeFileSync(
    resolve(options.outputDirectory, "release-manifest.json"),
    `${JSON.stringify(release, null, 2)}\n`,
  );
  return release;
}

/** Publishing requires reviewed compatibility policy; no guessed migration or rollback promises. */
export function readReleaseConfiguration(
  env: Record<string, string | undefined>,
  repositoryRoot: string,
): Omit<ReleaseBuildOptions, "images"> {
  if (
    !env.GITHUB_REPOSITORY ||
    !env.GITHUB_SHA ||
    !env.VERSION ||
    !env.OPENBOT_RELEASE_POLICY
  )
    throw new Error(
      "GITHUB_REPOSITORY, GITHUB_SHA, VERSION and OPENBOT_RELEASE_POLICY are required",
    );
  const policy: unknown = JSON.parse(env.OPENBOT_RELEASE_POLICY);
  if (
    typeof policy !== "object" ||
    policy === null ||
    !("compatibility" in policy) ||
    !("upgrade" in policy) ||
    Object.keys(policy).some(
      (key) => !["compatibility", "upgrade"].includes(key),
    )
  )
    throw new Error(
      "OPENBOT_RELEASE_POLICY must contain compatibility and upgrade",
    );
  let baseline: unknown;
  const baselineFile = resolve(repositoryRoot, ".openbot-upstream.json");
  if (existsSync(baselineFile))
    baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
  const upstreamRepository =
    env.OPENBOT_UPSTREAM_REPOSITORY || "CopilotKit/openbot";
  const recordedCommit =
    typeof baseline === "object" &&
    baseline !== null &&
    "upstreamCommit" in baseline &&
    typeof baseline.upstreamCommit === "string" &&
    "upstreamRepository" in baseline &&
    (baseline.upstreamRepository === upstreamRepository ||
      baseline.upstreamRepository ===
        `https://github.com/${upstreamRepository}.git`)
      ? baseline.upstreamCommit
      : undefined;
  const upstreamCommit =
    env.OPENBOT_UPSTREAM_COMMIT ||
    recordedCommit ||
    (env.GITHUB_REPOSITORY.toLowerCase() === upstreamRepository.toLowerCase()
      ? env.GITHUB_SHA
      : undefined);
  if (!upstreamCommit)
    throw new Error(
      "Fork publication requires OPENBOT_UPSTREAM_COMMIT or a matching .openbot-upstream.json baseline",
    );
  const options = {
    repositoryRoot: resolve(repositoryRoot),
    outputDirectory: resolve(
      repositoryRoot,
      env.OPENBOT_RELEASE_OUTPUT || "release-assets",
    ),
    repository: env.GITHUB_REPOSITORY,
    distributionId: env.OPENBOT_DISTRIBUTION_ID || env.GITHUB_REPOSITORY,
    channel: env.OPENBOT_RELEASE_CHANNEL || "stable",
    version: env.VERSION,
    commit: env.GITHUB_SHA,
    upstreamRepository,
    upstreamCommit,
  };
  validateSource(options);
  const validated = parseReleaseManifest({
    schemaVersion: 1,
    distribution: {
      id: options.distributionId,
      repository: options.repository,
      channel: options.channel,
    },
    version: options.version,
    source: {
      commit: options.commit,
      upstreamRepository,
      upstreamCommit,
      modified: options.commit !== upstreamCommit,
    },
    artifacts: {
      source: {
        url: `https://github.com/${options.repository}/releases/download/${options.version}/openbot-source.tar.gz`,
        sha256: "0".repeat(64),
      },
      images: {
        openbot: {
          reference: `ghcr.io/${options.repository.toLowerCase()}@sha256:${"0".repeat(64)}`,
        },
      },
    },
    compatibility: policy.compatibility,
    upgrade: policy.upgrade,
  });
  return {
    ...options,
    compatibility: validated.compatibility,
    upgrade: validated.upgrade,
  };
}

if (import.meta.main) {
  const options = readReleaseConfiguration(process.env, process.cwd());
  if (!process.argv.includes("--validate-policy")) {
    const input: unknown = JSON.parse(
      readFileSync(
        resolve(process.env.OPENBOT_IMAGE_MANIFEST || "container-images.json"),
        "utf8",
      ),
    );
    if (
      typeof input !== "object" ||
      input === null ||
      !("images" in input) ||
      typeof input.images !== "object" ||
      input.images === null ||
      Array.isArray(input.images)
    )
      throw new Error("Image manifest has no images object");
    const images = Object.fromEntries(
      Object.entries(input.images).map(([name, value]: [string, unknown]) => {
        if (
          typeof value !== "object" ||
          value === null ||
          !("reference" in value)
        )
          throw new Error(`Image ${name} has no reference`);
        return [name, { reference: value.reference }];
      }),
    );
    const checked = parseReleaseManifest({
      schemaVersion: 1,
      distribution: {
        id: options.distributionId,
        repository: options.repository,
        channel: options.channel,
      },
      version: options.version,
      source: {
        commit: options.commit,
        upstreamRepository: options.upstreamRepository,
        upstreamCommit: options.upstreamCommit,
        modified: false,
      },
      artifacts: {
        source: {
          url: "https://github.com/source.tar.gz",
          sha256: "0".repeat(64),
        },
        images,
      },
      compatibility: options.compatibility,
      upgrade: options.upgrade,
    });
    createReleaseArtifacts({ ...options, images: checked.artifacts.images });
  }
}

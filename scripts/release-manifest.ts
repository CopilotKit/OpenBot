#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  parseReleaseManifest,
  type ReleaseManifest,
} from "../shared/release-manifest";

/** The reviewed upgrade policy, committed at the repository root and read from the release commit. */
export const RELEASE_POLICY_FILE = "release-policy.json";
/** Re-signed on every run, so it is compared by what it attests rather than by its bytes. */
export const PROVENANCE_BUNDLE = "release-provenance.sigstore.json";
export type ReleasePolicy = Pick<ReleaseManifest, "compatibility" | "upgrade">;
export interface ReleaseBuildOptions extends ReleasePolicy {
  repositoryRoot: string;
  outputDirectory: string;
  repository: string;
  distributionId: string;
  channel: string;
  version: string;
  commit: string;
  upstreamRepository: string;
  upstreamCommit: string;
  images: ReleaseManifest["artifacts"]["images"];
  chart?: { path: string; version: string };
  /**
   * Assets an earlier attempt at this release already published. Each one this run would also
   * produce must have the same content, and its published bytes are kept, so a rerun can complete
   * a half-published release without changing anything that was already downloadable.
   */
  publishedDirectory?: string;
}
export type ReleaseConfiguration = Omit<
  ReleaseBuildOptions,
  "images" | "compatibility" | "upgrade" | "publishedDirectory"
>;
const releaseVersion = /^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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
  options: Omit<ReleaseBuildOptions, "publishedDirectory">,
  sourceSha256: string,
): ReleaseManifest {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository) ||
    !releaseVersion.test(options.version)
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
  let chart: ReleaseManifest["artifacts"]["chart"];
  if (options.chart) {
    const { path, version } = options.chart;
    if (
      !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) ||
      basename(path) !== `openbot-${version}.tgz`
    )
      throw new Error(
        "Chart artifact filename must match its exact openbot chart version",
      );
    chart = {
      version,
      url: `https://github.com/${options.repository}/releases/download/${options.version}/${basename(path)}`,
      sha256: sha256(readFileSync(path)),
    };
  }
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
        sha256: sourceSha256,
      },
      images: options.images,
      ...(chart ? { chart } : {}),
    },
    compatibility: options.compatibility,
    upgrade: options.upgrade,
  });
}

function paxRecords(body: Buffer, archive: string): Record<string, string> {
  const records: Record<string, string> = {};
  for (let offset = 0; offset < body.length; ) {
    const space = body.indexOf(0x20, offset);
    const length = Number.parseInt(
      body.subarray(offset, space).toString("utf8"),
      10,
    );
    if (space === -1 || !Number.isSafeInteger(length) || length <= 0)
      throw new Error(`${archive}: malformed pax header`);
    const record = body
      .subarray(space + 1, offset + length - 1)
      .toString("utf8");
    const equals = record.indexOf("=");
    records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

/**
 * What a .tar.gz contains, independent of how it was wrapped: each entry's type, permission bits,
 * path and content digest (or link target), sorted. Timestamps, owners and the gzip stream are
 * left out, because `helm package` stamps the time it ran and nothing else about two packagings of
 * one commit differs.
 */
export function archiveContent(path: string): string[] {
  const archive = basename(path);
  const tar = gunzipSync(readFileSync(path));
  const entries: string[] = [];
  let pax: Record<string, string> = {};
  let longName: string | undefined;
  let longLink: string | undefined;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start: number, length: number) => {
      const field = header.subarray(start, start + length);
      const end = field.indexOf(0);
      return field.subarray(0, end === -1 ? length : end).toString("utf8");
    };
    if ((header[124] ?? 0) & 0x80)
      throw new Error(`${archive}: unsupported tar size encoding`);
    const size = pax.size
      ? Number(pax.size)
      : Number.parseInt(text(124, 12).trim() || "0", 8);
    const type = text(156, 1) || "0";
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pax = paxRecords(body, archive);
      continue;
    }
    if (type === "g") {
      const records = Object.entries(paxRecords(body, archive))
        .filter(([key]) => !["mtime", "atime", "ctime"].includes(key))
        .sort();
      entries.push(JSON.stringify(["global", records]));
      continue;
    }
    if (type === "L" || type === "K") {
      const value = body.toString("utf8").replace(/\0+$/, "");
      if (type === "L") longName = value;
      else longLink = value;
      continue;
    }
    const prefix = text(257, 6) === "ustar" ? text(345, 155) : "";
    const name =
      pax.path ??
      longName ??
      (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100));
    const regular = type === "0" || type === "7";
    entries.push(
      JSON.stringify([
        regular ? "0" : type,
        (Number.parseInt(text(100, 8).trim() || "0", 8) & 0o7777).toString(8),
        name,
        regular ? sha256(body) : (pax.linkpath ?? longLink ?? text(157, 100)),
      ]),
    );
    pax = {};
    longName = undefined;
    longLink = undefined;
  }
  return entries.sort();
}

/** The artifacts a Sigstore bundle attests, by name and digest. */
export function provenanceSubjects(path: string): string[] {
  const bundle: unknown = JSON.parse(readFileSync(path, "utf8"));
  const payload =
    typeof bundle === "object" &&
    bundle !== null &&
    "dsseEnvelope" in bundle &&
    typeof bundle.dsseEnvelope === "object" &&
    bundle.dsseEnvelope !== null &&
    "payload" in bundle.dsseEnvelope
      ? bundle.dsseEnvelope.payload
      : undefined;
  if (typeof payload !== "string")
    throw new Error(`${basename(path)} is not a DSSE Sigstore bundle`);
  const statement: unknown = JSON.parse(
    Buffer.from(payload, "base64").toString("utf8"),
  );
  if (
    typeof statement !== "object" ||
    statement === null ||
    !("subject" in statement) ||
    !Array.isArray(statement.subject)
  )
    throw new Error(`${basename(path)} attests no subjects`);
  return statement.subject
    .map((subject: { name?: unknown; digest?: Record<string, unknown> }) =>
      JSON.stringify([
        subject.name,
        Object.entries(subject.digest ?? {}).sort(),
      ]),
    )
    .sort();
}

/**
 * Keeps a published asset in place of the one this run just produced, when their content agrees.
 * Returns false when nothing of that name was published; throws when the content differs, because
 * a downloadable release asset is never replaced.
 */
function adoptPublished(
  local: string,
  publishedDirectory: string | undefined,
  same: (local: string, published: string) => boolean,
): boolean {
  if (!publishedDirectory) return false;
  const published = resolve(publishedDirectory, basename(local));
  if (!existsSync(published)) return false;
  if (!same(local, published))
    throw new Error(
      `The published ${basename(local)} has different content from what this commit produces now; publish a new release version instead.`,
    );
  copyFileSync(published, local);
  return true;
}
const sameArchive = (local: string, published: string) =>
  Bun.deepEquals(archiveContent(local), archiveContent(published));
const sameJson = (local: string, published: string) =>
  Bun.deepEquals(
    JSON.parse(readFileSync(local, "utf8")),
    JSON.parse(readFileSync(published, "utf8")),
  );

/** `container-images.json` from an earlier attempt, when it names the same images. */
export function adoptPublishedImageManifest(
  local: string,
  publishedDirectory: string | undefined,
): boolean {
  return adoptPublished(local, publishedDirectory, sameJson);
}

/**
 * The provenance bundle from an earlier attempt, when it attests exactly the assets this run is
 * publishing. Otherwise the new bundle stands: the earlier one attests bytes that were never
 * published, which is the one case where replacing a published asset is correct.
 */
export function adoptPublishedProvenance(
  local: string,
  publishedDirectory: string | undefined,
): boolean {
  if (!publishedDirectory) return false;
  const published = resolve(publishedDirectory, basename(local));
  if (!existsSync(published)) return false;
  if (!Bun.deepEquals(provenanceSubjects(local), provenanceSubjects(published)))
    return false;
  copyFileSync(published, local);
  return true;
}

/** Emits an exact Git archive; untracked and uncommitted working files never enter release assets. */
export function createReleaseArtifacts(
  options: ReleaseBuildOptions,
): ReleaseManifest {
  validateSource(options);
  manifest(options, "0".repeat(64)); // Complete preflight before output mutation.
  mkdirSync(options.outputDirectory, { recursive: true });
  const published = options.publishedDirectory;
  const archive = resolve(options.outputDirectory, "openbot-source.tar.gz");
  git(
    options.repositoryRoot,
    "archive",
    "--format=tar.gz",
    "--prefix=openbot/",
    `--output=${archive}`,
    options.commit,
  );
  adoptPublished(archive, published, sameArchive);
  let chart = options.chart;
  if (chart) {
    const destination = resolve(options.outputDirectory, basename(chart.path));
    if (resolve(chart.path) !== destination)
      copyFileSync(chart.path, destination);
    adoptPublished(destination, published, sameArchive);
    chart = { ...chart, path: destination };
  }
  const release = manifest(
    { ...options, ...(chart ? { chart } : {}) },
    sha256(readFileSync(archive)),
  );
  const manifestPath = resolve(
    options.outputDirectory,
    "release-manifest.json",
  );
  writeFileSync(manifestPath, `${JSON.stringify(release, null, 2)}\n`);
  adoptPublished(manifestPath, published, (local, other) =>
    Bun.deepEquals(
      parseReleaseManifest(JSON.parse(readFileSync(local, "utf8"))),
      parseReleaseManifest(JSON.parse(readFileSync(other, "utf8"))),
    ),
  );
  return release;
}

function placeholderManifest(
  configuration: ReleaseConfiguration,
  policy: { compatibility: unknown; upgrade: unknown },
): unknown {
  return {
    schemaVersion: 1,
    distribution: {
      id: configuration.distributionId,
      repository: configuration.repository,
      channel: configuration.channel,
    },
    version: configuration.version,
    source: {
      commit: configuration.commit,
      upstreamRepository: configuration.upstreamRepository,
      upstreamCommit: configuration.upstreamCommit,
      modified: configuration.commit !== configuration.upstreamCommit,
    },
    artifacts: {
      source: {
        url: `https://github.com/${configuration.repository}/releases/download/${configuration.version}/openbot-source.tar.gz`,
        sha256: "0".repeat(64),
      },
      images: {
        openbot: {
          reference: `ghcr.io/${configuration.repository.toLowerCase()}@sha256:${"0".repeat(64)}`,
        },
      },
    },
    compatibility: policy.compatibility,
    upgrade: policy.upgrade,
  };
}

/**
 * The policy must name the release it describes. A policy left over from the previous release
 * names that release, so it is refused here instead of shipping that release's promises.
 */
export function parseReleasePolicy(
  input: unknown,
  version: string,
): ReleasePolicy {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error(`${RELEASE_POLICY_FILE} must be a JSON object`);
  const record = input as Record<string, unknown>;
  const unsupported = Object.keys(record).filter(
    (key) => !["$schema", "version", "compatibility", "upgrade"].includes(key),
  );
  if (unsupported.length)
    throw new Error(
      `${RELEASE_POLICY_FILE} has unsupported fields: ${unsupported.join(", ")}`,
    );
  if (record.version !== version)
    throw new Error(
      `${RELEASE_POLICY_FILE} describes ${JSON.stringify(record.version ?? null)}, but this release is ${version}. Write this release's policy into it: the versions it upgrades from, its database transition, downtime and recovery.`,
    );
  if (!("compatibility" in record) || !("upgrade" in record))
    throw new Error(
      `${RELEASE_POLICY_FILE} must contain compatibility and upgrade`,
    );
  const checked = parseReleaseManifest(
    placeholderManifest(
      {
        repositoryRoot: "",
        outputDirectory: "",
        repository: "policy/check",
        distributionId: "policy",
        channel: "stable",
        version,
        commit: "0".repeat(40),
        upstreamRepository: "policy/check",
        upstreamCommit: "0".repeat(40),
      },
      { compatibility: record.compatibility, upgrade: record.upgrade },
    ),
  );
  for (const from of checked.upgrade.fromVersions) {
    if (!releaseVersion.test(from))
      throw new Error(`upgrade.fromVersions: ${from} is not a release version`);
    if (Bun.semver.order(from, version) >= 0)
      throw new Error(
        `upgrade.fromVersions: ${from} is not earlier than ${version}`,
      );
  }
  return { compatibility: checked.compatibility, upgrade: checked.upgrade };
}

/** Reads the policy from the release commit itself, never from the working tree or the environment. */
export function readReleasePolicy(
  repositoryRoot: string,
  commit: string,
  version: string,
): ReleasePolicy {
  let text: string;
  try {
    text = git(repositoryRoot, "show", `${commit}:${RELEASE_POLICY_FILE}`);
  } catch {
    throw new Error(
      `${commit} has no ${RELEASE_POLICY_FILE}. Commit the reviewed compatibility and upgrade policy for ${version} before releasing.`,
    );
  }
  return parseReleasePolicy(JSON.parse(text), version);
}

/** Drizzle's migration journal; its last entry's tag is the database a commit migrates to. */
export const MIGRATION_JOURNAL = "server/drizzle/meta/_journal.json";
function lastMigration(repositoryRoot: string, revision: string): string {
  let text: string;
  try {
    text = git(repositoryRoot, "show", `${revision}:${MIGRATION_JOURNAL}`);
  } catch {
    throw new Error(`${revision} has no ${MIGRATION_JOURNAL}.`);
  }
  const journal: unknown = JSON.parse(text);
  const entries =
    typeof journal === "object" && journal !== null && "entries" in journal
      ? journal.entries
      : undefined;
  const tag = Array.isArray(entries) ? entries.at(-1)?.tag : undefined;
  if (typeof tag !== "string" || !tag)
    throw new Error(`${MIGRATION_JOURNAL} at ${revision} has no migrations.`);
  return tag;
}

/**
 * The policy's database transition, checked against the migrations themselves rather than taken on
 * trust: `to` is the last migration in the release commit, and `from` is the last migration of each
 * starting release, read at that release's tag. A migration that lands after the policy was written
 * therefore stops the release instead of shipping a stale transition.
 */
export function checkDatabaseTransition(
  repositoryRoot: string,
  commit: string,
  policy: ReleasePolicy,
): void {
  const { database } = policy.compatibility;
  const to = lastMigration(repositoryRoot, commit);
  if (database.to !== to)
    throw new Error(
      `${RELEASE_POLICY_FILE} says this release migrates the database to ${JSON.stringify(database.to)}, but the last migration in ${MIGRATION_JOURNAL} at ${commit} is ${JSON.stringify(to)}. Set compatibility.database.to to ${JSON.stringify(to)}.`,
    );
  const from = [
    ...new Set(
      policy.upgrade.fromVersions.map((version) => {
        try {
          git(
            repositoryRoot,
            "rev-parse",
            "--verify",
            `refs/tags/${version}^{commit}`,
          );
        } catch {
          throw new Error(
            `${RELEASE_POLICY_FILE} upgrades from ${version}, but this repository has no ${version} tag to read its database from. Fetch tags, or remove ${version} from upgrade.fromVersions.`,
          );
        }
        return lastMigration(repositoryRoot, `refs/tags/${version}`);
      }),
    ),
  ];
  if (
    database.from.length !== from.length ||
    database.from.some((migration) => !from.includes(migration))
  )
    throw new Error(
      `${RELEASE_POLICY_FILE} says this release upgrades databases from ${JSON.stringify(database.from)}, but the starting releases ${JSON.stringify(policy.upgrade.fromVersions)} end at ${JSON.stringify(from)} in their ${MIGRATION_JOURNAL}. Set compatibility.database.from to ${JSON.stringify(from)}.`,
    );
}

/** The publishing identity and exact source. The upgrade policy is read separately, from the tree. */
export function readReleaseConfiguration(
  env: Record<string, string | undefined>,
  repositoryRoot: string,
): ReleaseConfiguration {
  if (!env.GITHUB_REPOSITORY || !env.GITHUB_SHA || !env.VERSION)
    throw new Error("GITHUB_REPOSITORY, GITHUB_SHA and VERSION are required");
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
  const configuration: ReleaseConfiguration = {
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
    ...(env.OPENBOT_CHART_PATH || env.OPENBOT_CHART_VERSION
      ? {
          chart: {
            path: resolve(repositoryRoot, env.OPENBOT_CHART_PATH || ""),
            version: env.OPENBOT_CHART_VERSION || "",
          },
        }
      : {}),
  };
  validateSource(configuration);
  parseReleaseManifest(
    placeholderManifest(configuration, {
      compatibility: {
        launcherApi: 1,
        configSchema: 1,
        extensionApi: 1,
        database: { from: [], to: "identity-check", rollbackCompatible: true },
        intelligenceCapabilities: [],
      },
      upgrade: {
        fromVersions: [],
        requiresDowntime: true,
        recovery: "restore-backup",
      },
    }),
  );
  return configuration;
}

function readImages(path: string): ReleaseManifest["artifacts"]["images"] {
  const input: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof input !== "object" ||
    input === null ||
    !("images" in input) ||
    typeof input.images !== "object" ||
    input.images === null ||
    Array.isArray(input.images)
  )
    throw new Error("Image manifest has no images object");
  return Object.fromEntries(
    Object.entries(input.images).map(([name, value]: [string, unknown]) => {
      if (
        typeof value !== "object" ||
        value === null ||
        !("reference" in value)
      )
        throw new Error(`Image ${name} has no reference`);
      return [name, { reference: value.reference }];
    }),
  ) as ReleaseManifest["artifacts"]["images"];
}

if (import.meta.main) {
  const published = process.env.OPENBOT_PUBLISHED_ASSETS
    ? resolve(process.env.OPENBOT_PUBLISHED_ASSETS)
    : undefined;
  const provenance = process.argv.indexOf("--adopt-provenance");
  if (provenance !== -1) {
    const bundle = process.argv[provenance + 1];
    if (!bundle)
      throw new Error("--adopt-provenance needs the new bundle path");
    console.log(
      adoptPublishedProvenance(resolve(bundle), published)
        ? `Kept the published ${PROVENANCE_BUNDLE}; it attests the same assets.`
        : `Using this run's ${PROVENANCE_BUNDLE}.`,
    );
  } else {
    const configuration = readReleaseConfiguration(process.env, process.cwd());
    const policy = readReleasePolicy(
      configuration.repositoryRoot,
      configuration.commit,
      configuration.version,
    );
    parseReleaseManifest(placeholderManifest(configuration, policy));
    if (process.argv.includes("--validate-policy")) {
      checkDatabaseTransition(
        configuration.repositoryRoot,
        configuration.commit,
        policy,
      );
      console.log(
        `${RELEASE_POLICY_FILE} at ${configuration.commit} describes ${configuration.version}.`,
      );
    } else {
      const imageManifest = resolve(
        process.env.OPENBOT_IMAGE_MANIFEST || "container-images.json",
      );
      adoptPublishedImageManifest(imageManifest, published);
      const images = parseReleaseManifest({
        ...(placeholderManifest(configuration, policy) as object),
        artifacts: {
          source: {
            url: "https://github.com/source.tar.gz",
            sha256: "0".repeat(64),
          },
          images: readImages(imageManifest),
        },
      }).artifacts.images;
      createReleaseArtifacts({
        ...configuration,
        ...policy,
        images,
        publishedDirectory: published,
      });
    }
  }
}

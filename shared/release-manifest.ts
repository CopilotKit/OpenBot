export type SourceKind = "stock" | "extended" | "forked" | "unknown";
export interface ReleaseManifest {
  schemaVersion: 1;
  distribution: { id: string; repository: string; channel: string };
  version: string;
  source: {
    commit: string;
    upstreamRepository: string;
    upstreamCommit: string;
    modified: boolean;
  };
  artifacts: {
    source: { url: string; sha256: string };
    images: Record<string, { reference: string }>;
    chart?: { version: string; url: string; sha256: string };
  };
  compatibility: {
    launcherApi: number;
    configSchema: number;
    extensionApi: number;
    database: { from: string[]; to: string; rollbackCompatible: boolean };
    intelligenceCapabilities: string[];
  };
  upgrade: {
    fromVersions: string[];
    requiresDowntime: boolean;
    recovery: "restart-previous" | "restore-backup";
  };
}
export interface InstalledRelease {
  manifest: ReleaseManifest;
  sourceKind: SourceKind;
  configSchema: number;
  extensionApi: number;
  launcherApi: number;
  intelligenceCapabilities: string[];
}
export interface UpgradePolicy {
  distributionId: string;
  repository: string;
  channel: string;
}
export interface UpgradePlan {
  allowed: boolean;
  reasons: string[];
  fromVersion: string;
  toVersion: string;
  requiresDowntime: boolean;
  recovery: "restart-previous" | "restore-backup";
}
function object(
  value: unknown,
  path: string,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${path}: expected object`);
  const record = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    throw new Error(`${path}: missing or unsupported fields`);
  return record;
}
function string(
  value: unknown,
  path: string,
  pattern = /^\S(?:.*\S)?$/,
): string {
  if (
    typeof value !== "string" ||
    !pattern.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error(`${path}: invalid string`);
  return value;
}
function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path}: expected boolean`);
  return value;
}
function api(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`${path}: expected positive API version`);
  return value;
}
function strings(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path}: expected string array`);
  const result = value.map((entry, index) =>
    string(entry, `${path}[${index}]`),
  );
  if (new Set(result).size !== result.length)
    throw new Error(`${path}: duplicate values`);
  return result;
}
function url(value: unknown, path: string): string {
  const result = string(value, path);
  const parsed = new URL(result);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  )
    throw new Error(
      `${path}: expected HTTPS URL without credentials or fragment`,
    );
  return result;
}
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const commitPattern = /^[0-9a-f]{40}$/;
const shaPattern = /^[0-9a-f]{64}$/;

/** Strict v1 decoding. Identity authentication is performed by the artifact consumer. */
export function parseReleaseManifest(input: unknown): ReleaseManifest {
  const root = object(input, "manifest", [
    "schemaVersion",
    "distribution",
    "version",
    "source",
    "artifacts",
    "compatibility",
    "upgrade",
  ]);
  if (root.schemaVersion !== 1)
    throw new Error("schemaVersion: unsupported manifest version");
  const distribution = object(root.distribution, "distribution", [
    "id",
    "repository",
    "channel",
  ]);
  const source = object(root.source, "source", [
    "commit",
    "upstreamRepository",
    "upstreamCommit",
    "modified",
  ]);
  const artifacts = object(
    root.artifacts,
    "artifacts",
    ["source", "images"],
    ["chart"],
  );
  const archive = object(artifacts.source, "artifacts.source", [
    "url",
    "sha256",
  ]);
  if (
    typeof artifacts.images !== "object" ||
    artifacts.images === null ||
    Array.isArray(artifacts.images)
  )
    throw new Error("artifacts.images: expected object");
  const images: ReleaseManifest["artifacts"]["images"] = {};
  for (const [name, value] of Object.entries(artifacts.images)) {
    string(name, "image name", /^[a-z0-9][a-z0-9_-]*$/);
    const image = object(value, `artifacts.images.${name}`, ["reference"]);
    images[name] = {
      reference: string(
        image.reference,
        `artifacts.images.${name}.reference`,
        /^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/,
      ),
    };
  }
  if (Object.keys(images).length === 0)
    throw new Error("artifacts.images: at least one image is required");
  let chart: ReleaseManifest["artifacts"]["chart"];
  if (artifacts.chart !== undefined) {
    const value = object(artifacts.chart, "artifacts.chart", [
      "version",
      "url",
      "sha256",
    ]);
    chart = {
      version: string(value.version, "artifacts.chart.version"),
      url: url(value.url, "artifacts.chart.url"),
      sha256: string(value.sha256, "artifacts.chart.sha256", shaPattern),
    };
  }
  const compatibility = object(root.compatibility, "compatibility", [
    "launcherApi",
    "configSchema",
    "extensionApi",
    "database",
    "intelligenceCapabilities",
  ]);
  const database = object(compatibility.database, "compatibility.database", [
    "from",
    "to",
    "rollbackCompatible",
  ]);
  const upgrade = object(root.upgrade, "upgrade", [
    "fromVersions",
    "requiresDowntime",
    "recovery",
  ]);
  if (
    upgrade.recovery !== "restart-previous" &&
    upgrade.recovery !== "restore-backup"
  )
    throw new Error("upgrade.recovery: unsupported recovery class");
  const rollbackCompatible = boolean(
    database.rollbackCompatible,
    "compatibility.database.rollbackCompatible",
  );
  if (!rollbackCompatible && upgrade.recovery === "restart-previous")
    throw new Error(
      "upgrade.recovery: incompatible database requires restore-backup",
    );
  return {
    schemaVersion: 1,
    distribution: {
      id: string(distribution.id, "distribution.id"),
      repository: string(
        distribution.repository,
        "distribution.repository",
        repositoryPattern,
      ),
      channel: string(distribution.channel, "distribution.channel"),
    },
    version: string(root.version, "version"),
    source: {
      commit: string(source.commit, "source.commit", commitPattern),
      upstreamRepository: string(
        source.upstreamRepository,
        "source.upstreamRepository",
        repositoryPattern,
      ),
      upstreamCommit: string(
        source.upstreamCommit,
        "source.upstreamCommit",
        commitPattern,
      ),
      modified: boolean(source.modified, "source.modified"),
    },
    artifacts: {
      source: {
        url: url(archive.url, "artifacts.source.url"),
        sha256: string(archive.sha256, "artifacts.source.sha256", shaPattern),
      },
      images,
      ...(chart ? { chart } : {}),
    },
    compatibility: {
      launcherApi: api(compatibility.launcherApi, "compatibility.launcherApi"),
      configSchema: api(
        compatibility.configSchema,
        "compatibility.configSchema",
      ),
      extensionApi: api(
        compatibility.extensionApi,
        "compatibility.extensionApi",
      ),
      database: {
        from: strings(database.from, "compatibility.database.from"),
        to: string(database.to, "compatibility.database.to"),
        rollbackCompatible,
      },
      intelligenceCapabilities: strings(
        compatibility.intelligenceCapabilities,
        "compatibility.intelligenceCapabilities",
      ),
    },
    upgrade: {
      fromVersions: strings(upgrade.fromVersions, "upgrade.fromVersions"),
      requiresDowntime: boolean(
        upgrade.requiresDowntime,
        "upgrade.requiresDowntime",
      ),
      recovery: upgrade.recovery,
    },
  };
}

/** Pure preflight; callers must authenticate metadata before passing it to the planner. */
export function planUpgrade(
  current: InstalledRelease,
  candidate: ReleaseManifest,
  policy: UpgradePolicy,
): UpgradePlan {
  const reasons: string[] = [];
  for (const [label, manifest] of [
    ["installed", current.manifest],
    ["candidate", candidate],
  ] as const) {
    if (manifest.distribution.id !== policy.distributionId)
      reasons.push(`${label} distribution ID does not match policy`);
    if (manifest.distribution.repository !== policy.repository)
      reasons.push(`${label} repository does not match policy`);
    if (manifest.distribution.channel !== policy.channel)
      reasons.push(`${label} channel does not match policy`);
  }
  if (current.sourceKind === "unknown" || current.sourceKind === "forked")
    reasons.push(
      `${current.sourceKind} source requires upstream integration before artifact replacement`,
    );
  for (const key of ["launcherApi", "configSchema", "extensionApi"] as const) {
    if (current[key] !== candidate.compatibility[key])
      reasons.push(
        `${key} ${current[key]} does not match required ${candidate.compatibility[key]}`,
      );
  }
  if (!candidate.upgrade.fromVersions.includes(current.manifest.version))
    reasons.push(`unsupported starting release ${current.manifest.version}`);
  if (
    !candidate.compatibility.database.from.includes(
      current.manifest.compatibility.database.to,
    )
  )
    reasons.push(
      `unsupported starting database ${current.manifest.compatibility.database.to}`,
    );
  for (const capability of candidate.compatibility.intelligenceCapabilities) {
    if (!current.intelligenceCapabilities.includes(capability))
      reasons.push(`missing Intelligence capability ${capability}`);
  }
  return {
    allowed: reasons.length === 0,
    reasons,
    fromVersion: current.manifest.version,
    toVersion: candidate.version,
    requiresDowntime: candidate.upgrade.requiresDowntime,
    recovery: candidate.upgrade.recovery,
  };
}

/** External extensions are an installed caller classification; these inputs describe core source. */
export function classifySource(source: {
  knownBaseline: boolean;
  managedModified: boolean;
  gitDirty: boolean;
  downstreamChanges: boolean;
}): SourceKind {
  if (!source.knownBaseline) return "unknown";
  return source.managedModified || source.gitDirty || source.downstreamChanges
    ? "forked"
    : "stock";
}

export type Kind = "stable" | "rc" | "beta" | "final";

export type Version = {
  major: number;
  minor: number;
  patch: number;
  pre?: { label: "rc" | "beta"; n: number };
};

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(rc|beta)\.([1-9]\d*))?$/;

// Reads a release version such as "0.3.0" or "0.3.0-rc.2". Anything else,
// including a leading "v", is refused so a bad tag never reaches a publish.
export function parseVersion(text: string): Version {
  const match = VERSION_PATTERN.exec(text);
  if (!match) throw new Error(`not a release version: ${text}`);
  const version: Version = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
  if (match[4]) {
    version.pre = { label: match[4] as "rc" | "beta", n: Number(match[5]) };
  }
  return version;
}

export function formatVersion(v: Version): string {
  const core = `${v.major}.${v.minor}.${v.patch}`;
  return v.pre ? `${core}-${v.pre.label}.${v.pre.n}` : core;
}

export function isPrerelease(text: string): boolean {
  return parseVersion(text).pre !== undefined;
}

// The branch a version is cut from: "0.3.0-rc.2" belongs to "release/0.3".
export function releaseBranch(text: string): string {
  const v = parseVersion(text);
  return `release/${v.major}.${v.minor}`;
}

export type Bump = "patch" | "minor" | "major";

function applyBump(v: Version, bump: Bump): Version {
  if (bump === "major") return { major: v.major + 1, minor: 0, patch: 0 };
  if (bump === "minor") return { major: v.major, minor: v.minor + 1, patch: 0 };
  return { major: v.major, minor: v.minor, patch: v.patch + 1 };
}

// The version a release of the given kind gets, counting from the current
// one. A candidate or beta keeps the version it is heading for, so the bump
// only matters for the first one.
export function nextVersion(current: string, bump: Bump, kind: Kind): string {
  const v = parseVersion(current);
  if (kind === "stable") {
    if (v.pre) {
      throw new Error(
        "a stable release cannot be cut from a prerelease; finish it with final",
      );
    }
    return formatVersion(applyBump(v, bump));
  }
  if (kind === "final") {
    if (!v.pre) throw new Error("no candidate to finish");
    return formatVersion({ major: v.major, minor: v.minor, patch: v.patch });
  }
  if (v.pre) {
    const n = v.pre.label === kind ? v.pre.n + 1 : 1;
    return formatVersion({ ...v, pre: { label: kind, n } });
  }
  return formatVersion({ ...applyBump(v, bump), pre: { label: kind, n: 1 } });
}

/**
 * The checks the Release workflow makes before anything is built, each a pure rule over files and
 * versions read from the repositories, so a release that would fail an hour in fails in a minute
 * instead, with a sentence saying what to fix.
 *
 * Each check returns the problems it found, in plain words, and an empty list when there are none.
 * The caller (scripts/release-run.ts) reads the inputs, runs every check, and prints every problem
 * before it stops, so one run names everything that needs fixing.
 *
 * - policyProblems: a release-policy.json written for this release, upgrading from the last one.
 *   Server images were once built from an OpenBot commit whose policy was still the previous
 *   release's, and nothing said so for an hour and a half.
 * - versionProblems: OpenBot's package.json, the server images' package.json and every chart's
 *   appVersion agree. Server images were once built from a tree that still said the previous
 *   release, and an image stamps the version it is built for.
 * - notesProblems: the notes the release will carry exist and say something.
 */
import { parseVersion } from "./release-version";

/** The parts of release-policy.json these checks read. */
export type ReleasePolicy = {
  version?: unknown;
  upgrade?: { fromVersions?: unknown };
};

const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** `v1.2.3-rc.1` and `1.2.3` both give `1.2.3`; anything that is not a release version gives undefined. */
function core(version: string): string | undefined {
  try {
    const v = parseVersion(version.replace(/^v/, ""));
    return `${v.major}.${v.minor}.${v.patch}`;
  } catch {
    return undefined;
  }
}

function compareCore(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (const index of [0, 1, 2]) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/**
 * The newest published stable release below `version` (`1.1.2` or `1.1.2-rc.1`), as its tag, from
 * the repository's release tags. Candidates, betas and anything that is not a version are skipped.
 * Undefined when there is none, as before the first release.
 */
export function previousStable(
  tags: readonly string[],
  version: string,
): string | undefined {
  const target = core(version);
  if (!target) throw new Error(`not a release version: ${version}`);
  return tags
    .filter((tag) => STABLE_TAG.test(tag))
    .filter((tag) => compareCore(tag.slice(1), target) < 0)
    .sort((a, b) => compareCore(b.slice(1), a.slice(1)))[0];
}

/**
 * Whether a release-policy.json is the one for `version` (`1.1.2`), upgrading from `previous`
 * (`v1.1.1`). A release's candidates, betas and final share one policy, which Create release PR
 * moves along from `v1.1.2` to `v1.1.2-rc.1` to `v1.1.2`, so any version of the same release
 * counts. A policy written for another release is the one left over from the last release.
 *
 * `where` names the file in the message, such as "OpenBot 8defa5bae, which the server images are built from,".
 */
export function policyProblems(
  where: string,
  policy: ReleasePolicy | undefined,
  version: string,
  previous: string | undefined,
): string[] {
  if (!policy) return [`${where} has no release-policy.json.`];
  const target = core(version);
  const written = typeof policy.version === "string" ? policy.version : "";
  const problems: string[] = [];
  if (!written || core(written) !== target) {
    problems.push(
      `${where} has a release-policy.json written for ${written || "no version"}, not v${version}. ` +
        `Merge the v${target} release policy to main first.`,
    );
  }
  const from = policy.upgrade?.fromVersions;
  if (!Array.isArray(from)) {
    problems.push(
      `${where} has a release-policy.json with no upgrade.fromVersions.`,
    );
  } else if (previous && !from.includes(previous)) {
    problems.push(
      `${where} has a release-policy.json whose upgrade.fromVersions leaves out ${previous}, the last release, ` +
        `so an installation on ${previous} could not upgrade to v${version}.`,
    );
  }
  return problems;
}

/** The versions the release must find in agreement before it moves any of them. */
export type Versions = {
  /** `version` in OpenBot's package.json on the branch being released: the last release cut there. */
  openbot: string;
  /** `version` in the server images' package.json. */
  server: string;
  /** Each published chart's appVersion, by chart name. */
  charts: Record<string, string>;
};

/**
 * Whether the versions agree, for a release of `version` (`1.1.2`). The server images may already
 * say the release (their version commit is made and kept by the release, so a release run again
 * finds it there) or still say the one before it, the same as OpenBot's package.json. Every chart's
 * appVersion is the server images' version, because a chart installs its appVersion's images.
 */
export function versionProblems(versions: Versions, version: string): string[] {
  const problems: string[] = [];
  const { openbot, server, charts } = versions;
  if (server !== openbot && server !== version) {
    problems.push(
      `The server images' package.json says ${server}, but OpenBot's says ${openbot} and this release is ${version}. ` +
        `They must say the same release before a release moves them both.`,
    );
  }
  for (const [chart, appVersion] of Object.entries(charts)) {
    if (appVersion !== server) {
      problems.push(
        `The ${chart} chart's appVersion is ${appVersion}, but the server images' package.json says ${server}. ` +
          `A chart installs the images of its appVersion, so they must agree.`,
      );
    }
  }
  return problems;
}

/** The text of a `## <heading>` section of the changelog, or undefined when there is none. */
export function changelogSection(
  changelog: string,
  heading: string,
): string | undefined {
  const lines = changelog.split(/\r?\n/);
  const start = lines.indexOf(`## ${heading}`);
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/**
 * Whether the changelog holds notes for `version` (`1.1.2`). They are what is under `## Unreleased`
 * when the release is cut: a final and a stable release promote that section to `## 1.1.2`, and a
 * candidate or beta publishes it as it is. A section for the version already there means the
 * release was cut before.
 */
export function notesProblems(changelog: string, version: string): string[] {
  const unreleased = changelogSection(changelog, "Unreleased");
  if (unreleased === undefined) {
    return [
      "CHANGELOG.md has no ## Unreleased section, which is where the release notes come from.",
    ];
  }
  const problems: string[] = [];
  if (!/\S/.test(unreleased)) {
    problems.push(
      `CHANGELOG.md has nothing under ## Unreleased, so v${version} would publish with no notes. ` +
        "Write them on main first.",
    );
  }
  if (changelogSection(changelog, version) !== undefined) {
    problems.push(
      `CHANGELOG.md already has a ## ${version} section, so v${version} was cut before.`,
    );
  }
  return problems;
}

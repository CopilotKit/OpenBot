#!/usr/bin/env bun
/**
 * The releases an installation upgrades to this tree from, for .github/workflows/desktop-upgrade.yml.
 *
 *     bun desktop/scripts/upgrade-legs.ts previous --releases releases.json
 *     bun desktop/scripts/upgrade-legs.ts window --releases releases.json
 *
 * `releases.json` is `gh release list --json tagName,publishedAt,isPrerelease`. Prints a JSON array
 * of release tags.
 *
 * - `previous`: the newest published release at or below this tree's version, the one most
 *   installations are on when this tree's app reaches them. Every pull request runs it.
 * - `window`: every release of the last 12 months that an installation can still be on and upgrade
 *   from. The window starts no earlier than the first release on the one API (the first release
 *   with `api/openapi.yaml`): the releases before it served addresses since retired. To those, the
 *   releases of the last 12 months that this tree's release-policy.json upgrades from. Run nightly.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const WINDOW_DAYS = 365;
const DAY = 24 * 60 * 60 * 1000;

export type Release = {
  tagName: string;
  publishedAt: string;
  isPrerelease: boolean;
};

const STABLE = /^v(\d+)\.(\d+)\.(\d+)$/;

export function compareTags(a: string, b: string): number {
  const left = STABLE.exec(a);
  const right = STABLE.exec(b);
  if (!left || !right) throw new Error(`Not a release tag: ${!left ? a : b}`);
  for (const index of [1, 2, 3]) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function stable(releases: readonly Release[]): Release[] {
  return releases
    .filter((release) => !release.isPrerelease && STABLE.test(release.tagName))
    .sort((a, b) => compareTags(b.tagName, a.tagName));
}

/** The newest published release at or below `version` (`1.1.0`). */
export function previousRelease(
  releases: readonly Release[],
  version: string,
): string | undefined {
  return stable(releases).find(
    (release) => compareTags(release.tagName, `v${version}`) <= 0,
  )?.tagName;
}

/**
 * The window's legs, newest first: releases of the last 12 months at or after `firstOneApi`, and
 * those the policy upgrades from. None newer than `version`, which is this tree.
 */
export function windowLegs(
  releases: readonly Release[],
  now: Date,
  version: string,
  firstOneApi: string | undefined,
  policy: { version: string; fromVersions: readonly string[] },
): string[] {
  const since = now.getTime() - WINDOW_DAYS * DAY;
  const upgradesFrom = new Set([policy.version, ...policy.fromVersions]);
  return stable(releases)
    .filter((release) => Date.parse(release.publishedAt) >= since)
    .filter((release) => compareTags(release.tagName, `v${version}`) <= 0)
    .filter(
      (release) =>
        (firstOneApi !== undefined &&
          compareTags(release.tagName, firstOneApi) >= 0) ||
        upgradesFrom.has(release.tagName),
    )
    .map((release) => release.tagName);
}

/** The oldest published release whose source has the one API's spec. */
async function firstOneApiRelease(
  releases: readonly Release[],
): Promise<string | undefined> {
  let first: string | undefined;
  for (const release of stable(releases)) {
    const response = await fetch(
      `https://raw.githubusercontent.com/CopilotKit/OpenBot/${release.tagName}/api/openapi.yaml`,
      { method: "HEAD" },
    );
    if (response.status === 404) break;
    if (!response.ok)
      throw new Error(`${release.tagName}'s spec answered ${response.status}.`);
    first = release.tagName;
  }
  return first;
}

if (import.meta.main) {
  const [mode] = process.argv.slice(2);
  const index = process.argv.indexOf("--releases");
  const file = index >= 0 ? process.argv[index + 1] : undefined;
  if ((mode !== "previous" && mode !== "window") || !file) {
    console.error(
      "Usage: upgrade-legs.ts previous|window --releases <releases.json>",
    );
    process.exit(2);
  }
  const root = resolve(import.meta.dir, "..", "..");
  const releases = JSON.parse(readFileSync(file, "utf8")) as Release[];
  const version = (
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  if (mode === "previous") {
    const previous = previousRelease(releases, version);
    console.log(JSON.stringify(previous ? [previous] : []));
  } else {
    const policy = JSON.parse(
      readFileSync(join(root, "release-policy.json"), "utf8"),
    ) as { version: string; upgrade: { fromVersions: string[] } };
    console.log(
      JSON.stringify(
        windowLegs(
          releases,
          new Date(),
          version,
          await firstOneApiRelease(releases),
          {
            version: policy.version,
            fromVersions: policy.upgrade.fromVersions,
          },
        ),
      ),
    );
  }
}

#!/usr/bin/env bun
/**
 * OpenBot's 12-month support window, held in CI (API versioning design, sections 4.3 and 6.3).
 *
 * A server serves every app released in the last 12 months, and a deprecated operation, parameter
 * or property keeps answering for at least 365 days after the release that first served it
 * deprecated. Two ways a change can quietly break that promise, each refused here:
 *
 * - a minimum app version (`minimumClients`) above an app released in the last 12 months, which
 *   would turn away an app we promise to serve. The window starts no earlier than each app's first
 *   release on the one API (/api/v2), since the addresses apps called before it were retired;
 * - a deprecation whose `x-sunset` is less than 365 days after the first release that served it
 *   deprecated, or that names no sunset at all.
 *
 * The window moves by itself: it is read from the published releases' dates, never from a list.
 *
 *     bun scripts/support-window.ts check --releases releases.json
 *     bun scripts/support-window.ts last-release --releases releases.json
 *     bun scripts/support-window.ts held-releases --releases releases.json
 *
 * `releases.json` is `gh release list --json tagName,publishedAt,isPrerelease`. `last-release`
 * prints the newest published release at or below this tree's version, or nothing.
 * `held-releases` prints every release whose spec this tree's spec is held to, one per line, newest
 * first (`heldReleases`).
 *
 * oasdiff (`--deprecation-days-stable`) holds the same 365 days on the day a deprecation is made;
 * this holds it against the release dates, over the whole spec, on every run.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";

/** How long the window is: 12 months, both for apps served and for deprecations. */
export const WINDOW_DAYS = 365;
const DAY = 24 * 60 * 60 * 1000;

/** A published release, as `gh release list --json tagName,publishedAt,isPrerelease` lists it. */
export type Release = {
  tagName: string;
  publishedAt: string;
  isPrerelease: boolean;
};

const STABLE = /^v?(\d+)\.(\d+)\.(\d+)$/;
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

/** Release order of two plain versions (`1.2.0`, `v1.2.0`); a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const left = VERSION.exec(a);
  const right = VERSION.exec(b);
  if (!left || !right)
    throw new Error(`Not a release number: ${!left ? a : b}`);
  for (const index of [1, 2, 3]) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  const leftPre = a.includes("-");
  const rightPre = b.includes("-");
  if (leftPre === rightPre) return 0;
  return leftPre ? -1 : 1;
}

/** Published releases that are not candidates or betas, oldest first. */
export function stableReleases(releases: readonly Release[]): Release[] {
  return releases
    .filter((release) => !release.isPrerelease && STABLE.test(release.tagName))
    .sort((a, b) => compareVersions(a.tagName, b.tagName));
}

/** The releases published in the `WINDOW_DAYS` before `now`, oldest first. */
export function windowReleases(
  releases: readonly Release[],
  now: Date,
): Release[] {
  const since = now.getTime() - WINDOW_DAYS * DAY;
  return stableReleases(releases).filter(
    (release) => Date.parse(release.publishedAt) >= since,
  );
}

/** The newest published release at or below `version`, the one this tree's apps follow. */
export function lastRelease(
  releases: readonly Release[],
  version: string,
): Release | undefined {
  return stableReleases(releases)
    .filter((release) => compareVersions(release.tagName, version) <= 0)
    .at(-1);
}

/**
 * Every release whose apps this tree must still serve, newest first: each one in the window at or
 * below this tree's version, and the last release even when it has aged out of the window. An app
 * of any of them was built from that release's spec and calls this tree's server, so this tree's
 * spec is held to each release's, not only to the last: a release in between need not have served
 * everything an older one did, and an app of the older one still calls it.
 */
export function heldReleases(
  releases: readonly Release[],
  version: string,
  now: Date,
): Release[] {
  const held = windowReleases(releases, now).filter(
    (release) => compareVersions(release.tagName, version) <= 0,
  );
  const last = lastRelease(releases, version);
  if (last && !held.some((release) => release.tagName === last.tagName))
    held.push(last);
  return held.sort((a, b) => compareVersions(b.tagName, a.tagName));
}

/**
 * Each minimum that would turn away an app released in the window: an app older than the minimum
 * is refused (`CLIENT_UPDATE_REQUIRED`), so the minimum may be no newer than the oldest release in
 * the window. A release at the minimum itself is still served.
 *
 * The window starts no earlier than each app's first release on the one API (`firstOneApi`): the
 * addresses apps called before /api/v2 were retired, so no server of today serves those releases
 * whatever the minimum says. An app with no first one-API release named is held from the start of
 * the window.
 */
export function minimumViolations(
  minimums: Readonly<Record<string, string>>,
  releases: readonly Release[],
  now: Date,
  firstOneApi: Readonly<Record<string, string>> = {},
): string[] {
  const window = windowReleases(releases, now);
  const violations: string[] = [];
  for (const [kind, minimum] of Object.entries(minimums)) {
    const first = firstOneApi[kind];
    const cutOff = window.filter(
      (release) =>
        compareVersions(release.tagName, minimum) < 0 &&
        (first === undefined || compareVersions(release.tagName, first) >= 0),
    );
    const oldest = cutOff[0];
    const newest = cutOff.at(-1);
    if (!oldest || !newest) continue;
    const named = (release: Release) =>
      `${release.tagName} (${day(release.publishedAt)})`;
    const span =
      cutOff.length === 1
        ? named(oldest)
        : `${cutOff.length} releases, ${named(oldest)} to ${named(newest)}`;
    violations.push(
      `minimumClients.${kind} is ${minimum}, which turns away ${kind} ${span}, published in the last 12 months${first ? ` on the one API (from ${first})` : ""}. The oldest ${kind} release the window serves is ${oldest.tagName}, so the minimum can be no newer than that.`,
    );
  }
  return violations;
}

/** One element of the spec marked `deprecated: true`, where it is and the sunset it names. */
export type Deprecation = { where: string; sunset: unknown };

/**
 * Every operation, parameter, schema or property the spec marks deprecated, by its JSON pointer.
 * Examples are values, not the API, so nothing under them counts.
 */
export function deprecations(spec: unknown): Deprecation[] {
  const found: Deprecation[] = [];
  const walk = (node: unknown, pointer: string) => {
    if (Array.isArray(node)) {
      for (const [index, item] of node.entries())
        walk(item, `${pointer}/${index}`);
      return;
    }
    if (!node || typeof node !== "object") return;
    const object = node as Record<string, unknown>;
    if (object.deprecated === true)
      found.push({ where: pointer || "/", sunset: object["x-sunset"] });
    for (const [key, value] of Object.entries(object)) {
      if (key === "example" || key === "examples") continue;
      walk(
        value,
        `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
      );
    }
  };
  walk(spec, "");
  return found;
}

const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A sunset date as oasdiff reads it: an RFC 3339 full date (`2027-11-17`). */
function sunsetDate(value: unknown): number | undefined {
  if (typeof value !== "string" || !FULL_DATE.test(value)) return undefined;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(time) ? undefined : time;
}

/**
 * Each deprecation that breaks the window. `served` is the date the first release that served each
 * deprecation was published, by pointer; a deprecation absent from it has not reached anybody yet,
 * and is only held to its sunset's presence (oasdiff holds its distance on the day it is made).
 */
export function sunsetViolations(
  current: readonly Deprecation[],
  served: ReadonlyMap<string, Date>,
): string[] {
  const violations: string[] = [];
  for (const { where, sunset } of current) {
    const date = sunsetDate(sunset);
    if (date === undefined) {
      violations.push(
        sunset === undefined
          ? `${where} is deprecated and names no x-sunset. Give it one at least ${WINDOW_DAYS} days after the release that first serves it deprecated.`
          : `${where} names x-sunset ${JSON.stringify(sunset)}, which is not a date such as 2027-11-17.`,
      );
      continue;
    }
    const servedOn = served.get(where);
    if (!servedOn) continue;
    // Counted in whole days, as the sunset is a date: from the day the release was published.
    const since = Date.parse(`${day(servedOn.toISOString())}T00:00:00Z`);
    const days = Math.round((date - since) / DAY);
    if (days < WINDOW_DAYS)
      violations.push(
        `${where} sunsets on ${sunset}, ${days} days after the release that first served it deprecated (${day(servedOn.toISOString())}). The window is ${WINDOW_DAYS} days, so its sunset can be no earlier than ${day(new Date(since + WINDOW_DAYS * DAY).toISOString())}.`,
      );
  }
  return violations;
}

/**
 * The date each deprecation was first served, from the published releases' specs: the oldest
 * release whose spec already marks it deprecated. While a release of this tree is being prepared
 * (its version is newer than every release), what it adds is served from today.
 */
export function firstServed(
  current: readonly Deprecation[],
  releases: readonly Release[],
  specAt: (tag: string) => unknown | undefined,
  version: string,
  now: Date,
): Map<string, Date> {
  const served = new Map<string, Date>();
  if (current.length === 0) return served;
  const wanted = new Set(current.map(({ where }) => where));
  for (const release of stableReleases(releases)) {
    const spec = specAt(release.tagName);
    if (spec === undefined) continue;
    for (const { where } of deprecations(spec)) {
      if (wanted.has(where) && !served.has(where))
        served.set(where, new Date(release.publishedAt));
    }
  }
  const newest = stableReleases(releases).at(-1);
  const preparing = !newest || compareVersions(version, newest.tagName) > 0;
  if (preparing)
    for (const where of wanted) if (!served.has(where)) served.set(where, now);
  return served;
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * The oldest release of each app this tree's server serves, and each app's first release on the
 * one API, kept side by side: `MINIMUM_CLIENTS` and `FIRST_ONE_API_RELEASES` in
 * shared/client-version.ts, or `minimumClients` and `firstOneApiReleases` in release-policy.json.
 * No minimums is nothing to hold.
 */
async function publishedMinimums(root: string): Promise<
  | {
      minimums: Record<string, string>;
      firstOneApi: Record<string, string>;
    }
  | undefined
> {
  const module = join(root, "shared", "client-version.ts");
  if (existsSync(module)) {
    const loaded = (await import(module)) as {
      MINIMUM_CLIENTS?: Record<string, string>;
      FIRST_ONE_API_RELEASES?: Record<string, string>;
    };
    if (loaded.MINIMUM_CLIENTS)
      return {
        minimums: { ...loaded.MINIMUM_CLIENTS },
        firstOneApi: { ...(loaded.FIRST_ONE_API_RELEASES ?? {}) },
      };
  }
  const policy = JSON.parse(
    readFileSync(join(root, "release-policy.json"), "utf8"),
  ) as {
    minimumClients?: Record<string, string>;
    firstOneApiReleases?: Record<string, string>;
  };
  return policy.minimumClients
    ? {
        minimums: policy.minimumClients,
        firstOneApi: policy.firstOneApiReleases ?? {},
      }
    : undefined;
}

/**
 * A release's spec, fetched by its tag when this checkout lacks it. Undefined if it has none.
 *
 * With `SUPPORT_WINDOW_RELEASE_SPECS` set to a directory, each release's spec is read from
 * `<directory>/<tag>.yaml` instead, and a release with no file there has none: the tests hold this
 * tree to a fixed set of releases without reaching the network.
 */
function releaseSpec(root: string, tag: string): unknown | undefined {
  const specs = process.env.SUPPORT_WINDOW_RELEASE_SPECS;
  if (specs) {
    const file = join(specs, `${tag}.yaml`);
    return existsSync(file)
      ? parse(readFileSync(file, "utf8"), { maxAliasCount: -1 })
      : undefined;
  }
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    });
  try {
    git("rev-parse", "--verify", "--quiet", `refs/tags/${tag}`);
  } catch {
    git(
      "fetch",
      "--no-tags",
      "--depth=1",
      "origin",
      `refs/tags/${tag}:refs/tags/${tag}`,
    );
  }
  try {
    return parse(git("show", `${tag}:api/openapi.yaml`), { maxAliasCount: -1 });
  } catch {
    return undefined;
  }
}

function argument(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`${name} <file> is required.`);
  return value;
}

async function main(args: readonly string[]): Promise<number> {
  const root = resolve(import.meta.dir, "..");
  const releases = JSON.parse(
    readFileSync(argument(args, "--releases"), "utf8"),
  ) as Release[];
  const version = (
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  const now = new Date(process.env.SUPPORT_WINDOW_NOW ?? Date.now());

  if (args[0] === "last-release") {
    const release = lastRelease(releases, version);
    if (release) console.log(release.tagName);
    return 0;
  }
  if (args[0] === "held-releases") {
    for (const release of heldReleases(releases, version, now))
      console.log(release.tagName);
    return 0;
  }
  if (args[0] !== "check") {
    console.error(
      "Usage: support-window.ts check|last-release|held-releases --releases <file>",
    );
    return 2;
  }

  const window = windowReleases(releases, now);
  console.log(
    `The window: ${window.length} releases since ${day(new Date(now.getTime() - WINDOW_DAYS * DAY).toISOString())} (${window.map((release) => release.tagName).join(", ") || "none"}).`,
  );
  const violations: string[] = [];

  const published = await publishedMinimums(root);
  if (published) {
    const listed = (record: Record<string, string>) =>
      Object.entries(record)
        .map(([kind, version]) => `${kind} ${version}`)
        .join(", ") || "none named";
    console.log(`Minimum apps: ${listed(published.minimums)}.`);
    console.log(
      `First releases on the one API: ${listed(published.firstOneApi)}.`,
    );
    violations.push(
      ...minimumViolations(
        published.minimums,
        releases,
        now,
        published.firstOneApi,
      ),
    );
  } else {
    console.log(
      "No minimum app versions are published yet (MINIMUM_CLIENTS in shared/client-version.ts, or minimumClients in release-policy.json), so none can cut the window.",
    );
  }

  const spec = parse(readFileSync(join(root, "api", "openapi.yaml"), "utf8"), {
    maxAliasCount: -1,
  });
  const current = deprecations(spec);
  console.log(`Deprecated in api/openapi.yaml: ${current.length}.`);
  const served = firstServed(
    current,
    releases,
    (tag) => releaseSpec(root, tag),
    version,
    now,
  );
  violations.push(...sunsetViolations(current, served));

  for (const violation of violations) console.log(`::error::${violation}`);
  if (violations.length > 0) return 1;
  console.log("The support window holds.");
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

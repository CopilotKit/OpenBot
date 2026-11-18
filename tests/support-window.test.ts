import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  deprecations,
  firstServed,
  lastRelease,
  minimumViolations,
  type Release,
  sunsetViolations,
  windowReleases,
} from "../scripts/support-window";
import published from "./fixtures/support-window/releases-2026-11-17.json";

// The 12-month support window (scripts/support-window.ts), against OpenBot's real published
// releases as GitHub listed them on 2026-11-17 and its real spec.

const releases = published as Release[];
const root = join(import.meta.dir, "..");
const RELEASE_DAY = new Date("2026-11-17T12:00:00Z");

describe("the last release a tree is held to", () => {
  test("is the newest published release at or below the tree's version", () => {
    expect(lastRelease(releases, "1.1.0")?.tagName).toBe("v1.1.0");
    // A release being prepared is held to the one before it.
    expect(lastRelease(releases, "1.2.0")?.tagName).toBe("v1.1.0");
    // A fix on the 1.0 line is held to the 1.0 line's last release, not to 1.1.0.
    expect(lastRelease(releases, "1.0.4")?.tagName).toBe("v1.0.3");
    // Candidates are never what apps were built from.
    expect(lastRelease(releases, "1.1.0-rc.3")?.tagName).toBe("v1.0.3");
    expect(lastRelease(releases, "0.0.0")).toBeUndefined();
  });
});

describe("the window", () => {
  test("is every release published in the last 365 days, candidates left out", () => {
    const window = windowReleases(releases, RELEASE_DAY);
    expect(window.map((release) => release.tagName)).toContain("v0.0.1");
    expect(window.every((release) => !release.isPrerelease)).toBe(true);
    expect(window.at(-1)?.tagName).toBe("v1.1.0");
  });

  test("moves by itself as releases age out", () => {
    const window = windowReleases(releases, new Date("2027-11-10T00:00:00Z"));
    expect(window.map((release) => release.tagName)).toEqual([
      "v1.0.1",
      "v1.0.2",
      "v1.0.3",
      "v1.1.0",
    ]);
  });
});

describe("a minimum app version", () => {
  test("above an app released in the last 12 months fails, naming the apps it would turn away", () => {
    const violations = minimumViolations(
      { desktop: "1.0.2", mobile: "1.1.0" },
      releases,
      RELEASE_DAY,
    );
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain("minimumClients.desktop is 1.0.2");
    expect(violations[0]).toContain("v1.0.1 (2026-11-10)");
    expect(violations[0]).toContain("no newer than that");
    expect(violations[1]).toContain("v1.0.3 (2026-11-14)");
  });

  test("at or below the oldest release in the window passes", () => {
    expect(
      minimumViolations(
        { desktop: "0.0.1", web: "0.0.1" },
        releases,
        RELEASE_DAY,
      ),
    ).toEqual([]);
    // A year on, 1.0.2 is the oldest Desktop still in the window, so it may be the minimum, and
    // 1.1.0 still may not.
    const later = new Date("2027-11-11T12:00:00Z");
    expect(minimumViolations({ desktop: "1.0.2" }, releases, later)).toEqual(
      [],
    );
    expect(
      minimumViolations({ mobile: "1.1.0" }, releases, later),
    ).toHaveLength(1);
  });

  // Each app's first release that calls /api/v2: 1.1.0 for all four. v1.0.3's web app, Desktop,
  // phone app and Recorder call none of it, and the addresses they did call were retired in 1.1.0.
  const FIRST_ONE_API_RELEASES = {
    web: "1.1.0",
    desktop: "1.1.0",
    mobile: "1.1.0",
    recorder: "1.1.0",
  };

  test("is held only against releases on the one API, which no server of today can serve before", () => {
    // The minimums proposed with the client identity check: every release they turn away predates
    // the one API.
    expect(
      minimumViolations(
        { web: "1.1.0", desktop: "1.0.2", mobile: "1.1.0", recorder: "1.1.0" },
        releases,
        RELEASE_DAY,
        FIRST_ONE_API_RELEASES,
      ),
    ).toEqual([]);
    // A minimum that turns away 1.1.0, an app on the one API published this week, still fails.
    const violations = minimumViolations(
      { desktop: "1.2.0" },
      releases,
      RELEASE_DAY,
      FIRST_ONE_API_RELEASES,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("v1.1.0 (2026-11-17)");
    expect(violations[0]).toContain("on the one API (from 1.1.0)");
  });
});

describe("a deprecation's sunset", () => {
  const spec = parse(readFileSync(join(root, "api", "openapi.yaml"), "utf8"), {
    maxAliasCount: -1,
  }) as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };
  const path = "/api/v2/organizations/{organizationId}/deployment";
  const where = `/paths/${path.replaceAll("/", "~1")}/get`;
  const deprecated = (sunset?: string) => {
    const copy = structuredClone(spec);
    const operation = copy.paths[path]?.get;
    if (!operation) throw new Error(`${path} has no get in the spec`);
    operation.deprecated = true;
    if (sunset !== undefined) operation["x-sunset"] = sunset;
    return copy;
  };

  test("today's spec deprecates nothing, so nothing is held", () => {
    expect(deprecations(spec)).toEqual([]);
  });

  test("is found on the operation that names it", () => {
    expect(deprecations(deprecated("2027-12-01"))).toEqual([
      { where, sunset: "2027-12-01" },
    ]);
  });

  test("is required, and must be a date", () => {
    expect(
      sunsetViolations(deprecations(deprecated()), new Map())[0],
    ).toContain("names no x-sunset");
    expect(
      sunsetViolations(deprecations(deprecated("next year")), new Map())[0],
    ).toContain("is not a date");
  });

  test("fewer than 365 days after the release that first served it fails", () => {
    const served = new Map([[where, new Date("2026-11-17T09:57:15Z")]]);
    const early = sunsetViolations(
      deprecations(deprecated("2027-09-01")),
      served,
    );
    expect(early).toHaveLength(1);
    expect(early[0]).toContain("288 days after");
    expect(early[0]).toContain("no earlier than 2027-11-17");
    // 365 days to the day passes.
    expect(
      sunsetViolations(deprecations(deprecated("2027-11-17")), served),
    ).toEqual([]);
  });

  test("is counted from the oldest release whose spec already deprecated it", () => {
    const current = deprecations(deprecated("2027-12-01"));
    const specs: Record<string, unknown> = {
      "v1.0.3": undefined,
      "v1.1.0": deprecated("2027-12-01"),
    };
    const served = firstServed(
      current,
      releases,
      (tag) => specs[tag],
      "1.1.0",
      RELEASE_DAY,
    );
    expect(served.get(where)?.toISOString()).toBe("2026-11-17T09:57:15.000Z");
  });

  test("not yet released is held from today while a release of it is being prepared, and not before", () => {
    const current = deprecations(deprecated("2027-06-01"));
    const none = () => undefined;
    expect(
      firstServed(current, releases, none, "1.1.0", RELEASE_DAY).size,
    ).toBe(0);
    const preparing = firstServed(
      current,
      releases,
      none,
      "1.2.0",
      RELEASE_DAY,
    );
    expect(preparing.get(where)).toEqual(RELEASE_DAY);
    expect(sunsetViolations(current, preparing)[0]).toContain("196 days after");
  });
});

test("this tree holds the window", () => {
  const run = Bun.spawnSync(
    [
      process.execPath,
      join(root, "scripts", "support-window.ts"),
      "check",
      "--releases",
      join(
        import.meta.dir,
        "fixtures",
        "support-window",
        "releases-2026-11-17.json",
      ),
    ],
    {
      env: { ...process.env, SUPPORT_WINDOW_NOW: RELEASE_DAY.toISOString() },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = `${run.stdout}${run.stderr}`;
  expect(output).toContain("The window: 29 releases since 2025-11-17");
  // The minimums, once published, are held by the rule above; until then there are none to hold.
  expect(run.exitCode, output).toBe(0);
});

import { expect, test } from "bun:test";
import { previousRelease, type Release, windowLegs } from "./upgrade-legs";

// The releases the Desktop upgrade job runs from (upgrade-legs.ts), against part of OpenBot's real
// published releases as GitHub listed them on 2026-11-17, and that day's release-policy.json.

const releases: Release[] = [
  {
    tagName: "v1.1.0",
    publishedAt: "2026-11-17T09:57:15Z",
    isPrerelease: false,
  },
  {
    tagName: "v1.1.0-rc.2",
    publishedAt: "2026-11-17T08:23:41Z",
    isPrerelease: true,
  },
  {
    tagName: "v1.0.3",
    publishedAt: "2026-11-14T04:05:50Z",
    isPrerelease: false,
  },
  {
    tagName: "v1.0.2",
    publishedAt: "2026-11-11T08:45:38Z",
    isPrerelease: false,
  },
  {
    tagName: "v1.0.1",
    publishedAt: "2026-11-10T18:00:32Z",
    isPrerelease: false,
  },
  {
    tagName: "v1.0.0",
    publishedAt: "2026-11-09T09:13:22Z",
    isPrerelease: false,
  },
  {
    tagName: "v0.3.4",
    publishedAt: "2026-11-08T22:36:34Z",
    isPrerelease: false,
  },
  {
    tagName: "v0.3.0",
    publishedAt: "2026-11-06T00:44:04Z",
    isPrerelease: false,
  },
  {
    tagName: "v0.2.0",
    publishedAt: "2026-10-12T15:19:49Z",
    isPrerelease: false,
  },
  {
    tagName: "v0.0.1",
    publishedAt: "2026-08-17T02:36:55Z",
    isPrerelease: false,
  },
];
const policy = {
  version: "v1.1.0",
  fromVersions: [
    "v1.0.3",
    "v1.0.2",
    "v1.0.1",
    "v1.0.0",
    "v0.3.4",
    "v0.3.3",
    "v0.3.2",
    "v0.3.1",
    "v0.3.0",
  ],
};
const day = new Date("2026-11-17T12:00:00Z");

test("a pull request upgrades from the newest release at or below this tree", () => {
  expect(previousRelease(releases, "1.1.0")).toBe("v1.1.0");
  expect(previousRelease(releases, "1.2.0")).toBe("v1.1.0");
  expect(previousRelease(releases, "1.0.4")).toBe("v1.0.3");
});

// A release branch carries its candidate's version in package.json, such as 1.1.1-rc.1 on
// release/1.1, and every pull request into it runs these. A candidate orders before its own release
// and after the one before it, as semver says.
test("a candidate's tree upgrades from the release before it", () => {
  expect(previousRelease(releases, "1.1.1-rc.1")).toBe("v1.1.0");
  expect(previousRelease(releases, "1.1.0-rc.2")).toBe("v1.0.3");
  const final = {
    tagName: "v1.1.1",
    publishedAt: day.toISOString(),
    isPrerelease: false,
  };
  expect(previousRelease([final, ...releases], "1.1.1-rc.2")).toBe("v1.1.0");
});

test("a candidate's nightly run takes the same legs as its release", () => {
  expect(windowLegs(releases, day, "1.1.1-rc.1", "v1.1.0", policy)).toEqual(
    windowLegs(releases, day, "1.1.1", "v1.1.0", policy),
  );
});

test("the nightly run upgrades from the one-API releases and every one the policy upgrades from", () => {
  expect(windowLegs(releases, day, "1.1.0", "v1.1.0", policy)).toEqual([
    "v1.1.0",
    "v1.0.3",
    "v1.0.2",
    "v1.0.1",
    "v1.0.0",
    "v0.3.4",
    "v0.3.0",
  ]);
});

test("a release before the one API that the policy no longer upgrades from is not a leg", () => {
  const legs = windowLegs(releases, day, "1.1.0", "v1.1.0", policy);
  expect(legs).not.toContain("v0.2.0");
  expect(legs).not.toContain("v0.0.1");
});

test("a release ages out of the window a year after it was published", () => {
  const later = new Date("2027-11-12T00:00:00Z");
  expect(windowLegs(releases, later, "1.1.0", "v1.1.0", policy)).toEqual([
    "v1.1.0",
    "v1.0.3",
  ]);
});

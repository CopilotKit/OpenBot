import { expect, test } from "bun:test";
import {
  formatVersion,
  isPrerelease,
  nextVersion,
  parseVersion,
  releaseBranch,
} from "./release-version";

test("parseVersion rejects text that is not a release version", () => {
  for (const text of [
    "0.3",
    "0.3.0-rc.0",
    "0.3.0-alpha.1",
    "0.3.0-rc",
    "v0.3.0",
  ]) {
    expect(() => parseVersion(text)).toThrow(`not a release version: ${text}`);
  }
});

test("formatVersion round-trips parseVersion", () => {
  for (const text of ["0.2.0", "0.3.0-rc.2", "0.3.0-beta.1"]) {
    expect(formatVersion(parseVersion(text))).toBe(text);
  }
});

test("parseVersion reads the prerelease label and number", () => {
  expect(parseVersion("0.3.0-rc.2")).toEqual({
    major: 0,
    minor: 3,
    patch: 0,
    pre: { label: "rc", n: 2 },
  });
});

test("isPrerelease is true only for versions with a prerelease part", () => {
  expect(isPrerelease("0.3.0-rc.2")).toBe(true);
  expect(isPrerelease("0.3.0-beta.1")).toBe(true);
  expect(isPrerelease("0.3.0")).toBe(false);
});

test("releaseBranch names the major.minor release branch", () => {
  expect(releaseBranch("0.3.0-rc.2")).toBe("release/0.3");
  expect(releaseBranch("1.12.4")).toBe("release/1.12");
});

test("nextVersion cuts a candidate from a stable version", () => {
  expect(nextVersion("0.2.0", "minor", "rc")).toBe("0.3.0-rc.1");
});

test("nextVersion counts up within one label and restarts on a new label", () => {
  expect(nextVersion("0.3.0-rc.1", "minor", "rc")).toBe("0.3.0-rc.2");
  expect(nextVersion("0.3.0-beta.2", "minor", "rc")).toBe("0.3.0-rc.1");
});

test("nextVersion finishes a candidate as the stable version", () => {
  expect(nextVersion("0.3.0-rc.2", "minor", "final")).toBe("0.3.0");
});

test("nextVersion applies the bump for stable releases", () => {
  expect(nextVersion("0.2.0", "patch", "stable")).toBe("0.2.1");
  expect(nextVersion("0.2.0", "major", "stable")).toBe("1.0.0");
});

test("nextVersion refuses a final without a candidate", () => {
  expect(() => nextVersion("0.2.0", "patch", "final")).toThrow(
    "no candidate to finish",
  );
});

test("nextVersion refuses a stable release from a prerelease", () => {
  expect(() => nextVersion("0.3.0-rc.1", "patch", "stable")).toThrow(
    "a stable release cannot be cut from a prerelease; finish it with final",
  );
});

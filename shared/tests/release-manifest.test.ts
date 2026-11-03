import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import conformance from "../fixtures/releases/conformance.json";
import {
  classifySource,
  parseReleaseManifest,
  planUpgrade,
  type InstalledRelease,
  type ReleaseManifest,
} from "../release-manifest";

function fixture(name = "candidate"): ReleaseManifest {
  return parseReleaseManifest(
    JSON.parse(
      readFileSync(
        join(import.meta.dir, "../fixtures/releases", `${name}.json`),
        "utf8",
      ),
    ),
  );
}

const policy = {
  distributionId: "acme.openbot",
  repository: "acme/openbot",
  channel: "stable",
};
function installed(
  overrides: Partial<InstalledRelease> = {},
): InstalledRelease {
  return {
    manifest: fixture("installed"),
    sourceKind: "stock",
    configSchema: 1,
    extensionApi: 1,
    launcherApi: 1,
    intelligenceCapabilities: ["conversations.v1"],
    ...overrides,
  };
}

describe("release manifest v1", () => {
  test.each(conformance.parse)("shared fixture $name", ({ file, valid }) => {
    const input = JSON.parse(
      readFileSync(join(import.meta.dir, "../fixtures/releases", file), "utf8"),
    );
    if (valid) expect(parseReleaseManifest(input).schemaVersion).toBe(1);
    else expect(() => parseReleaseManifest(input)).toThrow();
  });
  test("accepts an exact source and digest-pinned fork release", () => {
    expect(fixture().distribution.repository).toBe("acme/openbot");
    expect(planUpgrade(installed(), fixture(), policy).allowed).toBe(true);
  });
  test.each([
    ["schema", (m: ReleaseManifest) => ({ ...m, schemaVersion: 2 })],
    ["unknown field", (m: ReleaseManifest) => ({ ...m, ignored: true })],
    [
      "source checksum",
      (m: ReleaseManifest) => ({
        ...m,
        artifacts: {
          ...m.artifacts,
          source: { ...m.artifacts.source, sha256: "abc" },
        },
      }),
    ],
    [
      "mutable image",
      (m: ReleaseManifest) => ({
        ...m,
        artifacts: {
          ...m.artifacts,
          images: { server: { reference: "ghcr.io/acme/openbot:latest" } },
        },
      }),
    ],
    [
      "unsafe source URL",
      (m: ReleaseManifest) => ({
        ...m,
        artifacts: {
          ...m.artifacts,
          source: {
            ...m.artifacts.source,
            url: "http://example.com/archive.tar.gz",
          },
        },
      }),
    ],
    [
      "unsafe rollback",
      (m: ReleaseManifest) => ({
        ...m,
        compatibility: {
          ...m.compatibility,
          database: { ...m.compatibility.database, rollbackCompatible: false },
        },
      }),
    ],
  ])("rejects %s", (_name, change) =>
    expect(() => parseReleaseManifest(change(fixture()))).toThrow(),
  );
});

describe("upgrade preflight", () => {
  test.each([
    [
      "distribution",
      (m: ReleaseManifest) => ({
        ...m,
        distribution: { ...m.distribution, id: "upstream.openbot" },
      }),
    ],
    [
      "repository",
      (m: ReleaseManifest) => ({
        ...m,
        distribution: { ...m.distribution, repository: "CopilotKit/openbot" },
      }),
    ],
    [
      "channel",
      (m: ReleaseManifest) => ({
        ...m,
        distribution: { ...m.distribution, channel: "preview" },
      }),
    ],
    [
      "launcher",
      (m: ReleaseManifest) => ({
        ...m,
        compatibility: { ...m.compatibility, launcherApi: 2 },
      }),
    ],
    [
      "configuration",
      (m: ReleaseManifest) => ({
        ...m,
        compatibility: { ...m.compatibility, configSchema: 2 },
      }),
    ],
    [
      "extension",
      (m: ReleaseManifest) => ({
        ...m,
        compatibility: { ...m.compatibility, extensionApi: 2 },
      }),
    ],
    [
      "starting version",
      (m: ReleaseManifest) => ({
        ...m,
        upgrade: { ...m.upgrade, fromVersions: ["v0.1.0"] },
      }),
    ],
    [
      "database",
      (m: ReleaseManifest) => ({
        ...m,
        compatibility: {
          ...m.compatibility,
          database: { ...m.compatibility.database, from: ["unrelated"] },
        },
      }),
    ],
    [
      "Intelligence",
      (m: ReleaseManifest) => ({
        ...m,
        compatibility: {
          ...m.compatibility,
          intelligenceCapabilities: ["missing.v2"],
        },
      }),
    ],
  ])("blocks incompatible %s before mutation", (_name, change) => {
    const current = installed();
    const before = JSON.stringify(current);
    const plan = planUpgrade(current, change(fixture()), policy);
    expect(plan.allowed).toBe(false);
    expect(plan.reasons.length).toBeGreaterThan(0);
    expect(JSON.stringify(current)).toBe(before);
  });
  test.each(["unknown", "forked"] as const)(
    "blocks %s installed origin",
    (sourceKind) =>
      expect(
        planUpgrade(installed({ sourceKind }), fixture(), policy).allowed,
      ).toBe(false),
  );
  test("supports preserved external customizations and declares recovery", () => {
    expect(
      planUpgrade(installed({ sourceKind: "extended" }), fixture(), policy),
    ).toEqual({
      allowed: true,
      reasons: [],
      fromVersion: "v0.2.0",
      toVersion: "v0.3.0",
      requiresDowntime: true,
      recovery: "restart-previous",
    });
  });
  test("blocks an installed distribution that does not match policy", () => {
    const current = installed();
    current.manifest.distribution.repository = "untrusted/openbot";
    expect(planUpgrade(current, fixture(), policy).allowed).toBe(false);
  });
});

describe("source classification", () => {
  test.each([
    [
      {
        knownBaseline: false,
        managedModified: false,
        gitDirty: false,
        downstreamChanges: false,
      },
      "unknown",
    ],
    [
      {
        knownBaseline: true,
        managedModified: false,
        gitDirty: false,
        downstreamChanges: false,
      },
      "stock",
    ],
    [
      {
        knownBaseline: true,
        managedModified: true,
        gitDirty: false,
        downstreamChanges: false,
      },
      "forked",
    ],
    [
      {
        knownBaseline: true,
        managedModified: false,
        gitDirty: true,
        downstreamChanges: false,
      },
      "forked",
    ],
    [
      {
        knownBaseline: true,
        managedModified: false,
        gitDirty: false,
        downstreamChanges: true,
      },
      "forked",
    ],
  ] as const)("classifies %j as %s", (source, expected) =>
    expect(classifySource(source)).toBe(expected),
  );
});

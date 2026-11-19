import { describe, expect, test } from "bun:test";
import published from "../fixtures/releases/published-v1.1.0.json";
import { identityMatches, lastMigrationName } from "../kubernetes-promotion";
import { parseReleaseManifest } from "../release-manifest";

// What the published v1.1.0 server answers on /release, read from a running pod of
// ghcr.io/copilotkit/openbot@sha256:479cccd4... installed by the v1.1.0 openbot-bundle chart.
const served = {
  version: "v1.1.0",
  commit: "9a11f982a74aa8c65a1e6983e3977612f7abab29",
  distributionId: "CopilotKit/OpenBot",
  repository: "CopilotKit/OpenBot",
  channel: "stable",
};

describe("running release identity", () => {
  const manifest = parseReleaseManifest(structuredClone(published));

  test("a published release's server is accepted as that release, though it reports its image's build commit", () => {
    expect(manifest.source.commit).not.toBe(served.commit);
    expect(identityMatches(served, manifest)).toBe(true);
  });

  test("another version, distribution, repository or channel is refused", () => {
    expect(identityMatches({ ...served, version: "v1.0.3" }, manifest)).toBe(
      false,
    );
    expect(
      identityMatches({ ...served, distributionId: "acme.openbot" }, manifest),
    ).toBe(false);
    expect(
      identityMatches({ ...served, repository: "acme/openbot" }, manifest),
    ).toBe(false);
    expect(identityMatches({ ...served, channel: "internal" }, manifest)).toBe(
      false,
    );
  });
});

describe("last applied migration", () => {
  test("read from the object a current server reports, the name an earlier one reported, or nothing", () => {
    // A server with the internal status listener answers /release with an object.
    expect(
      lastMigrationName({
        ...served,
        lastAppliedMigration: {
          name: "0137_ai_connections",
          hash: "9f2c4e1a7b3d5f60",
          createdAt: 1763452800000,
        },
      }),
    ).toBe("0137_ai_connections");
    expect(
      lastMigrationName({
        ...served,
        lastAppliedMigration: "0132_bot_task_runs",
      }),
    ).toBe("0132_bot_task_runs");
    // v1.1.0's server, above, names none.
    expect(lastMigrationName(served)).toBeNull();
    expect(
      lastMigrationName({ ...served, lastAppliedMigration: null }),
    ).toBeNull();
    expect(lastMigrationName(null)).toBeNull();
  });
});

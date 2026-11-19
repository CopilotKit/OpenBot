import { describe, expect, test } from "bun:test";
import published from "../fixtures/releases/published-v1.1.0.json";
import { identityMatches } from "../kubernetes-promotion";
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

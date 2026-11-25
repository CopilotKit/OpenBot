import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChannel, releaseBuildEnv } from "./release-build";

/*
 * OpenBot Cloud is on in a release or candidate installer and off in every other build: an internal
 * build, a pull request's, and the window run in development. A release build can still turn it
 * off from its environment.
 */
describe("the release build config", () => {
  test("a release build turns OpenBot Cloud on", () => {
    expect(releaseBuildEnv("release", {})).toEqual({
      VITE_OPENBOT_CLOUD_ENABLED: "true",
    });
  });

  test("an internal build, or one desktop-version.ts never ran for, adds nothing", () => {
    expect(releaseBuildEnv("internal", {})).toEqual({});
    expect(releaseBuildEnv(undefined, {})).toEqual({});
  });

  test("a value in the build's environment wins, so a release build can turn Cloud off", () => {
    expect(
      releaseBuildEnv("release", { VITE_OPENBOT_CLOUD_ENABLED: "false" }),
    ).toEqual({});
  });

  test("reads the channel desktop-version.ts writes, and none where it has not run", () => {
    const folder = mkdtempSync(join(tmpdir(), "release-build-"));
    const file = join(folder, "build-version.json");
    expect(buildChannel(file)).toBeUndefined();
    // As `desktop-version.ts release` writes it.
    writeFileSync(
      file,
      `${JSON.stringify({ version: "1.1.3-rc.1", releaseVersion: "1.1.3-rc.1", sourceSha: "0".repeat(40), channel: "release" }, null, 2)}\n`,
    );
    expect(buildChannel(file)).toBe("release");
  });
});

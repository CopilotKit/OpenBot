import { describe, expect, test } from "bun:test";
import { desktopTelemetryProperties } from "./desktop-telemetry";

describe("desktop runtime metadata", () => {
  test("leaves ordinary server deployments untagged", () => {
    expect(desktopTelemetryProperties({})).toEqual({});
    expect(
      desktopTelemetryProperties({ OPENBOT_DISTRIBUTION: "server" }),
    ).toEqual({});
  });

  test("carries only the shell's bounded metadata", () => {
    expect(
      desktopTelemetryProperties({
        OPENBOT_DISTRIBUTION: "desktop",
        OPENBOT_VERSION: "0.0.9",
        OPENBOT_PLATFORM: "macos",
        OPENBOT_ARCH: "aarch64",
        OPENBOT_OS_VERSION: "15.6.1",
        OPENBOT_ENGINE: "podman",
        OPENAI_API_KEY: "synthetic-secret",
        CPK_TELEMETRY_ID: "identity-belongs-in-the-transport",
        HOME: "/Users/private-name",
        OPENBOT_BASE_URL: "https://private.example",
      }),
    ).toEqual({
      openbot_distribution: "desktop",
      openbot_version: "0.0.9",
      openbot_platform: "macos",
      openbot_arch: "aarch64",
      openbot_os_version: "15.6.1",
      openbot_engine: "podman",
    });
  });

  test.each([
    "/Users/private-name",
    "private.example",
    "1.2-private-name",
    "1.2\nsecret",
    "1.2\n",
    "1.2.3.4.5",
    "1".repeat(40),
  ])("rejects arbitrary text in every metadata field: %s", (value) => {
    expect(
      desktopTelemetryProperties({
        OPENBOT_DISTRIBUTION: "desktop",
        OPENBOT_VERSION: value,
        OPENBOT_OS_VERSION: value,
        OPENBOT_PLATFORM: value,
        OPENBOT_ARCH: value,
        OPENBOT_ENGINE: value,
      }),
    ).toEqual({ openbot_distribution: "desktop" });
  });
});

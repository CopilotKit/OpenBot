import { expect, test } from "bun:test";
import { loadHermesBridgeConfig } from "../src/config";

test("Hermes bridge config requires an explicit roster and loopback binding", () => {
  expect(() =>
    loadHermesBridgeConfig({
      OPENBOT_HERMES_BRIDGE_TOKEN: "bridge-test-token",
    }),
  ).toThrow("OPENBOT_HERMES_PROFILES");

  const config = loadHermesBridgeConfig({
    OPENBOT_HERMES_BRIDGE_TOKEN: "bridge-test-token",
    OPENBOT_HERMES_PROFILES: JSON.stringify([
      { id: "profile-allowed", displayName: "Configured Local Profile" },
    ]),
  });
  expect(config.host).toBe("127.0.0.1");
  expect(config.roster).toEqual([
    { id: "profile-allowed", displayName: "Configured Local Profile" },
  ]);

  expect(() =>
    loadHermesBridgeConfig({
      OPENBOT_HERMES_BRIDGE_TOKEN: "bridge-test-token",
      OPENBOT_HERMES_PROFILES: JSON.stringify([
        { id: "profile-allowed", displayName: "Configured Local Profile" },
      ]),
      OPENBOT_HERMES_BRIDGE_HOST: "0.0.0.0",
    }),
  ).toThrow("loopback");
});

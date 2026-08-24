import { expect, test } from "bun:test";
import { startHermesBridgeFromEnv } from "../src/entrypoint";
import type { HermesCommandRunner } from "../src/bridge";

test("configured Hermes bridge entrypoint starts only after roster verification", async () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);

  const runner: HermesCommandRunner = {
    async run(args) {
      if (args.includes("profile")) {
        return { exitCode: 0, stdout: "profile exists", stderr: "" };
      }
      return { exitCode: 0, stdout: "OPENBOT_HERMES_ENTRYPOINT_OK", stderr: "" };
    },
  };
  const started = await startHermesBridgeFromEnv(
    {
      OPENBOT_HERMES_BRIDGE_TOKEN: "bridge-test-token",
      OPENBOT_HERMES_PROFILES: JSON.stringify([
        { id: "profile-allowed", displayName: "Configured Local Profile" },
      ]),
      OPENBOT_HERMES_BRIDGE_PORT: String(port),
    },
    runner,
  );

  try {
    expect(started.server.port).toBe(port);
  } finally {
    started.server.stop(true);
  }
});

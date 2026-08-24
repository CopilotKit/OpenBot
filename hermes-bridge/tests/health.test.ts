import { expect, test } from "bun:test";
import { createHermesBridge, type HermesCommandRunner } from "../src/bridge";

test("Hermes bridge health endpoints report liveness and verified readiness without chat", async () => {
  const runner: HermesCommandRunner = {
    async run(args) {
      if (args.includes("profile")) {
        return { exitCode: 0, stdout: "profile exists", stderr: "" };
      }
      throw new Error("chat must not run for health checks");
    },
  };
  const bridge = createHermesBridge(
    {
      authToken: "bridge-test-token",
      cliPath: "hermes",
      roster: [{ id: "profile-allowed", displayName: "Configured Local Profile" }],
      timeoutMs: 1_000,
    },
    runner,
  );

  const health = await bridge.handle(new Request("http://127.0.0.1/health"));
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ ok: true });

  const readiness = await bridge.handle(new Request("http://127.0.0.1/health/ready"));
  expect(readiness.status).toBe(200);
  expect(await readiness.json()).toEqual({ ok: true });
});

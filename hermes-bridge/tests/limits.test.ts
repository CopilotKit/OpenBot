import { expect, test } from "bun:test";
import { createHermesBridge, type HermesCommandRunner } from "../src/bridge";

test("Hermes bridge rejects an oversized declared body before consuming it", async () => {
  const runner: HermesCommandRunner = {
    async run(args) {
      if (args.includes("profile")) {
        return { exitCode: 0, stdout: "profile exists", stderr: "" };
      }
      throw new Error("chat must not run");
    },
  };
  const bridge = createHermesBridge(
    {
      authToken: "bridge-test-token",
      cliPath: "hermes",
      roster: [{ id: "profile-allowed", displayName: "Configured Local Profile" }],
      maxInputChars: 100,
      timeoutMs: 1_000,
    },
    runner,
  );
  expect((await bridge.ready()).ok).toBe(true);

  const request = new Request("http://127.0.0.1/ag-ui/profile-allowed", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": "100000",
      "x-openbot-agent-token": "bridge-test-token",
    },
    body: "{}",
  });

  const response = await bridge.handle(request);
  expect(response.status).toBe(413);
});

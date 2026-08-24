import { expect, test } from "bun:test";
import {
  createHermesBridge,
  type HermesCommandRunner,
} from "../src/bridge";

function bridgeRequest(): Request {
  return new Request("http://127.0.0.1/ag-ui/profile-allowed", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openbot-agent-token": "bridge-test-token",
    },
    body: JSON.stringify({
      threadId: "thread_timeout",
      runId: "run_timeout",
      messages: [{ role: "user", content: "A bounded request." }],
      tools: [],
    }),
  });
}

test("Hermes bridge returns a generic timeout when a profile does not finish", async () => {
  const runner: HermesCommandRunner = {
    async run(args) {
      if (args.includes("profile")) {
        return { exitCode: 0, stdout: "profile exists", stderr: "" };
      }
      await Bun.sleep(50);
      return {
        exitCode: 0,
        stdout: "late output must not escape",
        stderr: "upstream details must not escape",
      };
    },
  };
  const bridge = createHermesBridge(
    {
      authToken: "bridge-test-token",
      cliPath: "hermes",
      roster: [{ id: "profile-allowed", displayName: "Configured Local Profile" }],
      maxInputChars: 2_000,
      maxOutputChars: 500,
      timeoutMs: 5,
      maxConcurrent: 1,
    },
    runner,
  );
  expect((await bridge.ready()).ok).toBe(true);

  const response = await bridge.handle(bridgeRequest());
  expect(response.status).toBe(504);
  expect(await response.json()).toEqual({ error: "Hermes request timed out." });
});

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
      threadId: "thread_redaction",
      runId: "run_redaction",
      messages: [{ role: "user", content: "Return a useful result." }],
      tools: [],
    }),
  });
}

test("Hermes bridge redacts credential-shaped output and session metadata", async () => {
  const runner: HermesCommandRunner = {
    async run(args) {
      if (args.includes("profile")) {
        return { exitCode: 0, stdout: "profile exists", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout:
          "Useful local result.\nBearer sk-live-secret-value\nSession ID: raw-session-id\n" +
          "x".repeat(500),
        stderr: "stderr payload must never be returned",
      };
    },
  };
  const bridge = createHermesBridge(
    {
      authToken: "bridge-test-token",
      cliPath: "hermes",
      roster: [{ id: "profile-allowed", displayName: "Configured Local Profile" }],
      maxInputChars: 2_000,
      maxOutputChars: 120,
      timeoutMs: 1_500,
      maxConcurrent: 1,
    },
    runner,
  );
  expect((await bridge.ready()).ok).toBe(true);

  const response = await bridge.handle(bridgeRequest());
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).not.toContain("sk-live-secret-value");
  expect(body).not.toContain("raw-session-id");
  expect(body).not.toContain("stderr payload must never be returned");
  expect(body).toContain("Useful local result.");
  expect(body.length).toBeLessThan(1_000);
});

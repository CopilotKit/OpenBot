import { expect, test } from "bun:test";
import { startHermesBridge } from "../src/server";
import type { HermesCommandRunner } from "../src/bridge";

function body() {
  return JSON.stringify({
    threadId: "thread_server",
    runId: "run_server",
    messages: [{ role: "user", content: "Return the server contract result." }],
    tools: [],
  });
}

test("Hermes bridge server exposes only the ready allowlisted AG-UI route", async () => {
  const runner: HermesCommandRunner = {
    async run(args) {
      if (args.includes("profile")) {
        return { exitCode: 0, stdout: "profile exists", stderr: "" };
      }
      return { exitCode: 0, stdout: "OPENBOT_HERMES_SERVER_OK", stderr: "" };
    },
  };
  const bridgeServer = await startHermesBridge(
    {
      authToken: "bridge-test-token",
      cliPath: "hermes",
      roster: [{ id: "profile-allowed", displayName: "Configured Local Profile" }],
      host: "127.0.0.1",
      port: 0,
      maxInputChars: 2_000,
      maxOutputChars: 500,
      timeoutMs: 1_500,
      maxConcurrent: 1,
    },
    runner,
  );

  try {
    expect(bridgeServer.server.hostname).toBe("127.0.0.1");
    const response = await fetch(
      `http://127.0.0.1:${bridgeServer.server.port}/ag-ui/profile-allowed`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-agent-token": "bridge-test-token",
        },
        body: body(),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("OPENBOT_HERMES_SERVER_OK");
  } finally {
    bridgeServer.server.stop(true);
  }
});

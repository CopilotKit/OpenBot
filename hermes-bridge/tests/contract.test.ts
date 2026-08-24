import { expect, test } from "bun:test";
import {
  createHermesBridge,
  type HermesCommandRunner,
  type HermesProfileRosterEntry,
} from "../src/bridge";

type RecordedCall = {
  args: string[];
  prompt: string;
  timeoutMs: number;
};

function request(path: string, body: unknown, token?: string): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-openbot-agent-token": token } : {}),
    },
    body: JSON.stringify(body),
  });
}

function decodeEvents(body: string): Record<string, unknown>[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
}

test("bounded Hermes AG-UI bridge verifies its roster and serves one allowlisted profile", async () => {
  const calls: RecordedCall[] = [];
  const roster: HermesProfileRosterEntry[] = [
    { id: "profile-allowed", displayName: "Configured Local Profile" },
  ];
  const runner: HermesCommandRunner = {
    async run(args, prompt, timeoutMs) {
      calls.push({ args, prompt, timeoutMs });
      if (args.includes("profile")) {
        return { exitCode: 0, stdout: "profile exists\n", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: "OPENBOT_HERMES_BRIDGE_OK\nSession: raw-session-id-must-not-escape\n",
        stderr: "",
      };
    },
  };
  const bridge = createHermesBridge(
    {
      authToken: "bridge-test-token",
      cliPath: "hermes",
      roster,
      maxInputChars: 2_000,
      maxOutputChars: 500,
      timeoutMs: 1_500,
      maxConcurrent: 1,
    },
    runner,
  );

  expect(await bridge.ready()).toEqual({ ok: true, profiles: ["profile-allowed"] });
  expect(calls[0]?.args).toEqual([
    "-p",
    "profile-allowed",
    "profile",
    "show",
    "profile-allowed",
  ]);

  const unauthorized = await bridge.handle(
    request("/ag-ui/profile-allowed", {
      threadId: "thread_unauthorized",
      runId: "run_unauthorized",
      messages: [{ role: "user", content: "should not run" }],
    }),
  );
  expect(unauthorized.status).toBe(401);
  expect(calls).toHaveLength(1);

  const response = await bridge.handle(
    request(
      "/ag-ui/profile-allowed",
      {
        threadId: "thread_bridge",
        runId: "run_bridge",
        messages: [{ role: "user", content: "Return the local bridge smoke result." }],
        tools: [],
        forwardedProps: {
          hermesProfileId: "not-allowed-from-request",
          payload: "must-not-be-forwarded",
        },
      },
      "bridge-test-token",
    ),
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const events = decodeEvents(await response.text());
  expect(events.map((event) => event.type)).toEqual([
    "RUN_STARTED",
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "RUN_FINISHED",
  ]);
  expect(events.find((event) => event.type === "TEXT_MESSAGE_CONTENT")).toMatchObject({
    delta: "OPENBOT_HERMES_BRIDGE_OK",
  });

  const invocation = calls[1];
  expect(invocation?.args).toEqual([
    "-p",
    "profile-allowed",
    "chat",
    "--toolsets",
    "safe",
    "--quiet",
    "--query-file",
    "-",
    "--safe-mode",
    "--source",
    "tool",
    "--max-turns",
    "1",
  ]);
  expect(invocation?.prompt).toContain("Return the local bridge smoke result.");
  expect(invocation?.prompt).not.toContain("not-allowed-from-request");
  expect(invocation?.prompt).not.toContain("must-not-be-forwarded");
  expect(invocation?.timeoutMs).toBe(1_500);

  const responseText = JSON.stringify(events);
  expect(responseText).not.toContain("raw-session-id-must-not-escape");
  expect(responseText).not.toContain("bridge-test-token");
});

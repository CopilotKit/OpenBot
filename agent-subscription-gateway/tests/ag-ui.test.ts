import { describe, expect, test } from "bun:test";
import type {
  AgentDriver,
  DriverEvent,
  DriverRun,
  DriverRunContext,
} from "../src/drivers/agent-driver";
import { createGatewayHandler } from "../src/server/app";

function request(
  token = "worker-secret",
  overrides: Record<string, unknown> = {},
  signal?: AbortSignal,
) {
  return new Request("http://gateway.test/ag-ui", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openbot-agent-token": token,
    },
    body: JSON.stringify({
      threadId: "thread-1",
      runId: "run-1",
      messages: [{ id: "message-1", role: "user", content: "Change it." }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
      ...overrides,
    }),
    signal,
  });
}

function events(response: Response) {
  return response.text().then((body) =>
    body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map(
        (line) =>
          JSON.parse(line.slice("data: ".length)) as Record<string, unknown>,
      ),
  );
}

class FakeDriver implements AgentDriver {
  readonly provider = "fake";
  readonly version = "1.2.3";
  starts: DriverRun[] = [];
  cancels: string[] = [];
  output: DriverEvent[] = [
    { type: "activity", message: "Reading files", data: { phase: "inspect" } },
    { type: "text", delta: "Done." },
  ];
  failure: unknown;

  async isAuthReady() {
    return true;
  }

  async *start(run: DriverRun, _context: DriverRunContext) {
    this.starts.push(run);
    if (this.failure) throw this.failure;
    for (const event of this.output) yield event;
  }

  async *resume(run: DriverRun, context: DriverRunContext) {
    yield* this.start(run, context);
  }

  async cancel(runId: string) {
    this.cancels.push(runId);
  }
}

describe("the AG-UI gateway", () => {
  test("streams a native run in AG-UI order without tool-call events", async () => {
    const driver = new FakeDriver();
    const handle = createGatewayHandler({ token: "worker-secret", driver });

    const response = await handle(request());
    const sent = await events(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(sent.map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "CUSTOM",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(sent[1]).toMatchObject({
      name: "subscription_agent_activity",
      value: {
        provider: "fake",
        message: "Reading files",
        data: { phase: "inspect" },
      },
    });
    expect(sent.map((event) => String(event.type))).not.toContain(
      "TOOL_CALL_START",
    );
    expect(driver.starts).toHaveLength(1);
    expect(driver.starts[0]).toMatchObject({
      runId: "run-1",
      threadId: "thread-1",
    });
  });

  test("turns a driver failure into one safe terminal error", async () => {
    const driver = new FakeDriver();
    driver.failure = new Error(
      "provider failed with PRIVATE_PROVIDER_VALUE from /auth/secret.json",
    );
    const handle = createGatewayHandler({ token: "worker-secret", driver });

    const sent = await events(await handle(request()));

    expect(sent.map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "RUN_ERROR",
    ]);
    expect(sent[1]).toEqual({
      type: "RUN_ERROR",
      message: "The provider run failed.",
    });
    expect(JSON.stringify(sent)).not.toContain("PRIVATE_PROVIDER_VALUE");
    expect(JSON.stringify(sent)).not.toContain("secret.json");
  });

  test("rejects OpenBot tool grants before native work starts", async () => {
    const driver = new FakeDriver();
    const handle = createGatewayHandler({ token: "worker-secret", driver });

    const response = await handle(
      request("worker-secret", {
        tools: [
          {
            name: "computer_click",
            description: "Click a control",
            parameters: { type: "object" },
          },
        ],
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "OpenBot tool grants are not accepted by subscription workers.",
    });
    expect(driver.starts).toHaveLength(0);
  });

  test("cancels the driver once and emits one terminal event", async () => {
    const driver = new FakeDriver();
    driver.start = async function* (run: DriverRun, context: DriverRunContext) {
      this.starts.push(run);
      yield { type: "activity", message: "Working" };
      await new Promise<void>((resolve) => {
        context.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
    };
    const handle = createGatewayHandler({ token: "worker-secret", driver });
    const controller = new AbortController();
    const response = await handle(
      request("worker-secret", {}, controller.signal),
    );

    controller.abort();
    const sent = await events(response);

    expect(driver.cancels).toEqual(["run-1"]);
    expect(sent.filter((event) => event.type === "RUN_ERROR")).toEqual([
      { type: "RUN_ERROR", message: "The run was cancelled." },
    ]);
    expect(sent.some((event) => event.type === "RUN_FINISHED")).toBe(false);
  });
});

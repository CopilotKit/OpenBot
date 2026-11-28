import { describe, expect, test } from "bun:test";
import { getResponse } from "msw";
import { extraHandlers } from "./extraHandlers";

const ORIGIN = "http://127.0.0.1:3021";

describe("extraHandlers", () => {
  test("/info lists the agents that agents() gives at request time", async () => {
    let agents: string[] = ["general-assistant"];
    const handlers = extraHandlers({ agents: () => agents });
    const info = () =>
      getResponse(handlers, new Request(`${ORIGIN}/api/copilotkit/info`));

    const first = await info();
    expect(first?.status).toBe(200);
    expect(await first?.json()).toEqual({
      version: "workbench",
      agents: { "general-assistant": { description: "", capabilities: {} } },
      mode: "sse",
      telemetryDisabled: true,
    });

    agents = ["away-bot", "research-bot"];
    const second = await info();
    const body = (await second?.json()) as { agents: Record<string, unknown> };
    expect(Object.keys(body.agents)).toEqual(["away-bot", "research-bot"]);
  });

  test("get-session answers a made-up session", async () => {
    const handlers = extraHandlers({ agents: () => [] });
    const response = await getResponse(
      handlers,
      new Request(`${ORIGIN}/api/auth/get-session`),
    );
    const body = (await response?.json()) as {
      session: { userId: string };
      user: { id: string; email: string };
    };
    expect(body.user.email).toBe("sam@example.com");
    expect(body.session.userId).toBe(body.user.id);
  });

  test("sign-out answers success", async () => {
    const handlers = extraHandlers({ agents: () => [] });
    const response = await getResponse(
      handlers,
      new Request(`${ORIGIN}/api/auth/sign-out`, { method: "POST" }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ success: true });
  });

  test("an unrelated path gives undefined", async () => {
    const handlers = extraHandlers({ agents: () => [] });
    const response = await getResponse(
      handlers,
      new Request(`${ORIGIN}/api/v2/organizations/default/bots`),
    );
    expect(response).toBeUndefined();
  });
});

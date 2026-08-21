import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AGUIMock } from "@copilotkit/aimock/agui";
import { testAgentConnection } from "../src/agents/connection-test";

/**
 * The connection test, against something that really speaks AG-UI.
 *
 * Uses a real AG-UI mock rather than a stubbed fetch. The other tests for this hand it a function that returns a hand-written
 * SSE body, which proves the parsing and nothing about the protocol: every one of them would still
 * pass if AG-UI changed its wire format underneath us, or if we had misread it in the first place.
 * The whole promise is that somebody else's agent works if it speaks this protocol, so the
 * test that matters is one where an implementation we did not write answers.
 *
 * `@copilotkit/aimock` is ours, which is the point: it is the org's deterministic backend for
 * exactly this, it tracks the protocol as the protocol moves, and using it here means OpenBot finds
 * out about a drift in the same week as everything else that depends on it rather than in a
 * customer's integration.
 *
 * Deterministic and offline. No key, no network, no spend, and the same answer on every run, so
 * this belongs in CI, which is where an agent-facing contract most needs watching.
 */

describe("registering an agent that really answers", () => {
  const mock = new AGUIMock();
  let url = "";

  beforeAll(async () => {
    // The events a well-behaved agent sends for a trivial run: it starts, says something, finishes.
    mock.onRun(/.*/, [
      { type: "RUN_STARTED", threadId: "t", runId: "r" },
      { type: "TEXT_MESSAGE_START", messageId: "m", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "ready" },
      { type: "TEXT_MESSAGE_END", messageId: "m" },
      { type: "RUN_FINISHED", threadId: "t", runId: "r" },
    ] as never);
    url = await mock.start();
  });

  afterAll(async () => {
    await mock.stop?.();
  });

  test("an agent speaking real AG-UI is reported as working, with what it sent", async () => {
    const result = await testAgentConnection(url, { allowPrivateHosts: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The events are shown to the person registering it, so that they can see it really answered
    // rather than being told it did.
    expect(result.events).toContain("RUN_STARTED");
    expect(result.events).toContain("RUN_FINISHED");
  });

  test("the address is still checked before anything is dialled", async () => {
    // Same guard as registration: the button must not become a way to probe the internal network,
    // and a live server on the other end does not change that.
    const result = await testAgentConnection("http://169.254.169.254/", {
      allowPrivateHosts: true,
    });
    expect(result.ok).toBe(false);
  });

  test("a port with nothing on it reports the direction of the connection", async () => {
    // The server dials the agent, so localhost must be tested from the server side.
    const dead = await testAgentConnection("http://127.0.0.1:9/", {
      allowPrivateHosts: true,
      timeoutMs: 2_000,
    });
    expect(dead.ok).toBe(false);
    if (!dead.ok) {
      expect(dead.reason).toMatch(/reachable from|did not answer/);
    }
  });
});

/**
 * The shapes a real agent turns up in, beyond the happy one.
 *
 * The connection test is what somebody sees when they register a colleague's agent, and the verdict
 * decides whether they go looking at their own service or at ours. A stubbed SSE body proves we parse
 * the string we wrote; these put a real AG-UI implementation on the other end and make it misbehave
 * in the ways a real one does.
 */
describe("registering an agent that answers badly", () => {
  test("an agent that starts a run and never finishes is still reported as working", async () => {
    /*
     * A run that produces events is a working endpoint. Whether the agent finishes its work is the
     * agent's business and not something a registration check should refuse over: the alternative is
     * a person unable to register a slow agent, told their perfectly good service is broken.
     */
    const partial = new AGUIMock();
    partial.onRun(/.*/, [
      { type: "RUN_STARTED", threadId: "t", runId: "r" },
      { type: "TEXT_MESSAGE_START", messageId: "m", role: "assistant" },
    ] as never);
    const partialUrl = await partial.start();

    try {
      const result = await testAgentConnection(partialUrl, {
        allowPrivateHosts: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.events).toContain("RUN_STARTED");
    } finally {
      await partial.stop?.();
    }
  });

  test("an agent that reports its own error still counts as speaking the protocol", async () => {
    // `RUN_ERROR` is the agent telling us something went wrong, which means it is there and it
    // speaks AG-UI. Refusing registration here would send somebody to debug the wrong end.
    const failing = new AGUIMock();
    failing.onRun(/.*/, [
      { type: "RUN_STARTED", threadId: "t", runId: "r" },
      { type: "RUN_ERROR", message: "the model is unavailable" },
    ] as never);
    const failingUrl = await failing.start();

    try {
      const result = await testAgentConnection(failingUrl, {
        allowPrivateHosts: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.events).toContain("RUN_ERROR");
    } finally {
      await failing.stop?.();
    }
  });

  test("a tool call in the stream is reported, because that is what a governed Bot does", async () => {
    /*
     * The event that matters most for this product. A remote Bot yields a tool call and OpenBot
     * decides it, so an endpoint that emits one is exactly the shape the gateway is built for, and
     * somebody registering it should see that it did.
     */
    const calling = new AGUIMock();
    calling.onRun(/.*/, [
      { type: "RUN_STARTED", threadId: "t", runId: "r" },
      {
        type: "TOOL_CALL_START",
        toolCallId: "call_1",
        toolCallName: "search_issues",
      },
      { type: "TOOL_CALL_ARGS", toolCallId: "call_1", delta: '{"q":"x"}' },
      { type: "TOOL_CALL_END", toolCallId: "call_1" },
      { type: "RUN_FINISHED", threadId: "t", runId: "r" },
    ] as never);
    const callingUrl = await calling.start();

    try {
      const result = await testAgentConnection(callingUrl, {
        allowPrivateHosts: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.events).toContain("TOOL_CALL_START");
    } finally {
      await calling.stop?.();
    }
  });

  test("nothing listening is a refusal a person can act on", async () => {
    // The commonest registration mistake: a typo, or a service that is not up yet. It has to read as
    // "we could not reach it" rather than as a protocol complaint.
    const result = await testAgentConnection("http://127.0.0.1:9/ag-ui", {
      allowPrivateHosts: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

import { describe, expect, test } from "bun:test";
import { testAgentConnection } from "../src/agents/connection-test";

/**
 * An agent that answers, then thinks for a long time.
 *
 * This is what an agentic harness does: it opens the stream with `RUN_STARTED` and then goes away
 * to call a model, plan, and run tools, which can take a minute. The opening read stopped at a byte
 * cap or the end of the stream, and neither arrives — so the probe sat on an open socket until the
 * whole request timed out, and the abort surfaced as "The agent started answering and the
 * connection broke."
 *
 * Nothing broke. The agent had already proved what the test exists to prove, in its first event.
 */
describe("an agent that opens its stream and keeps working", () => {
  test("is judged on what it has already sent", async () => {
    const agent = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"RUN_STARTED","threadId":"t","runId":"r"}\n\n',
                ),
              );
              // And then nothing, for longer than any probe should wait. Never closed: a run in
              // progress holds its stream open.
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });

    try {
      const started = Date.now();
      const result = await testAgentConnection(
        `http://127.0.0.1:${agent.port}/`,
        { allowPrivateHosts: true },
      );
      const elapsed = Date.now() - started;

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.events).toContain("RUN_STARTED");
      // The point of the change: it answers from the first event rather than waiting out a run.
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      agent.stop(true);
    }
  });

  test("a stream that proves nothing is still read to the cap", async () => {
    // The guard against stopping too early. Heartbeats and comments are not AG-UI events, so a
    // stream of them must not be accepted as an agent on the strength of having sent bytes.
    const agent = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(": keep-alive\n\n: keep-alive\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
    });

    try {
      const result = await testAgentConnection(
        `http://127.0.0.1:${agent.port}/`,
        { allowPrivateHosts: true },
      );
      expect(result.ok).toBe(false);
    } finally {
      agent.stop(true);
    }
  });
});

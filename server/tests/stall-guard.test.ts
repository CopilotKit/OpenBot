import { describe, expect, test } from "bun:test";
import type { AuditEventInput } from "../src/audit";
import { createStallGuard } from "../src/channels/stall-guard";

/**
 * These drive real streams, because the properties that matter are properties of a stream.
 *
 * The timeouts are tens of milliseconds rather than the two minutes a deployment runs, since the
 * sweep interval is derived from the timeout: a test asserting the rule should not have to wait the
 * length of the rule. Nothing else is faked. The bodies below are `ReadableStream`s and the wrapper
 * under test is the same one an `HttpAgent` is handed.
 */

const BOT = { id: "risk-analyst", name: "Risk Analyst" };

/** A body that arrives and closes, like a Bot that answered. */
function speaks(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

/** A body that is accepted and never written to, like a Bot whose own upstream has hung. */
function saysNothing(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start() {
      // Deliberately empty. The whole point is that nothing ever arrives and nothing ever closes.
    },
  });
}

function sse(body: ReadableStream<Uint8Array>, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

const RUN_REQUEST: RequestInit = {
  method: "POST",
  body: JSON.stringify({ threadId: "thread-7", runId: "run-9" }),
};

function collecting(): {
  store: { insert: (event: AuditEventInput) => Promise<void> };
  rows: AuditEventInput[];
} {
  const rows: AuditEventInput[] = [];
  return {
    rows,
    store: {
      insert: async (event) => {
        rows.push(event);
      },
    },
  };
}

describe("a Bot that stops streaming", () => {
  test("is told to the person in the stream they are already reading, and the stream ends", async () => {
    const audit = collecting();
    const guard = createStallGuard({ stallMs: 60, auditStore: audit.store });
    const watched = guard.watch(BOT, async () => sse(saysNothing()));

    const response = await watched("http://bot.internal/ag-ui", RUN_REQUEST);
    // Reading to the end returns only because the guard closed it. A stream nobody ends never does.
    const body = await new Response(response.body).text();
    guard.stop();

    expect(body).toContain('"RUN_ERROR"');
    expect(body).toContain("Risk Analyst stopped responding");
    expect(body).toContain("AGENT_STREAM_STALLED");
    // The framing has to be one an AG-UI client parses, which is a `data:` line and a blank line.
    expect(body.startsWith("data: ")).toBe(true);
    expect(body.endsWith("\n\n")).toBe(true);
  });

  test("leaves a row naming the Bot, the turn and how long the silence was", async () => {
    const audit = collecting();
    const guard = createStallGuard({ stallMs: 60, auditStore: audit.store });
    const watched = guard.watch(BOT, async () => sse(saysNothing()));

    const response = await watched("http://bot.internal/ag-ui", RUN_REQUEST);
    await new Response(response.body).text();
    guard.stop();

    const row = audit.rows.find(
      (event) => event.eventType === "agent.stream_stalled",
    );
    expect(row).toBeDefined();
    expect(row?.targetId).toBe("risk-analyst");
    expect(row?.payload.bot).toBe("risk-analyst");
    expect(row?.payload.thread).toBe("thread-7");
    expect(row?.payload.run).toBe("run-9");
    expect(row?.payload.chunks).toBe(0);
    expect(Number(row?.payload.silentForMs)).toBeGreaterThanOrEqual(60);
  });
});

describe("the sentence a person is left with", () => {
  test("survives the packaged chat's banner, which truncates on its own punctuation", async () => {
    const guard = createStallGuard({ stallMs: 60 });
    const watched = guard.watch(BOT, async () => sse(saysNothing()));

    const response = await watched("http://bot.internal/ag-ui", RUN_REQUEST);
    const body = await new Response(response.body).text();
    guard.stop();

    const message = String(
      (JSON.parse(body.slice("data: ".length)) as { message: unknown }).message,
    );
    // The banner cuts a message at the first " - ", strips a trailing three-digit number and takes
    // anything after "See more:" away with it. A sentence containing any of those reaches a person
    // cut in half, so the wording avoids all three rather than relying on nobody noticing.
    expect(message).not.toContain(" - ");
    expect(message).not.toContain("See more:");
    expect(message).not.toMatch(/:\s*\d{3}$/);
    // Said in words a person reads, not in the milliseconds a deployment configured, and never as
    // "0 seconds": the timeout here is a test's, and a floor keeps the sentence sane at any value.
    expect(message).toContain("for a second");
  });
});

describe("a Bot that is answering", () => {
  test("has its bytes passed through untouched and nothing added", async () => {
    const audit = collecting();
    const guard = createStallGuard({ stallMs: 5_000, auditStore: audit.store });
    const frames = [
      'data: {"type":"RUN_STARTED"}\n\n',
      'data: {"type":"TEXT_MESSAGE_CHUNK","delta":"hello"}\n\n',
      'data: {"type":"RUN_FINISHED"}\n\n',
    ];
    const watched = guard.watch(BOT, async () => sse(speaks(frames)));

    const response = await watched("http://bot.internal/ag-ui", RUN_REQUEST);
    const body = await new Response(response.body).text();
    guard.stop();

    expect(body).toBe(frames.join(""));
    expect(audit.rows).toHaveLength(0);
  });

  test("keeps the status and the content type the parser chooses on", async () => {
    const guard = createStallGuard({ stallMs: 5_000 });
    const watched = guard.watch(BOT, async () => sse(speaks(["data: {}\n\n"])));

    const response = await watched("http://bot.internal/ag-ui", RUN_REQUEST);
    await new Response(response.body).text();
    guard.stop();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
  });
});

describe("what the watch refuses to touch", () => {
  test("a refusal passes straight through, body and all", async () => {
    const audit = collecting();
    const guard = createStallGuard({ stallMs: 60, auditStore: audit.store });
    const refusal = new Response("no", { status: 502 });
    const watched = guard.watch(BOT, async () => refusal);

    const response = await watched("http://bot.internal/ag-ui", RUN_REQUEST);
    guard.stop();

    expect(response).toBe(refusal);
    expect(await response.text()).toBe("no");
    expect(audit.rows).toHaveLength(0);
  });

  test("a framing it does not recognise is closed rather than written into", async () => {
    const audit = collecting();
    const guard = createStallGuard({ stallMs: 60, auditStore: audit.store });
    const watched = guard.watch(
      BOT,
      async () =>
        new Response(saysNothing(), {
          headers: { "content-type": "application/vnd.ag-ui.event+proto" },
        }),
    );

    const response = await watched("http://bot.internal/ag-ui", RUN_REQUEST);
    const body = await new Response(response.body).arrayBuffer();
    guard.stop();

    // Nothing written in: SSE bytes in a binary stream would corrupt a run that was merely slow.
    expect(body.byteLength).toBe(0);
    expect(
      audit.rows.some((event) => event.eventType === "agent.stream_stalled"),
    ).toBe(true);
  });
});

describe("a deployment with no timeout configured", () => {
  test("gets the fetch it handed in, unwrapped", () => {
    const guard = createStallGuard({ stallMs: 0 });
    const inner = async () => sse(speaks([]));
    expect(guard.watch(BOT, inner)).toBe(inner);
    guard.stop();
  });

  test("and its streams are never ended for it", async () => {
    const audit = collecting();
    const guard = createStallGuard({ stallMs: 0, auditStore: audit.store });
    const watched = guard.watch(BOT, async () => sse(speaks(["data: {}\n\n"])));

    const response = await watched("http://bot.internal/ag-ui", RUN_REQUEST);
    expect(await new Response(response.body).text()).toBe("data: {}\n\n");
    expect(audit.rows).toHaveLength(0);
    guard.stop();
  });
});

import { expect, test } from "bun:test";
import { getResponse } from "msw";
import { createAgentStreams } from "./agentStream";

const ORIGIN = "http://127.0.0.1:3021";

function request(agent: string, mode: "run" | "connect"): Request {
  return new Request(`${ORIGIN}/api/copilotkit/agent/${agent}/${mode}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: "t1", runId: "r1" }),
  });
}

async function open(
  streams: ReturnType<typeof createAgentStreams>,
  agent: string,
  mode: "run" | "connect" = "run",
) {
  const response = await getResponse(streams.handlers, request(agent, mode));
  if (!response?.body) throw new Error("No stream");
  return { response, reader: response.body.getReader() };
}

const decoder = new TextDecoder();

async function readEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
): Promise<unknown[]> {
  let text = "";
  while (text.split("\n\n").length - 1 < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text
    .split("\n\n")
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => JSON.parse(chunk.replace(/^data: /, "")));
}

test("the run answer is an event stream", async () => {
  const streams = createAgentStreams();
  const { response } = await open(streams, "away-bot");
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(response.headers.get("cache-control")).toBe("no-cache");
  expect(streams.streams()).toEqual([
    {
      id: 1,
      agent: "away-bot",
      path: "/api/copilotkit/agent/away-bot/run",
      open: true,
      sent: 0,
    },
  ]);
});

test("events pushed before and after the stream opens arrive in order", async () => {
  const streams = createAgentStreams();
  streams.push("away-bot", [{ type: "RUN_STARTED", runId: "r1" }]);
  streams.push("other-bot", [{ type: "RUN_STARTED", runId: "x" }]);
  const { reader } = await open(streams, "away-bot");
  streams.push("away-bot", [
    { type: "TEXT_MESSAGE_START", messageId: "m1" },
    { type: "RUN_FINISHED", runId: "r1" },
  ]);
  expect(await readEvents(reader, 3)).toEqual([
    { type: "RUN_STARTED", runId: "r1" },
    { type: "TEXT_MESSAGE_START", messageId: "m1" },
    { type: "RUN_FINISHED", runId: "r1" },
  ]);
  expect(streams.streams()[0]?.sent).toBe(3);
  // The other agent's event still waits.
  const other = await open(streams, "other-bot", "connect");
  expect(await readEvents(other.reader, 1)).toEqual([
    { type: "RUN_STARTED", runId: "x" },
  ]);
});

test('"*" reaches every open stream', async () => {
  const streams = createAgentStreams();
  const a = await open(streams, "away-bot");
  const b = await open(streams, "other-bot", "connect");
  streams.push("*", [{ type: "CUSTOM", name: "ping" }]);
  expect(await readEvents(a.reader, 1)).toEqual([
    { type: "CUSTOM", name: "ping" },
  ]);
  expect(await readEvents(b.reader, 1)).toEqual([
    { type: "CUSTOM", name: "ping" },
  ]);
  expect(streams.streams().map((s) => s.sent)).toEqual([1, 1]);
});

test("end closes the stream, and the reader is done", async () => {
  const streams = createAgentStreams();
  let changes = 0;
  streams.onChange(() => {
    changes += 1;
  });
  const { reader } = await open(streams, "away-bot");
  streams.push("away-bot", [{ type: "RUN_FINISHED", runId: "r1" }]);
  streams.end("away-bot");
  expect(await readEvents(reader, 1)).toHaveLength(1);
  expect((await reader.read()).done).toBe(true);
  expect(streams.streams()[0]).toMatchObject({ open: false, sent: 1 });
  expect(changes).toBe(3);
});

test("end with no open stream closes the next stream after its queue", async () => {
  const streams = createAgentStreams();
  streams.push("away-bot", [{ type: "RUN_FINISHED", runId: "r1" }]);
  streams.end("away-bot");
  const { reader } = await open(streams, "away-bot");
  expect(await readEvents(reader, 1)).toEqual([
    { type: "RUN_FINISHED", runId: "r1" },
  ]);
  expect((await reader.read()).done).toBe(true);
  expect(streams.streams()[0]?.open).toBe(false);
  // The end was used once: the stream after it stays open.
  await open(streams, "away-bot");
  expect(streams.streams()[1]?.open).toBe(true);
});

test("a consumer cancel marks the stream closed", async () => {
  const streams = createAgentStreams();
  const { reader } = await open(streams, "away-bot");
  await reader.cancel();
  expect(streams.streams()[0]?.open).toBe(false);
  // A push now queues for the next stream.
  streams.push("away-bot", [{ type: "RUN_STARTED", runId: "r2" }]);
  const next = await open(streams, "away-bot");
  expect(await readEvents(next.reader, 1)).toEqual([
    { type: "RUN_STARTED", runId: "r2" },
  ]);
});

test("an encoded agent id is decoded", async () => {
  const streams = createAgentStreams();
  await open(streams, "my%20bot");
  expect(streams.streams()[0]?.agent).toBe("my bot");
});

import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { VoiceSessionRecord } from "../../shared/voice-session";
import {
  loadVoiceArchive,
  saveVoiceSession,
  voiceArchiveContext,
  voiceSessionInput,
  withVoiceChats,
} from "../src/lib/voice/archive";
import { queryClient } from "../src/query-client";

afterEach(() => {
  mock.restore();
  queryClient.clear();
});
function mockFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(handler, { preconnect: globalThis.fetch.preconnect }),
  );
}

const call = (
  id: string,
  anchorMessageId: string | null = null,
): VoiceSessionRecord => ({
  id,
  anchorMessageId,
  channelId: "channel-1",
  startedAt: "2026-09-22T12:00:00.000Z",
  endedAt: "2026-09-22T12:01:00.000Z",
  durationSeconds: 60,
  summary: "Planned tomorrow's recording.",
  summaryStatus: "ready",
  transcript: [{ id: "user", role: "user", text: "Let's record tomorrow." }],
});

test("call cards keep chronological order around delegated messages and missing anchors", () => {
  const messages = [
    { id: "before", role: "user" as const, content: "Before" },
    { id: "delegate", role: "assistant" as const, content: "Tool result" },
  ];
  const result = withVoiceChats(messages, [
    call("first"),
    call("second", "before"),
    call("third", "before"),
    call("fourth", "missing"),
    call("fifth", "missing"),
  ]);
  expect(result.map((message) => message.id)).toEqual([
    "voice-chat:first",
    "before",
    "voice-chat:second",
    "voice-chat:third",
    "delegate",
    "voice-chat:fourth",
    "voice-chat:fifth",
  ]);
});

test("history loading follows pagination and preserves failed-summary transcripts as context", async () => {
  const urls: string[] = [];
  mockFetch(async (input) => {
    urls.push(String(input));
    return Response.json(
      urls.length === 1
        ? { sessions: [call("one")], nextCursor: "next page" }
        : {
            sessions: [
              { ...call("two"), summary: null, summaryStatus: "failed" },
            ],
            nextCursor: null,
          },
    );
  });
  const records = await loadVoiceArchive("channel-1");
  expect(records).toHaveLength(2);
  expect(urls[1]).toContain("cursor=next+page");
  expect(voiceArchiveContext(records)).toContain(
    "user: Let's record tomorrow.",
  );
});

test("a busy summary response retains the server's durable transcript instead of marking it unsaved", async () => {
  mockFetch(async () =>
    Response.json(
      {
        session: { ...call("busy"), summary: null, summaryStatus: "failed" },
        error: "Summary service busy",
      },
      { status: 429 },
    ),
  );
  saveVoiceSession(voiceSessionInput(call("busy")));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const records = await loadVoiceArchive("channel-1");
  expect(records[0]?.saveState).toBeUndefined();
  expect(records[0]?.summaryStatus).toBe("failed");
  expect(records[0]?.saveError).toBe("Summary service busy");
});

test("save failure remains retryable with the same session id and original transcript", async () => {
  const sent: unknown[] = [];
  let fail = true;
  mockFetch(async (_input, init) => {
    if (!init?.method) return Response.json({ sessions: [], nextCursor: null });
    sent.push(JSON.parse(String(init.body)));
    return fail
      ? Response.json({ error: "Database unavailable" }, { status: 503 })
      : Response.json({ session: call("retry") });
  });
  const input = voiceSessionInput(call("retry"));
  saveVoiceSession(input);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((await loadVoiceArchive("channel-1"))[0]?.saveState).toBe("unsaved");
  fail = false;
  saveVoiceSession(input);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((await loadVoiceArchive("channel-1"))[0]?.saveState).toBeUndefined();
  expect(sent).toEqual([input, input]);
});

import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { useVoiceArchive } from "../src/lib/voice/archive";
import { queryClient } from "../src/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * A channel's voice chats are part of its history: the transcript is not shown until they are in,
 * so it never draws the conversation and then splices a call card into it. `pending` is what the
 * channel waits on — and it must end on a failed load too, or the placeholder would stay up for
 * good over a conversation that is perfectly readable without its calls.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

afterEach(() => {
  cleanup();
  mock.restore();
  queryClient.clear();
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function answerFetch(answer: () => Promise<Response>) {
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(answer, { preconnect: globalThis.fetch.preconnect }),
  );
}

test("pending while saved voice chats load", () => {
  answerFetch(() => new Promise<Response>(() => {}));

  const { result } = renderHook(() => useVoiceArchive("channel-1"));

  expect(result.current.pending).toBe(true);
});

test("not pending once loaded", async () => {
  answerFetch(async () =>
    Response.json({ sessions: [], nextCursor: null }, { status: 200 }),
  );

  const { result } = renderHook(() => useVoiceArchive("channel-1"));

  await waitFor(() => expect(result.current.pending).toBe(false));
  expect(result.current.error).toBeNull();
});

test("not pending after a failed load", async () => {
  answerFetch(async () =>
    Response.json({ error: "Down for maintenance." }, { status: 500 }),
  );

  const { result } = renderHook(() => useVoiceArchive("channel-1"));

  await waitFor(() => expect(result.current.pending).toBe(false), {
    timeout: 5000,
  });
  expect(result.current.error).not.toBeNull();
});

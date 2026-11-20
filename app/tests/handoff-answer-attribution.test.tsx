import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { answerMessageId } from "@openbot/shared/handoff-markers";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ConversationView } from "@/components/channels/conversation-view";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * One Bot's answer to another, in the conversation that asked for it.
 *
 * The answer is written into the asking Bot's thread, because a thread has one agent, so nothing
 * but its id says whose words they are. Drawn like every other line in that conversation, it read
 * as the asking Bot saying something new, and the Bot that was asked never appeared under its own
 * name, which is what the Bot's settings promise.
 */

class OfflineWebSocket extends EventTarget {
  readyState = 0;
  onclose = null;
  onerror = null;
  onmessage = null;
  onopen = null;
  close() {}
  send() {}
}

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "not served" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

const ANSWER =
  "I answer questions about company policy and procedures, and I cite the handbook and the wiki.";

test("another Bot's answer is drawn under that Bot's name, and this Bot's own lines are not", async () => {
  queryClient.setQueryData(agentKeys.list(false), [
    { id: "general-assistant", name: "General Assistant", avatarSeed: "ga" },
    { id: "knowledge", name: "Knowledge", avatarSeed: "kn" },
  ] as AgentProfile[]);

  const view = render(
    <QueryClientProvider client={queryClient}>
      <ConversationView
        channelId="c-1"
        messages={[
          { id: "u1", role: "user", content: "Ask Knowledge what it can do." },
          {
            id: "a1",
            role: "assistant",
            content: "I asked Knowledge to describe what it can do.",
          },
          {
            id: answerMessageId("knowledge", "run-1"),
            role: "assistant",
            content: ANSWER,
          },
        ]}
        onSubmit={() => {}}
      />
    </QueryClientProvider>,
  );

  await waitFor(() =>
    expect(
      view.container.querySelector('[data-speaker="knowledge"]')?.textContent,
    ).toContain("Knowledge"),
  );
  const answer = view.container.querySelector('[data-speaker="knowledge"]');
  expect(
    answer?.querySelector('[data-slot="message-header"]')?.textContent,
  ).toBe("Knowledge");
  expect(answer?.textContent).toContain(ANSWER);
  // The asking Bot's own line is its own, unlabelled, as every line of a one-Bot conversation is.
  expect(view.container.querySelectorAll("[data-speaker]")).toHaveLength(1);
});

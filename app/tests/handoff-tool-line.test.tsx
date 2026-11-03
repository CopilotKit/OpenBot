import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { HandoffTool } from "@/lib/copilot/handoff-tool";
import { settleReactWork } from "./settle-react-work";

/**
 * A hand-off to another Bot the person declined reads as their decision, not as a boundary: the
 * server puts "That handoff was not sent:" in front of the decline, and the line reads past it.
 */

const originalFetch = globalThis.fetch;
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "not served" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const DECLINED =
  "The person declined this action when you asked for their approval, so it was not done. This was their decision, not a policy or a boundary.";

function handoff(result: string): Message[] {
  return [
    { id: "u", role: "user", content: "Ask Research" },
    {
      id: "a",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "hop",
          type: "function",
          function: {
            name: "message_bot",
            arguments: JSON.stringify({ bot: "Research", task: "Find it" }),
          },
        },
      ],
    },
    { id: "r", role: "tool", toolCallId: "hop", content: result },
  ];
}

function draw(messages: Message[]) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <CopilotKitProvider>
        <HandoffTool />
        <ChatTranscript messages={messages} />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

test("a declined hand-off reads as declined, never as blocked", async () => {
  const view = draw(
    handoff(JSON.stringify(`That handoff was not sent: ${DECLINED}`)),
  );
  await waitFor(() =>
    expect(view.getByText("You declined: Ask Research")).toBeTruthy(),
  );
  expect(view.queryByText(/Blocked/)).toBeNull();
  // The words written for the Bot about the decision stay out.
  expect(view.queryByText(/This was their decision/)).toBeNull();
});

test("a hand-off a boundary refused still reads as blocked", async () => {
  const view = draw(
    handoff(
      JSON.stringify(
        "That handoff was not sent: Research is not in this workspace.",
      ),
    ),
  );
  await waitFor(() =>
    expect(view.getByText("Blocked: Asked Research")).toBeTruthy(),
  );
});

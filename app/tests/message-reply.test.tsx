import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  splitMessageReplies,
  withMessageReply,
} from "@openbot/shared/message-reply";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConversationView } from "@/components/channels/conversation-view";
import { ReplyingChatView } from "@/components/channels/replying-chat-view";
import { TelemetryAssistantMessage } from "@/components/channels/telemetry-assistant-message";
import { plainWords } from "@/components/channels/transcript-turns";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

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

const answer = {
  id: "specific-answer",
  role: "assistant" as const,
  content: "The first option is the blue design.\nThe second option is green.",
};

test("the hover menu selects a specific reply, sending the full quote and preserving the user's text", async () => {
  const sent: string[] = [];
  const view = render(
    <ConversationView
      messages={[answer]}
      onSubmit={(draft) => {
        sent.push(draft.text);
      }}
    />,
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(view.getByRole("button", { name: "Message actions" }));
  await user.click(await view.findByRole("menuitem", { name: "Reply" }));
  expect(view.getByText("Replying to Bot")).toBeTruthy();
  const editor = view.getByRole("textbox", { name: "Message" });
  await user.type(editor, "Make the second option darker.");
  await user.click(view.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(splitMessageReplies(sent[0]!)).toEqual({
    text: "Make the second option darker.",
    replies: [{ messageId: answer.id, text: answer.content }],
  });
  expect(view.queryByRole("button", { name: "Cancel reply" })).toBeNull();
});

test("right click offers Reply and Copy, and cancelling keeps the draft", async () => {
  const view = render(
    <ConversationView messages={[answer]} onSubmit={() => {}} />,
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  const surface = view.container.querySelector(
    '[data-slot="context-menu-trigger"]',
  )!;
  fireEvent.contextMenu(surface, { button: 2, clientX: 100, clientY: 100 });
  expect(await view.findByRole("menuitem", { name: "Copy" })).toBeTruthy();
  await user.click(view.getByRole("menuitem", { name: "Reply" }));
  const editor = view.getByRole("textbox", { name: "Message" });
  await user.type(editor, "Keep these words");
  await user.click(view.getByRole("button", { name: "Cancel reply" }));
  expect(editor.textContent).toContain("Keep these words");
  expect(view.queryByText("Replying to Bot")).toBeNull();
});

test("direct Bot chat keeps its input mounted and sends reply context through the SDK submit path", async () => {
  const sent: string[] = [];
  const view = render(
    <CopilotKitProvider
      runtimeUrl="http://localhost/api/copilotkit"
      enableInspector={false}
    >
      <ReplyingChatView
        messages={[answer]}
        messageView={{ assistantMessage: TelemetryAssistantMessage }}
        onSubmitMessage={(text) => {
          sent.push(text);
        }}
      />
    </CopilotKitProvider>,
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(view.getByRole("button", { name: "Message actions" }));
  await user.click(await view.findByRole("menuitem", { name: "Reply" }));
  const editor = view.getByRole("textbox");
  await user.type(editor, "Use the green design.");
  expect(view.getByRole("textbox")).toBe(editor);
  await user.click(view.getByRole("button", { name: /send/i }));
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(splitMessageReplies(sent[0]!)).toEqual({
    text: "Use the green design.",
    replies: [{ messageId: answer.id, text: answer.content }],
  });
});

test("channel chat has one toolbar for multiple assistant messages in a turn", async () => {
  const view = render(
    <ConversationView
      messages={[
        answer,
        {
          id: "continuation",
          role: "assistant",
          content: "I recommend green.",
        },
      ]}
      onSubmit={() => {}}
    />,
  );
  expect(view.getAllByRole("button", { name: "Message actions" })).toHaveLength(
    1,
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(view.getByRole("button", { name: "Message actions" }));
  await user.click(await view.findByRole("menuitem", { name: "Reply" }));
  const quote = view.container.querySelector(
    '[data-slot="composer-column"] [data-slot="message-reply"]',
  );
  expect(quote?.textContent).toContain(plainWords(answer.content));
  expect(quote?.textContent).toContain("I recommend green.");
});

test("direct chat has one toolbar after the complete assistant turn", async () => {
  const view = render(
    <CopilotKitProvider
      runtimeUrl="http://localhost/api/copilotkit"
      enableInspector={false}
    >
      <ReplyingChatView
        messages={[
          answer,
          {
            id: "continuation",
            role: "assistant",
            content: "I recommend green.",
          },
        ]}
        messageView={{ assistantMessage: TelemetryAssistantMessage }}
        onSubmitMessage={() => {}}
      />
    </CopilotKitProvider>,
  );
  expect(view.getAllByRole("button", { name: "Message actions" })).toHaveLength(
    1,
  );
  const bar = view.container.querySelector('[data-slot="message-actions"]')!;
  expect(bar.parentElement?.textContent).toContain("I recommend green.");
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(view.getByRole("button", { name: "Message actions" }));
  await user.click(await view.findByRole("menuitem", { name: "Reply" }));
  const quote = view.container.querySelector('[data-slot="message-reply"]');
  expect(quote?.textContent).toContain(plainWords(answer.content));
  expect(quote?.textContent).toContain("I recommend green.");
});

test("clicking the outlined reply opens only its message chain", async () => {
  const view = render(
    <ConversationView
      assistant={{ author: "General Assistant", botId: "general-assistant" }}
      messages={[
        answer,
        {
          id: "sent-reply",
          role: "user",
          content: withMessageReply("Make it darker", {
            messageId: answer.id,
            text: answer.content,
          }),
        },
        {
          id: "chain-answer",
          role: "assistant",
          content: "I've made it darker.",
        },
        { id: "other-question", role: "user", content: "Unrelated topic" },
        { id: "other-answer", role: "assistant", content: "Unrelated answer" },
      ]}
      onSubmit={() => {}}
    />,
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  const preview = view.getByRole("button", { name: "View reply thread" });
  expect(preview.textContent).toContain("General Assistant");
  await user.click(preview);
  const dialog = await view.findByRole("dialog");
  expect(
    within(dialog).getByRole("heading", { name: "Conversation replies" }),
  ).toBeTruthy();
  expect(dialog.textContent).toContain(answer.content);
  expect(within(dialog).getByText("Make it darker")).toBeTruthy();
  expect(within(dialog).getByText("I've made it darker.")).toBeTruthy();
  expect(within(dialog).queryByText("Unrelated answer")).toBeNull();
  const toolbars = within(dialog).getAllByRole("button", {
    name: "Message actions",
  });
  expect(toolbars).toHaveLength(3);
  await user.click(toolbars[2]!);
  await user.click(await view.findByRole("menuitem", { name: "Reply" }));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  expect(
    view.container.querySelector(
      '[data-slot="composer-column"] [data-slot="message-reply"]',
    )?.textContent,
  ).toContain("I've made it darker.");
});

test.each(["channel", "direct"])(
  "%s chat reveals the single turn toolbar when hovering earlier message text",
  async (surface) => {
    const messages = [
      answer,
      {
        id: "last-block",
        role: "assistant" as const,
        content: "I recommend green.",
      },
    ];
    const view = render(
      surface === "channel" ? (
        <ConversationView messages={messages} onSubmit={() => {}} />
      ) : (
        <CopilotKitProvider
          runtimeUrl="http://localhost/api/copilotkit"
          enableInspector={false}
        >
          <ReplyingChatView
            messages={messages}
            messageView={{ assistantMessage: TelemetryAssistantMessage }}
            onSubmitMessage={() => {}}
          />
        </CopilotKitProvider>
      ),
    );
    const user = userEvent.setup({ document: view.container.ownerDocument });
    const toolbar = view.container.querySelector(
      '[data-slot="message-actions"]',
    )!;
    expect(
      view.container.querySelectorAll('[data-slot="message-actions"]'),
    ).toHaveLength(1);
    const earlierText = view.getByText(/The first option is the blue design/);
    await user.hover(earlierText);
    expect(toolbar.getAttribute("data-turn-hovered")).toBe("true");
    await user.unhover(earlierText);
    expect(toolbar.getAttribute("data-turn-hovered")).toBe("false");
    await user.hover(view.getByText("I recommend green."));
    expect(toolbar.getAttribute("data-turn-hovered")).toBe("true");
  },
);

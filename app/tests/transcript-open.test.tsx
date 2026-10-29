import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { settleReactWork } from "./settle-react-work";

/**
 * What a person sees when a conversation opens.
 *
 * History arrives in pieces (the gateway snapshot, then the stored thread merged into it), and the
 * scroller decides where to land exactly once, the first time it sees a row. So the transcript
 * draws nothing but the placeholder until history is complete, and then mounts the scroller with
 * every row at once — the only way its single landing is at the bottom of the whole conversation.
 *
 * Harness as in `transcript-attachments.test.tsx`: one document for the file, cleaned per test.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function user(id: string, text: string): Message {
  return { id, role: "user", content: text };
}

function assistant(id: string, text: string): Message {
  return { id, role: "assistant", content: text };
}

const PLACEHOLDER = "Loading this conversation";

test("restoring hides rows the snapshot already delivered", () => {
  const view = render(
    <ChatTranscript
      messages={[user("u1", "hi"), assistant("a1", "hello")]}
      restoring
    />,
  );

  expect(view.queryByText("hello")).toBeNull();
  expect(view.container.querySelectorAll("[data-message-id]").length).toBe(0);
  expect(view.getByLabelText(PLACEHOLDER)).toBeTruthy();
});

test("rows appear together when restoring ends", () => {
  const messages = [user("u1", "hi"), assistant("a1", "hello")];
  const view = render(<ChatTranscript messages={messages} restoring />);

  view.rerender(<ChatTranscript messages={messages} restoring={false} />);

  expect(view.getByText("hi")).toBeTruthy();
  expect(view.getByText("hello")).toBeTruthy();
  expect(view.container.querySelectorAll("[data-message-id]").length).toBe(2);
  expect(view.queryByLabelText(PLACEHOLDER)).toBeNull();
});

test("a seeded channel shows its first message at once", () => {
  const view = render(
    <ChatTranscript messages={[user("u1", "first")]} restoring={false} />,
  );

  expect(view.getByText("first")).toBeTruthy();
  expect(view.queryByLabelText(PLACEHOLDER)).toBeNull();
});

test("an empty conversation shows neither placeholder nor rows once restored", () => {
  const view = render(<ChatTranscript messages={[]} restoring={false} />);

  expect(view.queryByLabelText(PLACEHOLDER)).toBeNull();
  expect(view.container.querySelectorAll("[data-message-id]").length).toBe(0);
});

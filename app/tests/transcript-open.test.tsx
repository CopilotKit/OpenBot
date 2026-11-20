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

/**
 * Only what arrives while the conversation is open animates in. History is already there when it
 * opens; fading it in row by row read as the conversation still loading. motion renders `initial`
 * as inline style on the first paint, so a row that animates starts at `opacity: 0`.
 */
function startsHidden(element: Element): boolean {
  return /opacity:\s*0(?![.\d])/.test(element.getAttribute("style") ?? "");
}

function arriving(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('[data-slot="message-arriving"]')];
}

test("history rows do not animate in", () => {
  const view = render(
    <ChatTranscript
      messages={[
        user("u1", "one"),
        assistant("a1", "two"),
        user("u2", "three"),
      ]}
      restoring={false}
    />,
  );

  const rows = arriving(view.container);
  expect(rows.length).toBe(3);
  expect(rows.filter(startsHidden).length).toBe(0);
});

test("a live row animates in", () => {
  const history = [user("u1", "one"), assistant("a1", "two")];
  const view = render(<ChatTranscript messages={history} restoring={false} />);

  view.rerender(
    <ChatTranscript
      messages={[...history, user("u2", "new")]}
      restoring={false}
    />,
  );

  const rows = arriving(view.container);
  expect(rows.length).toBe(3);
  expect(rows.map(startsHidden)).toEqual([false, false, true]);
});

test("switching channels does not animate the new history", () => {
  const view = render(
    <ChatTranscript messages={[user("u1", "one")]} restoring={false} />,
  );

  view.rerender(<ChatTranscript messages={[]} restoring />);
  view.rerender(
    <ChatTranscript
      messages={[user("b1", "elsewhere"), assistant("b2", "reply")]}
      restoring={false}
    />,
  );

  const rows = arriving(view.container);
  expect(rows.length).toBe(2);
  expect(rows.filter(startsHidden).length).toBe(0);
});

test("a message typed while history loads is shown under the placeholder", () => {
  const view = render(
    <ChatTranscript
      messages={[]}
      queued={[
        { id: "q1", text: "typed early", attachments: [], commandIds: [] },
      ]}
      restoring
    />,
  );

  expect(view.getByLabelText(PLACEHOLDER)).toBeTruthy();
  expect(view.getByText("typed early")).toBeTruthy();
});

/**
 * Opening a conversation renders its newest rows in with a short stagger. It runs after the view
 * has landed at the bottom, so it reads as the conversation appearing rather than loading: only
 * the rows on screen take part, top of the screen first, newest last.
 */
function openingDelays(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll("[data-message-id]")].map((row) =>
    row.classList.contains("history-arrive")
      ? (row as HTMLElement).style.getPropertyValue("--arrive-delay")
      : null,
  );
}

test("the newest history rows render in, staggered toward the newest", () => {
  const messages = Array.from({ length: 10 }, (_, index) =>
    index % 2 === 0
      ? user(`u${index}`, `question ${index}`)
      : assistant(`a${index}`, `answer ${index}`),
  );
  const view = render(<ChatTranscript messages={messages} restoring={false} />);

  expect(openingDelays(view.container)).toEqual([
    null,
    null,
    "0ms",
    "30ms",
    "60ms",
    "90ms",
    "120ms",
    "150ms",
    "180ms",
    "210ms",
  ]);
});

test("a row that arrives after opening does not take the opening stagger", () => {
  const history = [user("u1", "one"), assistant("a1", "two")];
  const view = render(<ChatTranscript messages={history} restoring={false} />);

  view.rerender(
    <ChatTranscript
      messages={[...history, user("u2", "new")]}
      restoring={false}
    />,
  );

  expect(openingDelays(view.container)).toEqual(["0ms", "30ms", null]);
});

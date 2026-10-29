import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { settleReactWork } from "./settle-react-work";

/**
 * The transcript follows a streaming reply until the person moves up the page or selects some of
 * it, and picks it up again when they send. `data-following` on the viewport is what the scroller
 * was told (`autoScroll`).
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

afterEach(() => {
  document.getSelection()?.removeAllRanges();
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

const HISTORY = [user("u1", "first question"), assistant("a1", "first answer")];

function viewport(container: HTMLElement): HTMLElement {
  return container.querySelector(
    '[data-slot="message-scroller-viewport"]',
  ) as HTMLElement;
}

function following(container: HTMLElement): string | null {
  return viewport(container).getAttribute("data-following");
}

function select(node: Node) {
  act(() => {
    document.getSelection()?.selectAllChildren(node);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

function clearSelection() {
  act(() => {
    document.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  });
}

test("follows by default", () => {
  const view = render(<ChatTranscript messages={HISTORY} restoring={false} />);

  expect(following(view.container)).toBe("true");
});

test("an upward wheel stops following", () => {
  const view = render(<ChatTranscript messages={HISTORY} restoring={false} />);

  fireEvent.wheel(viewport(view.container), { deltaY: -100 });

  expect(following(view.container)).toBe("false");
});

test("a selection outside the transcript does not pause", () => {
  const view = render(
    <>
      <p>outside the transcript</p>
      <ChatTranscript messages={HISTORY} restoring={false} />
    </>,
  );

  select(view.getByText("outside the transcript"));

  expect(following(view.container)).toBe("true");
});

test("selecting transcript text pauses and clearing it resumes", () => {
  const view = render(<ChatTranscript messages={HISTORY} restoring={false} />);

  select(view.getByText("first answer"));
  expect(following(view.container)).toBe("false");

  clearSelection();
  expect(following(view.container)).toBe("true");
});

test("sending a message resumes following", () => {
  const view = render(<ChatTranscript messages={HISTORY} restoring={false} />);
  fireEvent.wheel(viewport(view.container), { deltaY: -100 });

  view.rerender(
    <ChatTranscript
      messages={[...HISTORY, user("u2", "another question")]}
      restoring={false}
    />,
  );

  expect(following(view.container)).toBe("true");
});

test("switching channels follows again", () => {
  const view = render(<ChatTranscript messages={HISTORY} restoring={false} />);
  fireEvent.wheel(viewport(view.container), { deltaY: -100 });

  view.rerender(<ChatTranscript messages={[]} restoring />);
  view.rerender(<ChatTranscript messages={HISTORY} restoring={false} />);

  expect(following(view.container)).toBe("true");
});

test("the scroll button stays mounted", () => {
  const view = render(<ChatTranscript messages={HISTORY} restoring={false} />);

  const button = view.container.querySelector(
    '[data-slot="message-scroller-button"]',
  );
  expect(button).toBeTruthy();
  expect(button?.getAttribute("data-active")).toBe("false");
});

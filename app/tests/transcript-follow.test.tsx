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

/*
 * Keys typed into a field inside the transcript (a form in an app card) move a caret, not the
 * page. Pausing on them left somebody at the very end of a conversation not following it, with no
 * way back short of the button.
 */
test("arrow keys in a field inside the transcript do not pause", () => {
  const view = render(<ChatTranscript messages={HISTORY} restoring={false} />);
  const input = document.createElement("input");
  view.getByText("first answer").appendChild(input);

  fireEvent.keyDown(input, { key: "ArrowUp" });
  fireEvent.keyDown(input, { key: " ", shiftKey: true });

  expect(following(view.container)).toBe("true");
});

test("scroll keys on the transcript itself pause", () => {
  const view = render(<ChatTranscript messages={HISTORY} restoring={false} />);

  fireEvent.keyDown(viewport(view.container), { key: "PageUp" });

  expect(following(view.container)).toBe("false");
});

/*
 * Only a press on the scrollbar makes an upward scroll the person's. A finger or mouse resting on a
 * message while the content shrinks and clamps the view upward is a layout correction.
 */
test("a press on a message does not make a layout clamp a scrollbar drag", () => {
  const view = render(<ChatTranscript messages={HISTORY} restoring={false} />);
  const element = viewport(view.container);
  let top = 500;
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => top,
  });

  fireEvent.scroll(element);
  fireEvent.pointerDown(view.getByText("first answer"));
  top = 400;
  fireEvent.scroll(element);

  expect(following(view.container)).toBe("true");
});

/*
 * An overlay scrollbar (macOS with a trackpad) takes no width, and a right-to-left one sits on the
 * left, so a press on the thumb lands inside the content box. It is still a press on the viewport
 * itself, not on a message in it.
 */
test("dragging an overlay scrollbar up pauses", () => {
  const view = render(<ChatTranscript messages={HISTORY} restoring={false} />);
  const element = viewport(view.container);
  let top = 500;
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => top,
  });
  Object.defineProperty(element, "clientWidth", {
    configurable: true,
    get: () => 900,
  });

  fireEvent.scroll(element);
  fireEvent.pointerDown(element, { clientX: 890 });
  top = 400;
  fireEvent.scroll(element);

  expect(following(view.container)).toBe("false");
});

/*
 * A routine's channel can hold nothing the person sent: only firings and what the Bot said. Their
 * first message there is still a send, though there was no earlier one to compare it with.
 */
test("the first message a person sends picks following up again", () => {
  const before = [assistant("a0", "the daily digest")];
  const view = render(<ChatTranscript messages={before} restoring={false} />);
  fireEvent.wheel(viewport(view.container), { deltaY: -100 });
  expect(following(view.container)).toBe("false");

  view.rerender(
    <ChatTranscript
      messages={[...before, user("u1", "what changed?")]}
      restoring={false}
    />,
  );

  expect(following(view.container)).toBe("true");
});

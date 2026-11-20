import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
} from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import {
  earlierFrom,
  openingFrom,
  shouldDrawEarlier,
  useTranscriptPages,
} from "@/components/channels/transcript-pages";
import { settleReactWork } from "./settle-react-work";

/**
 * A conversation opens with only its newest rows drawn, and draws older ones above as the reader
 * scrolls up. Older rows go BEFORE the always-present `contents` block so that adding them moves the
 * scroller's first child, which is the scroller's own "rows were prepended, hold the reader's place"
 * path; rows that arrive live still land after it, where the scroller looks for a turn to anchor.
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

/* Alternating turns, ids m0…m(n-1), each with its own text. */
function conversation(count: number, prefix = "m"): Message[] {
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0
      ? user(`${prefix}${index}`, `${prefix} text ${index}`)
      : assistant(`${prefix}${index}`, `${prefix} text ${index}`),
  );
}

function startsHidden(element: Element): boolean {
  return /opacity:\s*0(?![.\d])/.test(element.getAttribute("style") ?? "");
}

function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-message-id]")];
}

function content(container: HTMLElement): HTMLElement {
  return container.querySelector(
    '[data-slot="message-scroller-content"]',
  ) as HTMLElement;
}

function viewport(container: HTMLElement): HTMLElement {
  return container.querySelector(
    '[data-slot="message-scroller-viewport"]',
  ) as HTMLElement;
}

/*
 * happy-dom lays nothing out, so the reader's position is stated rather than measured: near the top
 * until a page is drawn above, then as far down as that page pushed them, which is what the
 * scroller's prepend path does in a browser.
 */
function scrollNearTop(container: HTMLElement) {
  const element = viewport(container);
  const opened = rows(container).length;
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: 5000,
  });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => (rows(container).length > opened ? 3000 : 100),
  });
  fireEvent.scroll(element);
}

function childIndex(container: HTMLElement, element: Element): number {
  return [...content(container).children].indexOf(element);
}

function contentsBlock(container: HTMLElement): Element {
  return content(container).querySelector(":scope > .contents") as Element;
}

test("page arithmetic", () => {
  expect(openingFrom(50)).toBe(30);
  expect(openingFrom(12)).toBe(0);
  expect(earlierFrom(30)).toBe(10);
  expect(earlierFrom(10)).toBe(0);
});

test("an older page is drawn only near the top of a measured view", () => {
  expect(
    shouldDrawEarlier({ from: 30, scrollTop: 100, scrollHeight: 5000 }),
  ).toBe(true);
  expect(
    shouldDrawEarlier({ from: 0, scrollTop: 100, scrollHeight: 5000 }),
  ).toBe(false);
  expect(
    shouldDrawEarlier({ from: 30, scrollTop: 900, scrollHeight: 5000 }),
  ).toBe(false);
  expect(shouldDrawEarlier({ from: 30, scrollTop: 0, scrollHeight: 0 })).toBe(
    false,
  );
});

test("opens with only the newest page drawn", () => {
  const view = render(
    <ChatTranscript messages={conversation(50)} restoring={false} />,
  );

  const drawn = rows(view.container);
  expect(drawn.length).toBe(20);
  expect(drawn.at(-1)?.dataset.messageId).toBe("m49");
});

test("scrolling near the top draws the previous page above", () => {
  const view = render(
    <ChatTranscript messages={conversation(50)} restoring={false} />,
  );
  const before = view.container.querySelector('[data-message-id="m30"]');

  scrollNearTop(view.container);

  const drawn = rows(view.container);
  expect(drawn.length).toBe(40);
  expect(drawn[0]?.dataset.messageId).toBe("m10");
  expect(view.container.querySelector('[data-message-id="m30"]')).toBe(before);
  const block = contentsBlock(view.container);
  const older = drawn.filter(
    (row) => Number(row.dataset.messageId?.slice(1)) < 30,
  );
  expect(older.length).toBe(20);
  for (const row of older) {
    expect(childIndex(view.container, row)).toBeLessThan(
      childIndex(view.container, block),
    );
  }
});

test("older rows drawn later do not animate in", () => {
  const view = render(
    <ChatTranscript messages={conversation(50)} restoring={false} />,
  );

  scrollNearTop(view.container);

  for (let index = 10; index < 30; index++) {
    const row = view.container.querySelector(`[data-message-id="m${index}"]`);
    const arriving = row?.querySelector('[data-slot="message-arriving"]');
    expect(arriving).toBeTruthy();
    expect(startsHidden(arriving as Element)).toBe(false);
    expect(row?.classList.contains("history-arrive")).toBe(false);
  }
});

test("a row that arrives after older pages are drawn lands after the contents block", () => {
  const messages = conversation(50);
  const view = render(<ChatTranscript messages={messages} restoring={false} />);
  scrollNearTop(view.container);

  view.rerender(
    <ChatTranscript
      messages={[...messages, user("m50", "a new question")]}
      restoring={false}
    />,
  );

  const row = view.container.querySelector('[data-message-id="m50"]');
  const children = [...content(view.container).children];
  const spacer = children.findIndex((child) =>
    child.hasAttribute("data-message-scroller-spacer"),
  );
  expect(childIndex(view.container, row as Element)).toBeGreaterThan(
    childIndex(view.container, contentsBlock(view.container)),
  );
  expect(childIndex(view.container, row as Element)).toBe(spacer - 1);
});

test("switching channels draws the newest page again", () => {
  const view = render(
    <ChatTranscript messages={conversation(50)} restoring={false} />,
  );
  scrollNearTop(view.container);
  expect(rows(view.container).length).toBe(40);

  view.rerender(<ChatTranscript messages={[]} restoring />);
  view.rerender(
    <ChatTranscript messages={conversation(50, "n")} restoring={false} />,
  );

  const drawn = rows(view.container);
  expect(drawn.length).toBe(20);
  expect(drawn[0]?.dataset.messageId).toBe("n30");
});

test("a conversation shorter than a page draws everything with nothing before the contents block", () => {
  const view = render(
    <ChatTranscript messages={conversation(5)} restoring={false} />,
  );

  expect(rows(view.container).length).toBe(5);
  expect(content(view.container).children[0]).toBe(
    contentsBlock(view.container),
  );
});

/*
 * At the very top the browser has nothing to anchor against, so `scrollTop` stays 0 until the
 * scroller puts the reader back, which it does after the commit. Checking again inside that commit
 * read 0 every time and drew the whole history in one burst (and past ~50 pages, crashed React).
 */
test("one trigger at the very top draws one page, not the whole history", () => {
  const view = render(
    <ChatTranscript messages={conversation(100)} restoring={false} />,
  );
  const element = viewport(view.container);
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: 5000,
  });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    value: 0,
    writable: true,
  });

  fireEvent.scroll(element);

  expect(rows(view.container).length).toBe(40);
});

/* A jump from the rail to a turn several pages up draws everything down to it, in one go. */
test("drawing down to a row draws every page from it", () => {
  const { result } = renderHook(({ ids }) => useTranscriptPages(ids, false), {
    initialProps: { ids: rowIds(100) },
  });
  expect(result.current.from).toBe(80);

  act(() => result.current.drawTo(33));
  expect(result.current.from).toBe(33);

  act(() => result.current.drawTo(50));
  expect(result.current.from).toBe(33);
});

function rowIds(count: number, prefix = "r"): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`);
}

/*
 * Rows can be added or removed above the boundary while a conversation is open: history recovered
 * from storage merges in a prefix, tool steps regroup. Held as indices, the boundary then sat on a
 * different row, and rows crossed it into the live region, where they remounted and replayed their
 * entrance. Held as rows, it stays where it was.
 */
test("rows added above keep the boundary and the first drawn row where they were", () => {
  const { result, rerender } = renderHook(
    ({ ids }) => useTranscriptPages(ids, false),
    { initialProps: { ids: rowIds(100) } },
  );
  expect(result.current).toMatchObject({ from: 80, split: 80 });

  rerender({ ids: [...rowIds(5, "recovered"), ...rowIds(100)] });
  expect(result.current).toMatchObject({ from: 85, split: 85 });

  act(() => result.current.drawEarlier());
  expect(result.current.from).toBe(65);

  rerender({ ids: rowIds(100).filter((id) => id !== "r3") });
  expect(result.current).toMatchObject({ from: 59, split: 79 });
});

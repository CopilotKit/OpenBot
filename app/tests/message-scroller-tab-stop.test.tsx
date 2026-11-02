import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

function renderViewport(tabIndex?: number) {
  return render(
    <MessageScrollerProvider>
      <MessageScroller>
        <MessageScrollerViewport tabIndex={tabIndex}>
          <MessageScrollerContent />
        </MessageScrollerViewport>
      </MessageScroller>
    </MessageScrollerProvider>,
  );
}

test("a transcript with nothing to scroll is not a tab stop", () => {
  const view = renderViewport();
  expect(view.getByRole("region", { name: "Messages" }).tabIndex).toBe(-1);
});

test("a caller's own tabIndex still wins", () => {
  const view = renderViewport(0);
  expect(view.getByRole("region", { name: "Messages" }).tabIndex).toBe(0);
});

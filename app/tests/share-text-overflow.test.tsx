import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ShareText } from "../src/components/approvals/share-details";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("Show all appears for share text that grows after the first render", () => {
  const prototypes = [Element.prototype, HTMLElement.prototype];
  const saved = prototypes.map((prototype) => ({
    prototype,
    scroll: Object.getOwnPropertyDescriptor(prototype, "scrollHeight"),
    client: Object.getOwnPropertyDescriptor(prototype, "clientHeight"),
  }));
  let tall = false;
  for (const prototype of prototypes) {
    Object.defineProperty(prototype, "scrollHeight", {
      configurable: true,
      get: () => (tall ? 400 : 100),
    });
    Object.defineProperty(prototype, "clientHeight", {
      configurable: true,
      get: () => 160,
    });
  }
  try {
    const view = render(<ShareText text="short answer" />);
    expect(view.queryByRole("button", { name: "Show all" })).toBeNull();
    tall = true;
    view.rerender(
      <ShareText text="an answer that grew much longer than before" />,
    );
    expect(view.getByRole("button", { name: "Show all" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Show all" })!);
    expect(view.getByRole("button", { name: "Show less" })).toBeTruthy();
  } finally {
    for (const { prototype, scroll, client } of saved) {
      if (scroll) Object.defineProperty(prototype, "scrollHeight", scroll);
      else delete (prototype as { scrollHeight?: number }).scrollHeight;
      if (client) Object.defineProperty(prototype, "clientHeight", client);
      else delete (prototype as { clientHeight?: number }).clientHeight;
    }
  }
});

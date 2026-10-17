import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";

/**
 * The glob that inlines the vendored SVGs is Vite's, and `bun test` has no Vite. Mocked the same
 * way `desktop/src/App.test.tsx` mocks its own, so the behaviour this file cares about — what a
 * brand with no mark draws — is tested rather than the bundler.
 */
mock.module("@/lib/marks", () => ({
  markFor: (id: string | null | undefined) =>
    id === "langgraph" ? "data:image/svg+xml,<svg/>" : null,
}));

const { HarnessMark } = await import("@/components/agents/harness-mark");

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

test("draws the vendored mark for a brand that has one", () => {
  const { container } = render(<HarnessMark id="langgraph" name="LangGraph" />);
  const img = container.querySelector("img");
  expect(img?.getAttribute("src")).toBe("data:image/svg+xml,<svg/>");
});

/*
 * The rule from shared/marks/README.md: three brands have no mark in any maintained set, and
 * nothing is drawn to fill the gap. A monogram we drew would read as the vendor's own, which is the
 * thing a trade mark holder actually objects to.
 */
test("draws no image at all for a brand with no usable mark", () => {
  const { container } = render(<HarnessMark id={null} name="Agno" />);
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toBe("");
});

/*
 * Empty space is not an invented mark. Four of the twelve rows have no mark, and with the box
 * collapsed their names began a tile's width to the left of the others, which read as a ragged
 * list rather than as four brands without artwork.
 */
test("still holds the tile's width, so unmarked rows line up with marked ones", () => {
  const marked = render(<HarnessMark id="langgraph" name="LangGraph" />);
  const tile = marked.container.firstElementChild?.className;
  cleanup();
  const bare = render(<HarnessMark id={null} name="Agno" />);
  expect(bare.container.firstElementChild?.className).toBe(tile);
});

test("never announces the brand twice, because the name is drawn beside it", () => {
  const { container } = render(<HarnessMark id="langgraph" name="LangGraph" />);
  expect(container.querySelector("img")?.getAttribute("aria-hidden")).toBe(
    "true",
  );
  expect(container.querySelector("img")?.getAttribute("alt")).toBe("");
});

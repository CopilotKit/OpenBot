import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { SPLIT_STEP, Splitter, type SplitterProps } from "./Splitter";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

function props(over: Partial<SplitterProps> = {}): SplitterProps {
  return {
    axis: "x",
    label: "Scene column width",
    size: () => 248,
    min: 180,
    max: 420,
    grow: 1,
    onSize: mock(),
    onReset: mock(),
    value: 248,
    ...over,
  };
}

test("a splitter is a focusable separator with its label and range", () => {
  const view = render(<Splitter {...props()} />);
  const handle = view.getByRole("separator", { name: "Scene column width" });
  expect(handle.getAttribute("tabindex")).toBe("0");
  expect(handle.getAttribute("aria-orientation")).toBe("vertical");
  expect(handle.getAttribute("aria-valuenow")).toBe("248");
  expect(handle.getAttribute("aria-valuemin")).toBe("180");
  expect(handle.getAttribute("aria-valuemax")).toBe("420");
});

test("a splitter takes its colors from the app's tokens", () => {
  const view = render(<Splitter {...props({ axis: "y", value: null })} />);
  const handle = view.getByRole("separator");
  expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
  const classes = handle.className.split(/\s+/);
  for (const name of [
    "bg-border",
    "hover:bg-ring/40",
    "focus-visible:ring-2",
    "focus-visible:ring-ring",
  ])
    expect(classes).toContain(name);
  expect(classes.some((name) => name.startsWith("wb-split"))).toBe(false);
});

test("the arrow keys, Home, End and Enter size the panel", () => {
  const onSize = mock();
  const onReset = mock();
  const view = render(<Splitter {...props({ onSize, onReset, grow: -1 })} />);
  const handle = view.getByRole("separator");
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(onSize).toHaveBeenLastCalledWith(248 - SPLIT_STEP);
  fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
  expect(onSize).toHaveBeenLastCalledWith(248 + SPLIT_STEP * 4);
  fireEvent.keyDown(handle, { key: "Home" });
  expect(onSize).toHaveBeenLastCalledWith(180);
  fireEvent.keyDown(handle, { key: "End" });
  expect(onSize).toHaveBeenLastCalledWith(420);
  fireEvent.keyDown(handle, { key: "Enter" });
  expect(onReset).toHaveBeenCalledTimes(1);
  fireEvent.doubleClick(handle);
  expect(onReset).toHaveBeenCalledTimes(2);
});

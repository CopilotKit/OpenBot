import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { CommentLayer, popoverPlace } from "./CommentLayer";
import type { Box } from "./geometry";
import { DEFAULT_WINDOW } from "./urlState";

beforeAll(() =>
  GlobalRegistrator.register({
    settings: { navigation: { disableChildPageNavigation: true } },
  }),
);
afterAll(() => GlobalRegistrator.unregister());

let frame: HTMLIFrameElement;
let writeText: ReturnType<typeof mock>;

function place(element: Element, box: Box) {
  element.getBoundingClientRect = () =>
    ({
      ...box,
      top: box.y,
      left: box.x,
      right: box.x + box.width,
      bottom: box.y + box.height,
      toJSON: () => box,
    }) as DOMRect;
}

beforeEach(() => {
  frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const doc = frame.contentDocument as Document;
  doc.body.innerHTML = `
    <span class="pill">Step 1 of 4</span>
    <button>Continue</button>`;
  place(doc.body, { x: 0, y: 0, width: 1000, height: 800 });
  place(doc.querySelector(".pill") as Element, {
    x: 16,
    y: 48,
    width: 80,
    height: 20,
  });
  place(doc.querySelector("button") as Element, {
    x: 16,
    y: 80,
    width: 100,
    height: 32,
  });
  writeText = mock(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  frame.remove();
  window.localStorage.clear();
});

function edit(el: HTMLElement, value: string) {
  fireEvent.focusIn(el);
  fireEvent.change(el, { target: { value } });
  fireEvent.keyUp(el);
}

function pointer(type: string, target: Element, x: number, y: number) {
  const win = frame.contentWindow as unknown as typeof globalThis;
  const event = new win.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function show() {
  return render(
    <CommentLayer
      frame={frame}
      scene={{ id: "install-mac", title: "Install on a Mac" }}
      atSeconds={90}
      window={DEFAULT_WINDOW}
    />,
  );
}

test("a click picks the element, does not reach the window, and Copy puts the prompt on the clipboard", async () => {
  const view = show();
  const doc = frame.contentDocument as Document;
  const pill = doc.querySelector(".pill") as Element;
  const clicked = mock(() => {});
  doc.body.addEventListener("click", clicked);

  pointer("pointerdown", pill, 20, 50);
  pointer("pointerup", pill, 20, 50);
  const click = new (
    frame.contentWindow as unknown as typeof globalThis
  ).MouseEvent("click", { bubbles: true, cancelable: true });
  pill.dispatchEvent(click);
  expect(clicked).not.toHaveBeenCalled();
  expect(click.defaultPrevented).toBe(true);

  const box = await view.findByRole("dialog", { name: "Comment" });
  expect(box.textContent).toContain('span "Step 1 of 4"');
  const text = view.getByLabelText("What do you want to change?");
  edit(text, "This needs to be centered");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Copy as prompt" }));
  });

  expect(writeText).toHaveBeenCalledTimes(1);
  const prompt = String(writeText.mock.calls[0]?.[0]);
  expect(prompt).toContain("> This needs to be centered");
  expect(prompt).toContain('Label: `span "Step 1 of 4"`');
  expect(prompt).toContain("Install on a Mac (`install-mac`)");
  expect(prompt).toContain("Time: 1:30");
  expect(view.getByRole("status").textContent).toBe("Copied.");
});

test("a drag picks the elements in the area", async () => {
  const view = show();
  const doc = frame.contentDocument as Document;
  pointer("pointerdown", doc.body, 8, 40);
  pointer("pointermove", doc.body, 60, 80);
  pointer("pointermove", doc.body, 130, 120);
  pointer("pointerup", doc.body, 130, 120);

  const box = await view.findByRole("dialog", { name: "Comment" });
  expect(box.textContent).toContain("Area with 2 elements");
  edit(
    view.getByLabelText("What do you want to change?"),
    "Why is this area so dense?",
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Copy as prompt" }));
  });
  const prompt = String(writeText.mock.calls[0]?.[0]);
  expect(prompt).toContain("## Area");
  expect(prompt).toContain("Elements in the area: 2");
});

test("Escape and Cancel close the box", async () => {
  const view = show();
  const doc = frame.contentDocument as Document;
  const pill = doc.querySelector(".pill") as Element;
  pointer("pointerdown", pill, 20, 50);
  pointer("pointerup", pill, 20, 50);
  const text = await view.findByLabelText("What do you want to change?");
  fireEvent.keyDown(text, { key: "Escape" });
  expect(view.queryByRole("dialog")).toBeNull();

  pointer("pointerdown", pill, 20, 50);
  pointer("pointerup", pill, 20, 50);
  fireEvent.click(await view.findByRole("button", { name: "Cancel" }));
  expect(view.queryByRole("dialog")).toBeNull();
});

test("the box stays inside the window", () => {
  const bounds = { width: 1000, height: 800 };
  const size = { width: 288, height: 180 };
  // Room on the right.
  expect(
    popoverPlace({ x: 10, y: 10, width: 50, height: 20 }, size, bounds),
  ).toEqual({ x: 68, y: 10 });
  // No room on the right: on the left.
  expect(
    popoverPlace({ x: 900, y: 700, width: 80, height: 20 }, size, bounds),
  ).toEqual({ x: 604, y: 612 });
  // As wide as the window: under it, or over it near the bottom.
  expect(
    popoverPlace({ x: 0, y: 0, width: 1000, height: 40 }, size, bounds),
  ).toEqual({ x: 8, y: 48 });
  expect(
    popoverPlace({ x: 0, y: 700, width: 1000, height: 90 }, size, bounds),
  ).toEqual({ x: 8, y: 512 });
});

test("Ask for an impeccable command copies a scoped impeccable prompt, without words too", async () => {
  const view = show();
  const doc = frame.contentDocument as Document;
  const pill = doc.querySelector(".pill") as Element;
  pointer("pointerdown", pill, 20, 50);
  pointer("pointerup", pill, 20, 50);
  await view.findByRole("dialog", { name: "Comment" });
  const copy = view.getByRole("button", { name: "Copy as prompt" });
  expect(copy.hasAttribute("disabled")).toBe(true);
  edit(view.getByLabelText("Ask for"), "typeset");
  // An impeccable prompt needs no words: the button works at once.
  expect(view.getByLabelText("Anything to add? (optional)")).not.toBeNull();
  expect(copy.hasAttribute("disabled")).toBe(false);
  await act(async () => {
    fireEvent.click(copy);
  });
  const prompt = String(writeText.mock.calls[0]?.[0]);
  expect(prompt.startsWith("/impeccable typeset ")).toBe(true);
  expect(prompt).toContain(
    'Review only this part of the frame: the element "span',
  );
  expect(prompt).toContain("workbench:shot install-mac --at 90");
  // The choice is kept for the next comment.
  expect(window.localStorage.getItem("workbench.commentAsk")).toBe('"typeset"');
});

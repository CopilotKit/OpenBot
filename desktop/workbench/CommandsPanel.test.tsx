import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { type Answer, nativeControl } from "../src/fakeNative/control";
import { CommandsPanel } from "./CommandsPanel";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

function type(element: HTMLElement, value: string) {
  fireEvent.focusIn(element);
  fireEvent.change(element, { target: { value } });
  fireEvent.keyUp(element);
}

test("Apply sets the answer, and a bad edit keeps the last good one", () => {
  const control = nativeControl();
  control.reset();
  const onAnswer = mock();
  const view = render(<CommandsPanel control={control} onAnswer={onAnswer} />);
  const area = view.getByLabelText("Answer for default_root");
  type(area, '"/x"');
  fireEvent.click(view.getByLabelText("Apply default_root"));
  const good: Answer = { mode: "value", value: "/x" };
  expect(control.answers().get("default_root")).toEqual(good);
  expect(onAnswer).toHaveBeenCalledWith("default_root", good);

  type(area, "{bad");
  fireEvent.click(view.getByLabelText("Apply default_root"));
  expect(view.getByRole("alert").textContent).toContain("not valid");
  expect(control.answers().get("default_root")).toEqual(good);
});

test("an outside answer change updates the editor until the person edits", () => {
  const control = nativeControl();
  control.reset();
  const view = render(<CommandsPanel control={control} onAnswer={mock()} />);
  const area = view.getByLabelText(
    "Answer for default_root",
  ) as HTMLTextAreaElement;
  act(() => control.setAnswer("default_root", { mode: "value", value: "/y" }));
  expect(area.value).toBe('"/y"');

  type(area, '"/mine"');
  act(() => control.setAnswer("default_root", { mode: "value", value: "/z" }));
  expect(area.value).toBe('"/mine"');
});

test("a problem without said shows an error", () => {
  const control = nativeControl();
  control.reset();
  const view = render(<CommandsPanel control={control} onAnswer={mock()} />);
  const select = view.getByLabelText("Mode for default_root");
  fireEvent.focusIn(select);
  fireEvent.change(select, { target: { value: "fail" } });
  type(view.getByLabelText("Answer for default_root"), "{}");
  fireEvent.click(view.getByLabelText("Apply default_root"));
  expect(view.getByText("A problem needs a said text.")).not.toBeNull();
  expect(control.answers().has("default_root")).toBe(false);
});

test("search filters the commands", () => {
  const control = nativeControl();
  control.reset();
  const view = render(<CommandsPanel control={control} onAnswer={mock()} />);
  type(view.getByLabelText("Search commands"), "local_eval");
  const rows = Array.from(
    view.container.querySelectorAll("details[data-command]"),
  );
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.getAttribute("data-command")).toContain("local_eval");
  }
});

test("with no control the Apply buttons are disabled", () => {
  const view = render(<CommandsPanel control={null} onAnswer={mock()} />);
  const buttons = Array.from(
    view.container.querySelectorAll<HTMLButtonElement>("button"),
  );
  expect(buttons.length).toBeGreaterThan(0);
  expect(buttons.every((b) => b.disabled)).toBe(true);
});

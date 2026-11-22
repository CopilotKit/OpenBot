import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { nativeControl } from "../src/fakeNative/control";
import { listen } from "../src/fakeNative/event";
import { EventsPanel } from "./EventsPanel";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

function edit(el: HTMLElement, value: string) {
  fireEvent.focusIn(el);
  fireEvent.change(el, { target: { value } });
  fireEvent.keyUp(el);
}

test("Send emits the edited payload", async () => {
  const control = nativeControl();
  control.reset();
  const seen = mock();
  await listen("status:refresh", (e) => seen(e.payload));
  const view = render(<EventsPanel control={control} />);
  edit(view.getByLabelText("Event"), "status:refresh");
  edit(view.getByLabelText("Payload (JSON)"), '{"a":1}');
  fireEvent.click(view.getByText("Send"));
  expect(seen).toHaveBeenCalledWith({ a: 1 });
});

test("bad JSON shows an error and does not emit", async () => {
  const control = nativeControl();
  control.reset();
  const seen = mock();
  await listen("status:refresh", (e) => seen(e.payload));
  const view = render(<EventsPanel control={control} />);
  edit(view.getByLabelText("Event"), "status:refresh");
  edit(view.getByLabelText("Payload (JSON)"), "{nope");
  fireEvent.click(view.getByText("Send"));
  expect(view.getByRole("alert").textContent).toContain(
    "The payload is not valid JSON: ",
  );
  expect(seen).not.toHaveBeenCalled();
});

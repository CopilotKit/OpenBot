import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

/** Opens the Event list and picks the event with that name. */
async function pickEvent(view: ReturnType<typeof render>, name: string) {
  const person = userEvent.setup({ document });
  await person.click(view.getByRole("combobox", { name: "Event" }));
  await person.click(
    await within(document.body).findByRole("option", { name }),
  );
}

test("Send emits the edited payload", async () => {
  const control = nativeControl();
  control.reset();
  const seen = mock();
  await listen("status:refresh", (e) => seen(e.payload));
  const view = render(<EventsPanel control={control} />);
  await pickEvent(view, "status:refresh");
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
  await pickEvent(view, "status:refresh");
  edit(view.getByLabelText("Payload (JSON)"), "{nope");
  fireEvent.click(view.getByText("Send"));
  expect(view.getByRole("alert").textContent).toContain(
    "The payload is not valid JSON: ",
  );
  expect(seen).not.toHaveBeenCalled();
});

test("picking an event puts its default payload in the editor", async () => {
  const control = nativeControl();
  control.reset();
  const view = render(<EventsPanel control={control} />);
  const payload = view.getByLabelText("Payload (JSON)") as HTMLTextAreaElement;
  expect(payload.value).toContain('"step":"engine"');
  await pickEvent(view, "setup:downloads");
  expect(payload.value).toContain('"state":"downloading"');
  await pickEvent(view, "status:refresh");
  expect(payload.value).toBe("null");
});

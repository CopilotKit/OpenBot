import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Slider } from "@/components/ui/slider";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("the slider's thumb has its label and moves with the arrow keys", async () => {
  const moved = mock((_: number | readonly number[]) => {});
  const view = render(
    <Slider
      min={0}
      max={10}
      value={[4]}
      onValueChange={moved}
      thumbLabel="Time"
    />,
  );
  const thumb = view.getByRole("slider", { name: "Time" });
  expect(thumb.getAttribute("aria-valuenow")).toBe("4");
  const person = userEvent.setup({ document });
  thumb.focus();
  await person.keyboard("{ArrowRight}");
  const value = moved.mock.calls[0]?.[0];
  expect(Array.isArray(value) ? value[0] : value).toBe(5);
});

test("the collapsible's trigger opens and closes its content", async () => {
  const view = render(
    <Collapsible>
      <CollapsibleTrigger>Requests</CollapsibleTrigger>
      <CollapsibleContent>Every request</CollapsibleContent>
    </Collapsible>,
  );
  const trigger = view.getByRole("button", { name: "Requests" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(view.queryByText("Every request")).toBeNull();
  const person = userEvent.setup({ document });
  await person.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(view.getByText("Every request")).toBeDefined();
  await person.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

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

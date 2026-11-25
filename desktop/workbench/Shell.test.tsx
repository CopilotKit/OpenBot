import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toaster } from "@/components/ui/toast";
import { Fold, NoticeList, tell } from "./Shell";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("a fold opens and closes from its full-width trigger, and keeps its content mounted", async () => {
  const view = render(
    <Fold title="Calls">
      <p>No calls yet.</p>
    </Fold>,
  );
  const trigger = view.getByRole("button", { name: "Calls" });
  expect(trigger.getAttribute("data-slot")).toBe("collapsible-trigger");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(trigger.className).toContain("w-full");
  // The chevron is drawn by the app's icon set, not by CSS.
  expect(trigger.querySelector("svg")).not.toBeNull();
  // Closed, as a closed <details>: in the page, but hidden.
  const content = view.getByText("No calls yet.", { selector: "p" });
  expect(content.closest("[hidden]")).not.toBeNull();

  const user = userEvent.setup({ document });
  await user.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(trigger.hasAttribute("data-panel-open")).toBe(true);
  expect(content.closest("[hidden]")).toBeNull();

  await user.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

test("a fold the page opens itself shows its content", () => {
  const onOpenChange = mock();
  const view = render(
    <Fold title="API answers" open onOpenChange={onOpenChange}>
      <p>Answers</p>
    </Fold>,
  );
  expect(
    view
      .getByRole("button", { name: "API answers" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(view.getByText("Answers").closest("[hidden]")).toBeNull();
});

test("a notice is an outlined app Item with an icon and a Close button", async () => {
  const onClose = mock();
  const view = render(
    <NoticeList
      notices={["The window did not start in 10 seconds.", "Second."]}
      onClose={onClose}
    />,
  );
  const notices = view.getAllByRole("status");
  expect(notices).toHaveLength(2);
  const first = notices[0] as HTMLElement;
  expect(first.getAttribute("data-slot")).toBe("item");
  expect(first.className).toContain("border-border");
  expect(first.querySelector("svg")).not.toBeNull();
  expect(
    within(first).getByText("The window did not start in 10 seconds."),
  ).toBeDefined();
  await userEvent
    .setup({ document })
    .click(
      within(notices[1] as HTMLElement).getByRole("button", { name: "Close" }),
    );
  expect(onClose).toHaveBeenCalledWith(1);
});

test("a short message shows as the app's toast", async () => {
  const view = render(<Toaster />);
  act(() => tell("Copied."));
  expect(await within(document.body).findByText("Copied.")).toBeDefined();
  act(() => tell("The workbench cannot write to the clipboard.", "error"));
  expect(
    await within(document.body).findByText(
      "The workbench cannot write to the clipboard.",
    ),
  ).toBeDefined();
  view.unmount();
});

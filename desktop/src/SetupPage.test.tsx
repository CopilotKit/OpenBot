import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { SetupPage } from "./SetupPage";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("standalone setup keeps its heading and action outside the content scroller", () => {
  const view = render(
    <SetupPage
      heading="Restart Windows to finish"
      lede="Save your work."
      footer={<button type="button">Restart now</button>}
    >
      <input aria-label="Existing configuration" defaultValue="keep me" />
    </SetupPage>,
  );
  const sheet = view.getByRole("heading").closest(".setup-layout");
  const input = view.getByRole("textbox");
  expect(
    sheet
      ?.querySelector(":scope > .setup-header-block")
      ?.contains(view.getByRole("heading")),
  ).toBe(true);
  expect(sheet?.querySelector(":scope > .setup-body")?.contains(input)).toBe(
    true,
  );
  expect(
    sheet
      ?.querySelector(":scope > .setup-footer")
      ?.contains(view.getByRole("button", { name: "Restart now" })),
  ).toBe(true);
  view.rerender(
    <SetupPage
      heading="Restart Windows to finish"
      lede="Restarting…"
      footer={<button type="button">Restart now</button>}
    >
      <input aria-label="Existing configuration" defaultValue="keep me" />
    </SetupPage>,
  );
  expect(view.getByRole("textbox")).toBe(input);
});

test("a progress sidebar holds the page identity without duplicating it in the operation pane", () => {
  const view = render(
    <SetupPage
      heading="Updating OpenBot"
      rail={
        <aside aria-label="Update progress">
          <h1>Updating OpenBot</h1>
        </aside>
      }
    >
      <p>Downloading the update</p>
    </SetupPage>,
  );
  expect(
    view.getByRole("complementary", { name: "Update progress" }).parentElement,
  ).toBe(view.container.querySelector("main"));
  expect(view.getAllByRole("heading")).toHaveLength(1);
  expect(
    view.container.querySelector(".sheet > .setup-header-block"),
  ).toBeNull();
  expect(
    view.getByText("Downloading the update").closest(".setup-body"),
  ).not.toBeNull();
});

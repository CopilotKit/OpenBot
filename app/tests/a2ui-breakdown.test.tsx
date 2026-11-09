import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import {
  GenerativeUISurface,
  useGenerativeUIRuntime,
} from "@copilotkit/react-core/v2/generative-ui";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { SERIES_COLOURS } from "@/components/gallery/palette";
import { generativeUiProviderOptions, OPENBOT_UI } from "@/lib/copilot/a2ui";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const THREAD = "thread-breakdown";

/**
 * The "Build a trip budget" starter task as a Bot now draws it: a Breakdown bound to a list of parts
 * in the data model, and a Text reading one of those parts back, to show edits land in the model.
 */
function TripBudget() {
  const runtime = useGenerativeUIRuntime();
  useEffect(() => {
    if (!runtime) return;
    runtime.manager.setActiveThread(THREAD);
    runtime.manager.ingest(THREAD, undefined, {
      surfaceId: "budget",
      target: "budget",
      catalogId: OPENBOT_UI.id,
      status: "ready",
      rejected: [],
      operations: [
        {
          version: "1.0",
          createSurface: {
            surfaceId: "budget",
            catalogId: OPENBOT_UI.id,
            dataModel: {
              items: [
                { label: "Transport", amount: 100 },
                { label: "Lodging", amount: 200 },
                { label: "Food", amount: 80 },
              ],
            },
          },
        },
        {
          version: "1.0",
          updateComponents: {
            surfaceId: "budget",
            components: [
              { id: "root", component: "Card", children: ["split", "echo"] },
              {
                id: "split",
                component: "Breakdown",
                items: { "@path": "/items" },
                currency: "USD",
                max: 500,
              },
              {
                id: "echo",
                component: "Text",
                text: {
                  "@call": "calc",
                  args: {
                    expression: "'Lodging in the model: ' + lodging",
                    lodging: { "@path": "/items/1/amount" },
                  },
                },
              },
            ],
          },
        },
      ],
    });
  }, [runtime]);
  return null;
}

function draw() {
  return render(
    <CopilotKitProvider {...generativeUiProviderOptions(true)}>
      <TripBudget />
      <GenerativeUISurface id="budget" />
    </CopilotKitProvider>,
  );
}

/** The bar's slices, in order: the part each one is, its colour, and how much of the bar it takes. */
function slices(container: HTMLElement) {
  return [
    ...container.querySelectorAll<HTMLElement>(
      '[data-slot="breakdown-bar"] > [data-part]',
    ),
  ].map((slice) => ({
    part: slice.dataset.part,
    colour: slice.style.background,
    grow: Number(slice.style.flexGrow),
  }));
}

/**
 * A part's slider, by the name it is read out with.
 *
 * Found by its attributes, not by role: Base UI keeps a thumb `visibility: hidden` until it has
 * measured the track, and happy-dom lays nothing out, so here the slider never shows and Testing
 * Library will not return it. In a browser it does.
 */
function slider(container: HTMLElement, name: string) {
  const input = container.querySelector<HTMLInputElement>(
    `input[type="range"][aria-label="${name}"]`,
  );
  if (!input) throw new Error(`No slider named ${name}`);
  return input;
}

function total(container: HTMLElement) {
  return container.querySelector('[data-slot="breakdown-total"]')?.textContent;
}

test("editing a part of a budget updates its share of the bar, the total and the data model", async () => {
  const view = draw();
  const lodging = (await view.findByRole("spinbutton", {
    name: "Lodging",
  })) as HTMLInputElement;
  expect(total(view.container)).toBe("$380");

  // One colour per part, from the charts' series colours, in order, on the bar and the swatches.
  expect(slices(view.container)).toEqual([
    { part: "Transport", colour: SERIES_COLOURS[0], grow: 100 },
    { part: "Lodging", colour: SERIES_COLOURS[1], grow: 200 },
    { part: "Food", colour: SERIES_COLOURS[2], grow: 80 },
  ]);
  expect(view.getByText("53%")).toBeTruthy();

  // Type over the amount, as a person does.
  const user = userEvent.setup({ document });
  await user.clear(lodging);
  await user.type(lodging, "250");

  expect(total(view.container)).toBe("$430");
  expect(slices(view.container)[1]).toEqual({
    part: "Lodging",
    colour: SERIES_COLOURS[1],
    grow: 250,
  });
  // 250 of 430, where it was 200 of 380.
  expect(view.getByText("58%")).toBeTruthy();
  expect(view.getByText("Lodging in the model: 250")).toBeTruthy();

  // Its slider moved with it, on the shared scale the Bot set.
  const lodgingSlider = slider(view.container, "Lodging");
  expect(lodgingSlider.getAttribute("aria-valuenow")).toBe("250");
  expect(lodgingSlider.getAttribute("aria-valuetext")).toBe("$250");
});

/** Each part's share as the row shows it, in order: "24%" read as 24. */
function shares(container: HTMLElement) {
  return [...container.querySelectorAll("li")]
    .map((row) =>
      [...row.querySelectorAll("span")].find((span) =>
        /^\d+%$/.test(span.textContent ?? ""),
      ),
    )
    .map((span) => Number(span?.textContent?.replace("%", "")));
}

test("the shares a budget shows always add up to 100%", async () => {
  const view = draw();
  const food = (await view.findByRole("spinbutton", {
    name: "Food",
  })) as HTMLInputElement;

  // Food at 120 is the case a tester hit: 100, 200 and 120 of 420 round to 24 + 48 + 29 = 101%.
  const user = userEvent.setup({ document });
  await user.clear(food);
  await user.type(food, "120");

  expect(total(view.container)).toBe("$420");
  expect(shares(view.container)).toEqual([24, 48, 28]);
  expect(shares(view.container).reduce((sum, share) => sum + share, 0)).toBe(
    100,
  );
});

test("a part's slider changes the total, and a part at nothing leaves the bar", async () => {
  const view = draw();
  await view.findByRole("spinbutton", { name: "Food" });
  const food = slider(view.container, "Food");
  expect(total(view.container)).toBe("$380");

  // Home is the slider's lowest value: food costs nothing, so it has no slice of the bar.
  fireEvent.keyDown(food, { key: "Home" });
  expect(total(view.container)).toBe("$300");
  expect(slices(view.container).map((slice) => slice.part)).toEqual([
    "Transport",
    "Lodging",
  ]);
  expect(
    (view.getByRole("spinbutton", { name: "Food" }) as HTMLInputElement).value,
  ).toBe("0");
});

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import {
  GenerativeUISurface,
  standardUI,
  useGenerativeUIRuntime,
} from "@copilotkit/react-core/v2/generative-ui";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import {
  generativeUiProviderOptions,
  OMITTED_STANDARD_COMPONENTS,
  OPENBOT_UI,
  OPENBOT_UI_THEME,
} from "@/lib/copilot/a2ui";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const THREAD = "thread-trip";

/** What the runtime commits for a `render_ui` call that targets the "trip" surface. */
function Committed() {
  const runtime = useGenerativeUIRuntime();
  useEffect(() => {
    if (!runtime) return;
    runtime.manager.setActiveThread(THREAD);
    runtime.manager.ingest(THREAD, undefined, {
      surfaceId: "trip",
      target: "trip",
      catalogId: OPENBOT_UI.id,
      status: "ready",
      rejected: [],
      operations: [
        {
          version: "1.0",
          createSurface: {
            surfaceId: "trip",
            catalogId: OPENBOT_UI.id,
            dataModel: { destination: "Paris" },
          },
        },
        {
          version: "1.0",
          updateComponents: {
            surfaceId: "trip",
            components: [
              { id: "root", component: "Card", child: "fields" },
              {
                id: "fields",
                component: "Column",
                children: ["title", "destination"],
              },
              { id: "title", component: "Text", text: "Trip preferences" },
              {
                id: "destination",
                component: "TextField",
                label: "Destination",
                value: { "@path": "/destination" },
              },
            ],
          },
        },
      ],
    });
  }, [runtime]);
  return null;
}

test("the catalog draws a committed surface in OpenBot's tokens", async () => {
  const view = render(
    <CopilotKitProvider {...generativeUiProviderOptions(true)}>
      <Committed />
      <GenerativeUISurface id="trip" />
    </CopilotKitProvider>,
  );
  expect(await view.findByText("Trip preferences")).toBeTruthy();
  const field = view.getByRole("textbox", { name: "Destination" });
  expect((field as HTMLInputElement).value).toBe("Paris");

  // The theme is a stylesheet on the surface root, and it points at the app's own variables, which
  // switch under `.dark` themselves.
  const sheet = view.container.querySelector(".a2ui-surface style");
  expect(sheet?.textContent).toContain("--a2ui-color-accent:var(--primary)");
  expect(sheet?.textContent).toContain("--a2ui-color-surface:var(--card)");
});

test("disabled and unresolved deployments do not send the catalog", () => {
  expect(generativeUiProviderOptions(false)).toEqual({});
  expect(generativeUiProviderOptions(undefined)).toEqual({});
  expect(generativeUiProviderOptions(true).generativeUI).toEqual({
    ui: OPENBOT_UI,
    theme: OPENBOT_UI_THEME,
  });
});

test("the catalog is the standard one, less the omitted components, plus Breakdown and without the gallery", () => {
  expect(OPENBOT_UI.id).toBe("openbot/ui@1");
  const expected = Object.keys(standardUI.manifestComponents).filter(
    (name) =>
      !(OMITTED_STANDARD_COMPONENTS as readonly string[]).includes(name),
  );
  expect([...OPENBOT_UI.components.keys()].sort()).toEqual(
    [...expected, "Breakdown"].sort(),
  );
  expect(expected).toHaveLength(65);
  // The A2UI 1.0 basic components, under their A2UI names.
  for (const name of [
    "Text",
    "Image",
    "Icon",
    "Video",
    "AudioPlayer",
    "Row",
    "Column",
    "List",
    "Card",
    "Tabs",
    "Divider",
    "Modal",
    "Button",
    "CheckBox",
    "TextField",
    "DateTimeInput",
    "ChoicePicker",
    "Slider",
  ])
    expect(OPENBOT_UI.components.has(name)).toBe(true);
  expect(OPENBOT_UI.components.has("Table")).toBe(true);
  expect(OPENBOT_UI.components.has("Chart")).toBe(true);
  // Map needs maplibre-gl; the other three send linked domains to Google's favicon service.
  for (const name of ["Map", "Favicon", "LinkCard", "Citation"])
    expect(OPENBOT_UI.components.has(name)).toBe(false);
  // The gallery components keep their separate per-Bot tool and grant path.
  expect(OPENBOT_UI.components.has("showTable")).toBe(false);
  expect(OPENBOT_UI.components.has("askForm")).toBe(false);
});

/** The trip budget a starter task asks for: three number fields and a total the Bot computes. */
function Budget() {
  const runtime = useGenerativeUIRuntime();
  useEffect(() => {
    if (!runtime) return;
    const field = (key: string, label: string) => ({
      id: key,
      component: "TextField",
      label,
      variant: "number",
      value: { "@path": `/${key}` },
    });
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
            dataModel: { transport: 100, lodging: 200, food: 80, note: "" },
          },
        },
        {
          version: "1.0",
          updateComponents: {
            surfaceId: "budget",
            components: [
              { id: "root", component: "Card", child: "fields" },
              {
                id: "fields",
                component: "Column",
                children: [
                  "transport",
                  "lodging",
                  "food",
                  "total",
                  "note",
                  "echo",
                ],
              },
              field("transport", "Transport ($)"),
              field("lodging", "Lodging ($)"),
              field("food", "Food ($)"),
              {
                id: "total",
                component: "Text",
                text: {
                  "@call": "calc",
                  args: {
                    expression: "'Total $' + (transport + lodging + food)",
                    transport: { "@path": "/transport" },
                    lodging: { "@path": "/lodging" },
                    food: { "@path": "/food" },
                  },
                },
              },
              {
                id: "note",
                component: "TextField",
                label: "Note",
                value: { "@path": "/note" },
              },
              {
                id: "echo",
                component: "Text",
                text: {
                  "@call": "calc",
                  args: {
                    expression: "'Note ' + (note + 1)",
                    note: { "@path": "/note" },
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

test("a number field writes a number, so a total the Bot computes adds instead of joining", async () => {
  const view = render(
    <CopilotKitProvider {...generativeUiProviderOptions(true)}>
      <Budget />
      <GenerativeUISurface id="budget" />
    </CopilotKitProvider>,
  );
  expect(await view.findByText("Total $380")).toBeTruthy();

  // As a person changes it: select the amount and type over it.
  const user = userEvent.setup({ document });
  const lodging = view.getByLabelText("Lodging ($)") as HTMLInputElement;
  await user.clear(lodging);
  await user.type(lodging, "250");
  // A string "250" in the data model made this "Total $10025080".
  expect(await view.findByText("Total $430")).toBeTruthy();

  // An emptied field stays empty, so a person can start the amount again.
  await user.clear(lodging);
  expect(lodging.value).toBe("");
  await user.type(lodging, "300");
  expect(await view.findByText("Total $480")).toBeTruthy();

  // Other fields still write text.
  await user.type(view.getByLabelText("Note"), "5");
  expect(await view.findByText("Note 51")).toBeTruthy();
});

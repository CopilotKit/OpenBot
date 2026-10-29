import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import {
  GenerativeUISurface,
  useGenerativeUIRuntime,
} from "@copilotkit/react-core/v2/generative-ui";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import {
  A2UI_BASIC_COMPONENTS,
  generativeUiProviderOptions,
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
          version: "v1.0",
          createSurface: {
            surfaceId: "trip",
            catalogId: OPENBOT_UI.id,
            dataModel: { destination: "Paris" },
          },
        },
        {
          version: "v1.0",
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

test("the catalog is the A2UI 1.0 basic components, without the gallery", () => {
  expect(OPENBOT_UI.id).toBe("openbot/ui@1");
  // The same set the A2UI 0.9 basic catalog drew, under their A2UI names, and nothing else.
  expect([...OPENBOT_UI.components.keys()].sort()).toEqual(
    [...A2UI_BASIC_COMPONENTS].sort(),
  );
  expect(A2UI_BASIC_COMPONENTS).toHaveLength(18);
  // The rest of the standard catalog stays out until an admin can see and govern it.
  expect(OPENBOT_UI.components.has("Table")).toBe(false);
  expect(OPENBOT_UI.components.has("LinkCard")).toBe(false);
  // The gallery components keep their separate per-Bot tool and grant path.
  expect(OPENBOT_UI.components.has("showTable")).toBe(false);
  expect(OPENBOT_UI.components.has("askForm")).toBe(false);
});

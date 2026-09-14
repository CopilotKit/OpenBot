import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
  type A2UIClientEventMessage,
  A2UIProvider,
  A2UIRenderer,
  type ServerToClientMessage,
  useA2UIActions,
} from "@copilotkit/a2ui-renderer";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { a2uiProviderOptions, OPENBOT_A2UI_CATALOG } from "@/lib/copilot/a2ui";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const operations: ServerToClientMessage[] = [
  {
    version: "v0.9",
    createSurface: { surfaceId: "trip", catalogId: OPENBOT_A2UI_CATALOG.id },
  },
  {
    version: "v0.9",
    updateComponents: {
      surfaceId: "trip",
      components: [
        { id: "root", component: "Card", child: "fields" },
        {
          id: "fields",
          component: "Column",
          children: ["title", "destination", "confirm"],
        },
        {
          id: "title",
          component: "Text",
          text: "Trip preferences",
          variant: "h3",
        },
        {
          id: "destination",
          component: "TextField",
          label: "Destination",
          value: { path: "/destination" },
        },
        {
          id: "confirm",
          component: "Button",
          variant: "primary",
          child: "confirm-label",
          action: {
            event: {
              name: "confirm_trip",
              context: { destination: { path: "/destination" } },
            },
          },
        },
        { id: "confirm-label", component: "Text", text: "Confirm" },
      ],
    },
  },
  {
    version: "v0.9",
    updateDataModel: {
      surfaceId: "trip",
      path: "/",
      value: { destination: "Paris" },
    },
  },
];

function TripSurface() {
  const { processMessages } = useA2UIActions();
  useEffect(() => {
    processMessages(operations);
  }, [processMessages]);
  return <A2UIRenderer surfaceId="trip" />;
}

test("the public catalog renders a generated form and its action resolves the edited data", async () => {
  const user = userEvent.setup({ document });
  const actions: A2UIClientEventMessage[] = [];
  const view = render(
    <A2UIProvider
      catalog={OPENBOT_A2UI_CATALOG}
      onAction={(action) => {
        actions.push(action);
      }}
    >
      <TripSurface />
    </A2UIProvider>,
  );
  expect(await view.findByText("Trip preferences")).toBeTruthy();
  const field = view.getByRole("textbox", { name: "Destination" });
  expect(field.getAttribute("value")).toBe("Paris");
  await user.clear(field);
  await user.type(field, "Kyoto");
  await user.click(view.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(actions).toHaveLength(1));
  expect(actions[0]).toMatchObject({
    userAction: {
      name: "confirm_trip",
      surfaceId: "trip",
      context: { destination: "Kyoto" },
    },
  });
  expect(
    view.container.querySelector('[data-openbot-a2ui="Card"]'),
  ).toBeTruthy();
});

test("disabled and unresolved deployments do not activate or advertise the A2UI catalog", () => {
  expect(a2uiProviderOptions(false)).toEqual({});
  expect(a2uiProviderOptions(undefined)).toEqual({});
  expect(a2uiProviderOptions(true).a2ui?.catalog).toBe(OPENBOT_A2UI_CATALOG);
  // Existing OpenBot gallery components retain their separate per-Bot tool/grant path.
  expect(OPENBOT_A2UI_CATALOG.components.has("showTable")).toBe(false);
  expect(OPENBOT_A2UI_CATALOG.components.has("askForm")).toBe(false);
});

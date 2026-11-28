import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OpenAppsSection } from "@/components/admin/controls/open-apps-section";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { overviewResponse, SETTINGS_PATH } from "./admin-settings-api";
import { settleReactWork } from "./settle-react-work";

/*
 * Admin, Apps: Giving apps. Open by default. Turning it on opens apps at once; turning it off asks
 * first, and only then can the admin also take back what OpenBot gave Bots while apps were open. The
 * server is faked at the fetch boundary with the API's own answers, and keeps what is sent.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

let lockedDown: boolean;
const writes: unknown[] = [];

const APPS_SETTING_PATH = `${SETTINGS_PATH}/apps`;

function serving() {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    // The switch at its own address; the organization's settings never carry it.
    if (method === "PATCH" && path === SETTINGS_PATH)
      return Response.json({ error: "not this address" }, { status: 400 });
    if (path === APPS_SETTING_PATH) {
      if (method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { lockedDown: boolean };
        writes.push(body);
        lockedDown = body.lockedDown;
      }
      return Response.json({ lockedDown });
    }
    const overview = overviewResponse(path, {});
    if (overview) return overview;
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  lockedDown = false;
  queryClient.clear();
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  serving();
});

async function draw() {
  const router = createRouter({
    routeTree: createRootRoute({ component: OpenAppsSection }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, person: userEvent.setup({ document }) };
}

const OPEN =
  "People's connected apps are on for their own Bots, with every action. Turn this off to lock apps down.";
const LOCKED =
  "Locked down. An admin approves each request for an app, and one press gives only its read-only actions.";

test("apps are open by default, and locking them down asks first and takes back nothing unless ticked", async () => {
  const { view, person } = await draw();
  const toggle = await view.findByRole("switch", { name: "Open apps" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(view.getByText(OPEN)).toBeTruthy();

  // Turning it off asks, and sends nothing until confirmed.
  await person.click(toggle);
  const dialog = await view.findByRole("dialog", { name: "Lock apps down?" });
  expect(dialog).toBeTruthy();
  const box = view.getByRole("checkbox", {
    name: /Also take back what OpenBot gave Bots while apps were open/,
  });
  expect(box.getAttribute("aria-checked")).toBe("false");
  expect(writes).toEqual([]);

  // Cancelling leaves apps open.
  await person.click(view.getByRole("button", { name: "Keep apps open" }));
  await waitFor(() =>
    expect(view.queryByRole("dialog", { name: "Lock apps down?" })).toBeNull(),
  );
  expect(writes).toEqual([]);
  expect(
    view
      .getByRole("switch", { name: "Open apps" })
      .getAttribute("aria-checked"),
  ).toBe("true");

  // Confirmed without the box: locked down, nothing taken back.
  await person.click(view.getByRole("switch", { name: "Open apps" }));
  await person.click(
    await view.findByRole("button", { name: "Lock apps down" }),
  );
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toEqual({ lockedDown: true, takeBackWhatOpenGave: false });
  await waitFor(() => expect(view.getByText(LOCKED)).toBeTruthy());
  expect(
    view
      .getByRole("switch", { name: "Open apps" })
      .getAttribute("aria-checked"),
  ).toBe("false");

  // Turning it back on opens apps at once, with no dialog.
  await person.click(view.getByRole("switch", { name: "Open apps" }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toEqual({ lockedDown: false });
  expect(view.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(view.getByText(OPEN)).toBeTruthy());

  // Locked down again, this time taking back what open gave.
  await person.click(view.getByRole("switch", { name: "Open apps" }));
  await view.findByRole("dialog", { name: "Lock apps down?" });
  await person.click(
    view.getByRole("checkbox", {
      name: /Also take back what OpenBot gave Bots while apps were open/,
    }),
  );
  await person.click(view.getByRole("button", { name: "Lock apps down" }));
  await waitFor(() => expect(writes).toHaveLength(3));
  expect(writes[2]).toEqual({ lockedDown: true, takeBackWhatOpenGave: true });
  await waitFor(() => expect(view.getByText(LOCKED)).toBeTruthy());
});

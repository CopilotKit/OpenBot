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
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CapabilityPreview } from "@/lib/capability-changes/queries";
import type { CapabilityTranslation } from "@/lib/capability-changes/translate";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { Route as DescribeRoute } from "@/routes/_authed/admin/permissions_.describe";
import { settleReactWork } from "./settle-react-work";

/*
 * Admin, Permissions, Describe who can do what: once the model drafts the changes, the exact switches
 * it will set are on screen, labelled as what OpenBot checks, with the reading of them in words under
 * them. The server is faked at the fetch boundary with the shapes its routes answer with.
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

/** What a real model answered for "Members cannot use their own computer". */
const TRANSLATION: CapabilityTranslation = {
  changes: [
    {
      scopeKind: "role",
      scopeId: "user",
      capability: "localComputer",
      allowed: false,
    },
  ],
  summary: 'Members lose "Local computer access"; admins keep it.',
  explanation:
    'Turning off "Local computer access" for members stops their Bots from using folders and commands on their own machines. Admins keep "Local computer access".',
  check: { ok: true },
  warning: null,
};

const PREVIEW: CapabilityPreview = {
  check: { ok: true },
  people: [],
  counts: { people: 1, losing: 0, gaining: 0, keeping: 0, unchanged: 1 },
  activity: { days: 30, unmapped: [] },
  warning: null,
};

function serving() {
  global.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/admin/enterprise/capabilities/translate")
      return Response.json(TRANSLATION);
    if (path === "/api/admin/enterprise/capabilities/preview")
      return Response.json(PREVIEW);
    if (path === "/api/admin/enterprise")
      return Response.json({
        capabilities: [
          {
            capability: "localComputer",
            title: "Local computer access",
            description: "Bots use folders and commands on a person's machine.",
          },
        ],
        groups: [],
        network: [],
      });
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  queryClient.clear();
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  serving();
});

async function openDescribe() {
  const root = createRootRoute({ component: Outlet });
  const admin = createRoute({
    path: "/admin",
    getParentRoute: () => root,
    component: Outlet,
  });
  const permissions = createRoute({
    path: "/permissions",
    getParentRoute: () => admin,
    component: () => null,
  });
  const describe = (
    DescribeRoute as unknown as { update: (options: unknown) => never }
  ).update({
    id: "/permissions_/describe",
    path: "/permissions/describe",
    getParentRoute: () => admin,
  });
  const router = createRouter({
    routeTree: root.addChildren([admin.addChildren([permissions, describe])]),
    history: createMemoryHistory({
      initialEntries: ["/admin/permissions/describe"],
    }),
  });
  await router.load();
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("a drafted change shows the exact switch it sets, labelled as what OpenBot checks, above the reading in words", async () => {
  const view = await openDescribe();
  await userEvent.type(
    await view.findByLabelText("Describe the change"),
    "Members cannot use their own computer",
  );
  fireEvent.click(view.getByRole("button", { name: "Write changes" }));
  await view.findByText("What these changes do");

  const label = view.getByText("Changes");
  const field = label.closest('[data-slot="field"]') as HTMLElement;
  expect(field.textContent).toContain(
    "Your model drafted these from your description. They are the switches OpenBot checks, exactly as set.",
  );
  // The exact switch: which permission, for whom, set to what.
  expect(within(field).getByText("Local computer access")).toBeTruthy();
  expect(within(field).getByText("Members")).toBeTruthy();
  expect(within(field).getByText("Off")).toBeTruthy();

  // The reading in words comes under the switches, as their explanation.
  const reading = view.getByText("What these changes do");
  expect(
    field.compareDocumentPosition(reading) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(view.getByText(TRANSLATION.explanation as string)).toBeTruthy();
});

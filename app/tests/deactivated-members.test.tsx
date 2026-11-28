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
import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { OrganizationSettingsPage } from "@/components/organizations/organization-settings-page";
import { PeopleTypeahead } from "@/components/teams/people-typeahead";
import type { OrganizationMember } from "@/lib/api/generated/model";
import { ListOrganizationMembersResponse } from "@/lib/api/generated/organizations/organizations.zod";
import { deploymentKeys } from "@/lib/deployment/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { organizationKeys } from "@/lib/organizations/queries";
import { queryClient } from "@/query-client";
import { ME_PATH, meResponse } from "./accounts-api";
import { organizationMember } from "./organizations-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A member whose account is scheduled to be deleted is listed with "Deactivated" beside their name,
 * the server's verdict (`deactivated` on listOrganizationMembers, api/openapi/organizations.yaml):
 * in the organization's members, and in the box that picks somebody from the organization (adding
 * people to a team or a group conversation). Nobody else is labelled. The server's answers are
 * checked against the schema generated from the spec.
 */

const MEMBERS: OrganizationMember[] = [
  organizationMember("Dana Whitfield", "dana@acme.test", "owner", {
    id: "dana",
    removable: false,
  }),
  organizationMember("Priya Raman", "priya@acme.test", "member", {
    deactivated: true,
  }),
  organizationMember("Sam Ortiz", "sam@acme.test", "member", {
    deactivated: false,
  }),
];

const originalFetch = globalThis.fetch;

beforeAll(() => GlobalRegistrator.register({ url: "http://openbot.invalid/" }));
beforeEach(() => {
  queryClient.clear();
  setCurrentOrganization("default");
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  queryClient.setQueryData(organizationKeys.mine(), {
    organizations: [
      {
        id: "default",
        slug: "acme",
        name: "Acme Freight",
        role: "owner",
        personal: false,
        active: true,
      },
    ],
    canCreate: true,
    nextCursor: null,
    currentId: "default",
  });
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input), "http://openbot.invalid");
      if (url.pathname === ME_PATH)
        return meResponse({
          user: { id: "dana", email: "dana@acme.test", name: "Dana Whitfield" },
        });
      if (url.pathname === "/api/v2/organizations/default/members") {
        const search = url.searchParams.get("search")?.toLowerCase() ?? "";
        return Response.json(
          ListOrganizationMembersResponse.parse({
            members: MEMBERS.filter((one) =>
              `${one.name} ${one.email}`.toLowerCase().includes(search),
            ),
            nextCursor: null,
          }),
        );
      }
      if (url.pathname === "/api/v2/organizations/default/invitations")
        return Response.json({ invitations: [], nextCursor: null });
      return Response.json({ detail: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function draw(component: () => ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** A member's row, by their name. */
function rowOf(view: ReturnType<typeof render>, name: string): HTMLElement {
  return view.getByText(name).closest("[data-slot=item]") as HTMLElement;
}

test("the members list says Deactivated beside a member whose account is to be deleted, and nobody else", async () => {
  const view = draw(OrganizationSettingsPage);
  await view.findByText("Priya Raman");
  const title = rowOf(view, "Priya Raman").querySelector(
    "[data-slot=item-title]",
  );
  expect(title?.textContent).toBe("Priya RamanDeactivated");
  for (const name of ["Dana Whitfield", "Sam Ortiz"])
    expect(rowOf(view, name).textContent).not.toContain("Deactivated");
  // Still a member until the account goes: an owner can still remove them.
  expect(
    within(rowOf(view, "Priya Raman")).getByRole("button", {
      name: "Remove Priya Raman",
    }),
  ).toBeTruthy();
});

test("the box that picks somebody from the organization says it too, to the eye and to a screen reader", async () => {
  const view = draw(() => (
    <PeopleTypeahead
      label="People to add to Sales"
      onChoose={() => {}}
      unavailable={() => null}
    />
  ));
  await userEvent
    .setup({ document })
    .type(await view.findByRole("combobox", { name: "Name or email" }), "a");
  const priya = await view.findByRole("option", {
    name: "Priya Raman, priya@acme.test, deactivated",
  });
  expect(priya.textContent).toContain("Deactivated");
  const sam = view.getByRole("option", { name: "Sam Ortiz, sam@acme.test" });
  expect(sam.textContent).not.toContain("Deactivated");
});

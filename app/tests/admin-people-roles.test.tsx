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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { deploymentKeys } from "@/lib/deployment/queries";
import {
  currentOrganizationId,
  setCurrentOrganization,
} from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { Route } from "@/routes/_authed/admin/people";
import { ME_PATH, meResponse, PEOPLE_PATH, personBody } from "./accounts-api";
import { settleReactWork } from "./settle-react-work";

/*
 * Admin, People: a person's role is one of the organization's member roles. The list reads admin or
 * member, and the admin switch gives a person admin or member, as the API names them; it never sends
 * today's `user`. The server is faked at the fetch boundary with the API's own answers.
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

const dana = {
  id: "dana",
  email: "dana@acme.test",
  name: "Dana Whitfield",
  role: "admin" as const,
};
const sam = {
  id: "sam",
  email: "sam@acme.test",
  name: "Sam Ortiz",
  role: "member" as const,
};
const roles: Record<string, "owner" | "admin" | "member"> = {};
/** The organization Dana works in, as the list of her organizations says; null lists none. */
let working: { id: string; personal: boolean } | null = null;
const sent: unknown[] = [];

beforeEach(() => {
  roles.dana = "admin";
  roles.sam = "member";
  sent.length = 0;
  working = null;
  queryClient.clear();
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split("?")[0];
    const method = init?.method ?? "GET";
    if (path === ME_PATH) return meResponse({ user: dana });
    if (path === "/api/v2/people/me/organizations" && working)
      return Response.json({
        organizations: [
          {
            id: working.id,
            slug: working.id,
            name: working.personal ? "Sam's organization" : "Acme Freight",
            role: "admin",
            personal: working.personal,
            active: true,
          },
        ],
        canCreate: true,
        nextCursor: null,
      });
    // People in whichever organization is being worked in.
    if (
      path === PEOPLE_PATH ||
      /^\/api\/v2\/organizations\/[^/]+\/people$/.test(path)
    )
      return Response.json({
        people: [dana, sam].map((one) =>
          personBody({ ...one, role: roles[one.id] }),
        ),
        nextCursor: null,
      });
    if (path === `${PEOPLE_PATH}/sam` && method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as {
        role: "admin" | "member";
      };
      sent.push(body);
      roles.sam = body.role;
      return Response.json({ person: personBody({ ...sam, role: body.role }) });
    }
    return Response.json({ detail: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
});

async function draw() {
  const router = createRouter({
    routeTree: createRootRoute({
      component: Route.options.component as () => React.JSX.Element,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("the admin switch gives a member admin and back, by the member role names", async () => {
  const view = await draw();
  const switchFor = () =>
    view.findByRole("switch", { name: "Admin: sam@acme.test" });

  expect((await switchFor()).getAttribute("aria-checked")).toBe("false");
  fireEvent.click(await switchFor());
  await waitFor(() => expect(sent).toEqual([{ role: "admin" }]));
  await waitFor(async () =>
    expect((await switchFor()).getAttribute("aria-checked")).toBe("true"),
  );

  fireEvent.click(await switchFor());
  await waitFor(() =>
    expect(sent).toEqual([{ role: "admin" }, { role: "member" }]),
  );
  await waitFor(async () =>
    expect((await switchFor()).getAttribute("aria-checked")).toBe("false"),
  );
});

/*
 * Found in testing: an organization's owner showed with the Admin switch off. An owner governs the
 * organization as an admin does, and their role is not one this switch changes (only the owner
 * gives ownership away, in Organization settings), so it reads on and can't be changed here.
 */
test("an owner's admin switch reads on and can't be changed, and nothing is sent", async () => {
  roles.sam = "owner";
  const view = await draw();
  const owner = await view.findByRole("switch", {
    name: "Admin: sam@acme.test",
  });
  await waitFor(() => expect(owner.getAttribute("aria-checked")).toBe("true"));
  expect(
    owner.hasAttribute("disabled") ||
      owner.getAttribute("aria-disabled") === "true" ||
      owner.hasAttribute("data-disabled"),
  ).toBe(true);
  fireEvent.click(owner);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(sent).toEqual([]);
});

/*
 * FOUND IN THE BIG TEST: an owner's row had its Admin switch and Remove turned off with nothing to
 * say why. It says so under the row, and only what is true where the person is working: a person's
 * own organization always has them as its owner; in a shared one an owner gives the Owner role in
 * Organization settings; where OpenBot lists no organizations there is no such page to point to.
 */
const ownerHint = async () => {
  const view = await draw();
  await view.findByRole("switch", { name: "Admin: sam@acme.test" });
  return view;
};

test("an owner's row where OpenBot lists no organizations says only that owners are admins", async () => {
  roles.sam = "owner";
  const view = await ownerHint();
  expect(await view.findByText("Owners are always admins.")).toBeTruthy();
  expect(view.queryByText(/Organization settings/)).toBeNull();
});

test("an owner's row in a shared organization points to the Owner role in Organization settings", async () => {
  roles.sam = "owner";
  working = { id: "default", personal: false };
  const view = await ownerHint();
  expect(
    await view.findByText(
      "Owners are always admins. An owner can change a member's role to Owner in Organization settings.",
    ),
  ).toBeTruthy();
});

test("an owner's row in their own organization says it always has them as owner", async () => {
  roles.sam = "owner";
  working = { id: "org_sam", personal: true };
  try {
    const view = await ownerHint();
    await waitFor(() => expect(currentOrganizationId()).toBe("org_sam"));
    expect(
      await view.findByText(
        "This is Sam Ortiz's own organization, so they're always its owner.",
      ),
    ).toBeTruthy();
    expect(view.queryByText(/Organization settings/)).toBeNull();
  } finally {
    setCurrentOrganization("default");
  }
});

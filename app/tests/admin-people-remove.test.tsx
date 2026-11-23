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
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
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
 * Admin, People: removing a person's access is asked about first. Remove opens a dialog naming the
 * person and saying what ends; nothing is sent until the dialog is confirmed, Cancel sends nothing,
 * and a refusal is said in the dialog. The server is faked at the fetch boundary with the API's own
 * answers.
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
// No name yet, so the screen and the question call them by their address.
const lee = { id: "lee", email: "lee@acme.test", role: "member" as const };
const everybody = [dana, sam, lee];

const removed = new Set<string>();
/** Every request that is not a read, as `METHOD path`. */
const writes: string[] = [];
/** The sentence the server refuses a removal with, when a test sets one. */
let refusal: string | null = null;
/**
 * Whether this OpenBot has several organizations, everybody with one of their own. Off, it keeps one
 * and has no list of them to answer (the address is not served), as before organizations.
 */
let severalOrganizations = false;
/** Which of the person's organizations they are working in, where there are several. */
let activeOrganization = "default";

beforeEach(() => {
  removed.clear();
  writes.length = 0;
  refusal = null;
  severalOrganizations = false;
  activeOrganization = "default";
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
    if (method !== "GET") writes.push(`${method} ${path}`);
    if (path === ME_PATH) return meResponse({ user: dana });
    if (path === "/api/v2/people/me/organizations" && severalOrganizations)
      return Response.json({
        organizations: [
          {
            id: "default",
            slug: "acme",
            name: "Acme Freight",
            role: "admin",
            personal: false,
            active: activeOrganization === "default",
          },
          {
            id: "org_dana",
            slug: "dana",
            name: "Dana's organization",
            role: "owner",
            personal: true,
            active: activeOrganization === "org_dana",
          },
        ],
        canCreate: true,
        nextCursor: null,
      });
    if (path === PEOPLE_PATH && method === "GET")
      return Response.json({
        people: everybody.map((one) => ({
          ...personBody(one),
          revoked: removed.has(one.id),
        })),
        nextCursor: null,
      });
    const person = everybody.find(
      (one) => path === `${PEOPLE_PATH}/${one.id}/revoke-access`,
    );
    if (person && method === "POST") {
      if (refusal)
        return new Response(
          JSON.stringify({
            status: 409,
            code: "conflict",
            title: "conflict",
            detail: refusal,
          }),
          {
            status: 409,
            headers: { "content-type": "application/problem+json" },
          },
        );
      removed.add(person.id);
      return Response.json({
        person: { ...personBody(person), revoked: true },
      });
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

test("Remove asks first, naming the person and what ends, and Cancel changes nothing", async () => {
  const view = await draw();
  fireEvent.click(
    await view.findByRole("button", { name: "Remove Sam Ortiz" }),
  );
  const dialog = await view.findByRole("dialog", {
    name: "Remove Sam Ortiz from OpenBot?",
  });
  // Asked first: nothing is sent until the answer.
  expect(writes).toEqual([]);
  expect(dialog.textContent).toContain("signed out everywhere");
  expect(dialog.textContent).toContain("API keys");

  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  expect(writes).toEqual([]);
  expect(view.getByText("Sam Ortiz")).toBeTruthy();
  expect(view.getByRole("button", { name: "Remove Sam Ortiz" })).toBeTruthy();
});

test("confirming removes the person, whose row then says so and offers Restore", async () => {
  const view = await draw();
  fireEvent.click(
    await view.findByRole("button", { name: "Remove Sam Ortiz" }),
  );
  const dialog = await view.findByRole("dialog", {
    name: "Remove Sam Ortiz from OpenBot?",
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

  await waitFor(() =>
    expect(writes).toEqual([`POST ${PEOPLE_PATH}/sam/revoke-access`]),
  );
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  // A removed person keeps their record, so the row stays and reads as removed.
  expect(
    await view.findByRole("button", { name: "Restore Sam Ortiz" }),
  ).toBeTruthy();
  expect(view.queryByRole("button", { name: "Remove Sam Ortiz" })).toBeNull();
  expect(view.getByText(/sam@acme\.test · Access removed/)).toBeTruthy();
});

test("somebody with no name is asked about by their address", async () => {
  const view = await draw();
  fireEvent.click(
    await view.findByRole("button", { name: "Remove lee@acme.test" }),
  );
  expect(
    await view.findByRole("dialog", {
      name: "Remove lee@acme.test from OpenBot?",
    }),
  ).toBeTruthy();
  expect(writes).toEqual([]);
});

/*
 * Where people may create organizations, removing somebody ends their membership of this
 * organization and nothing else: they stay signed in, any other organization they're in stays
 * theirs, and their API keys go on working there. The dialog said they were signed out everywhere
 * and their keys stopped working, every clause of which was false. A self-hosted OpenBot gives
 * nobody an organization of their own, so it doesn't promise one either.
 */
test("with several organizations, Remove says it takes them out of this one alone", async () => {
  severalOrganizations = true;
  const view = await draw();
  fireEvent.click(
    await view.findByRole("button", { name: "Remove Sam Ortiz" }),
  );
  const dialog = await view.findByRole("dialog", {
    name: "Remove Sam Ortiz from Acme Freight?",
  });
  expect(writes).toEqual([]);
  const said = dialog.textContent ?? "";
  expect(said).toContain("Acme Freight");
  expect(said).toContain("any other organization they're in");
  expect(said).not.toContain("their own organization");
  expect(said).not.toContain("signed out");
  expect(said).not.toContain("can't sign in");
  expect(said).not.toContain("API keys");
  expect(said).not.toContain("OpenBot");

  fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
  await waitFor(() =>
    expect(writes).toEqual([`POST ${PEOPLE_PATH}/sam/revoke-access`]),
  );
  // The row says where they were removed from, and Restore is still offered.
  expect(
    await view.findByRole("button", { name: "Restore Sam Ortiz" }),
  ).toBeTruthy();
  expect(
    view.getByText(/sam@acme\.test · Removed from Acme Freight/),
  ).toBeTruthy();
});

/*
 * INITIAL_ADMIN_EMAILS names the admins of the deployment's first organization, `default`, and
 * nowhere else. On another organization's People page the line saying those addresses are always
 * admins was false there.
 */
test("the INITIAL_ADMIN_EMAILS line shows in the first organization only", async () => {
  const LINE =
    "Addresses in INITIAL_ADMIN_EMAILS are always admins. You can't change them here.";
  severalOrganizations = true;
  const first = await draw();
  expect(await first.findByText(LINE)).toBeTruthy();
  cleanup();

  activeOrganization = "org_dana";
  queryClient.clear();
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  try {
    const second = await draw();
    await second.findByText("Who is here");
    await waitFor(() => expect(currentOrganizationId()).toBe("org_dana"));
    await settleReactWork();
    expect(second.queryByText(LINE)).toBeNull();
  } finally {
    setCurrentOrganization("default");
  }
});

test("a removal the server refuses is said in the dialog, and the person stays", async () => {
  refusal = "You can't remove the only admin.";
  const view = await draw();
  fireEvent.click(
    await view.findByRole("button", { name: "Remove Sam Ortiz" }),
  );
  const dialog = await view.findByRole("dialog", {
    name: "Remove Sam Ortiz from OpenBot?",
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "You can't remove the only admin.",
  );
  // The dialog stays open over the page, where nobody reads as removed.
  expect(view.getByText("Sam Ortiz")).toBeTruthy();
  expect(view.queryByText(/Access removed/)).toBeNull();
});

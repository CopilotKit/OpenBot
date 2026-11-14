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
const roles: Record<string, "admin" | "member"> = {};
const sent: unknown[] = [];

beforeEach(() => {
  roles.dana = "admin";
  roles.sam = "member";
  sent.length = 0;
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
    if (path === PEOPLE_PATH)
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

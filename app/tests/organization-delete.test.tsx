import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { OrganizationBoundary } from "@/components/organizations/organization-boundary";
import { OrganizationSettingsPage } from "@/components/organizations/organization-settings-page";
import { SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/toast";
import type { Organization } from "@/lib/api/generated/model";
import {
  DeleteOrganizationHeader,
  ListOrganizationMembersResponse,
  ListOrganizationsResponse,
} from "@/lib/api/generated/organizations/organizations.zod";
import { signedInUser } from "@/lib/auth/queries";
import {
  currentOrganizationId,
  setCurrentOrganization,
} from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * An organization's owner can delete it from its settings (deleteOrganization, api/openapi/organizations.yaml). It asks
 * first, with the organization's name typed, then deletes it, and the person is then working in another of their
 * organizations, from home. The server keeps a person's own organization and `default`, and refuses deleting them in
 * its own words, which the dialog shows. Only an owner is offered it.
 *
 * The server here answers at the API's addresses, in the API's shapes, each answer checked against the schemas
 * generated from the spec. The app is the real sidebar and the real settings screen, on the app's one query client.
 */

class OfflineWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  onclose = null;
  onerror = null;
  onmessage = null;
  onopen = null;
  close() {}
  send() {}
}

type Listed = Omit<Organization, "active">;

const OWN: Listed = {
  id: "org_dana",
  slug: "dana",
  name: "Dana's organization",
  role: "owner",
  personal: true,
};
const ACME: Listed = {
  id: "org_acme",
  slug: "acme",
  name: "Acme",
  role: "owner",
  personal: false,
};
const DEFAULT: Listed = {
  id: "default",
  slug: "default",
  name: "Example Inc",
  role: "owner",
  personal: false,
};

/** The refusals the spec gives for deleteOrganization, in its own words. */
const REFUSALS = {
  personal: {
    status: 409,
    code: "CONFLICT",
    detail:
      "This is your own organization, so it stays. You can delete organizations you created.",
  },
  default: {
    status: 409,
    code: "CONFLICT",
    detail: "This organization comes with OpenBot, so it stays.",
  },
  unfinished: {
    status: 503,
    code: "SERVICE_UNAVAILABLE",
    detail: "The organization couldn't be deleted. Try again.",
  },
  notOwner: {
    status: 403,
    code: "PERMISSION_DENIED",
    detail: "Only an owner can delete this organization.",
  },
} as const;

let server: {
  organizations: Listed[];
  active: string;
  /** What the next delete is refused with, when it is. */
  refusal: keyof typeof REFUSALS | null;
};
let requests: string[] = [];
let deletes: { path: string; key: string | null }[] = [];
const DEPLOYMENT = "/api/v2/organizations/default/deployment";

function problem({
  status,
  code,
  detail,
}: {
  status: number;
  code: string;
  detail: string;
}): Response {
  return new Response(
    JSON.stringify({
      type: "https://open.bot/errors/example",
      title: detail,
      status,
      detail,
      code,
      category: "conflict",
      retryable: false,
      requestId: "req_example",
      traceId: "trace_example",
    }),
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

/** An answer, checked against the schema the spec generates for it. */
function checked(schema: { parse(value: unknown): unknown }, body: unknown) {
  return Response.json(schema.parse(body));
}

async function answer(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(String(input), "http://openbot.invalid");
  const method = (init?.method ?? "GET").toUpperCase();
  const path = url.pathname;
  requests.push(`${method} ${path}`);
  const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;

  if (path === DEPLOYMENT)
    return Response.json({
      generativeUi: true,
      selfHostBanner: false,
      localEvaluation: false,
      edition: "team",
    });
  if (path === "/api/v2/people/me/organizations" && method === "GET")
    return checked(ListOrganizationsResponse, {
      organizations: server.organizations.map((one) => ({
        ...one,
        active: one.id === server.active,
      })),
      canCreate: true,
      nextCursor: null,
    });
  if (path === "/api/auth/organization/set-active" && method === "POST") {
    const wanted = (body as { organizationId: string }).organizationId;
    if (!server.organizations.some((one) => one.id === wanted))
      return Response.json({ message: "Not a member." }, { status: 403 });
    server.active = wanted;
    return Response.json({ id: wanted });
  }
  if (path === "/api/v2/people/me/invitations")
    return Response.json({ invitations: [], nextCursor: null });

  const addressed = /^\/api\/v2\/organizations\/([^/]+)\/(.+)$/.exec(path);
  if (addressed) {
    const [, organization, rest] = addressed;
    const here = server.organizations.find((one) => one.id === organization);
    if (!here)
      return problem({
        status: 404,
        code: "ORGANIZATION_NOT_FOUND",
        detail: "Couldn't find that organization.",
      });
    if (rest === "profile" && method === "DELETE") {
      const key = new Headers(init?.headers).get("idempotency-key");
      DeleteOrganizationHeader.parse({ "Idempotency-Key": key });
      deletes.push({ path, key });
      if (here.role !== "owner") return problem(REFUSALS.notOwner);
      if (server.refusal) {
        const refusal = REFUSALS[server.refusal];
        server.refusal = null;
        return problem(refusal);
      }
      if (here.personal) return problem(REFUSALS.personal);
      if (here.id === "default") return problem(REFUSALS.default);
      server.organizations = server.organizations.filter(
        (one) => one.id !== organization,
      );
      return new Response(null, { status: 204 });
    }
    if (rest === "people/me")
      return Response.json({
        person: {
          id: "dana",
          email: "dana@example.com",
          name: "Dana Fresh",
          needsName: false,
          image: null,
          role: here.role,
          onboarding: null,
        },
        openbotVersion: null,
      });
    if (rest === "members")
      return checked(ListOrganizationMembersResponse, {
        members: [
          {
            id: "dana",
            email: "dana@example.com",
            name: "Dana Fresh",
            image: null,
            role: here.role,
            joinedAt: "2026-11-01T09:00:00.000Z",
            removable: false,
            assignableRoles: [],
          },
        ],
        nextCursor: null,
      });
    if (rest === "invitations")
      return Response.json({ invitations: [], nextCursor: null });
    if (rest === "conversations")
      return Response.json({ conversations: [], nextCursor: null });
    if (rest === "bots") return Response.json({ bots: [], nextCursor: null });
  }
  return Response.json({ error: "not served" }, { status: 404 });
}

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://openbot.invalid/" });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
beforeEach(() => {
  server = {
    organizations: [{ ...OWN }, { ...ACME }],
    active: ACME.id,
    refusal: null,
  };
  requests = [];
  deletes = [];
  setCurrentOrganization(undefined);
  queryClient.clear();
  globalThis.fetch = Object.assign(answer, {
    preconnect: originalFetch.preconnect,
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
  setCurrentOrganization("default");
});

async function open(start = "/settings/organization") {
  await signedInUser(queryClient);
  const rootRoute = createRootRoute({
    component: () => (
      <OrganizationBoundary>
        <SidebarProvider>
          <AppSidebar />
          <main>
            <Outlet />
          </main>
          <Toaster />
        </SidebarProvider>
      </OrganizationBoundary>
    ),
  });
  const at = (path: string, component: () => ReactNode) =>
    createRoute({ getParentRoute: () => rootRoute, path, component });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [start] }),
    routeTree: rootRoute.addChildren([
      at("/", () => <p>Home</p>),
      at("/settings/organization", OrganizationSettingsPage),
    ]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  const person = userEvent.setup({ document });
  const page = within(await view.findByRole("main"));
  return { view, router, person, page };
}

/** Opens the Delete dialog and types `typed` into its confirmation. */
async function askToDelete(
  app: Awaited<ReturnType<typeof open>>,
  name: string,
  typed = name,
) {
  await app.person.click(
    await app.page.findByRole("button", { name: "Delete organization" }),
  );
  const dialog = await app.view.findByRole("dialog", {
    name: `Delete ${name}?`,
  });
  const confirm = within(dialog).getByRole("button", {
    name: "Delete organization",
  });
  expect(confirm.hasAttribute("disabled")).toBe(true);
  await app.person.type(
    within(dialog).getByLabelText(`Type ${name} to confirm`),
    typed,
  );
  return { dialog, confirm };
}

describe("deleting an organization", () => {
  test("its owner deletes it after typing its name, and is then working in another of their organizations, from home", async () => {
    const app = await open();
    const { confirm } = await askToDelete(app, "Acme", "Acm");
    // Not the name yet: nothing to press.
    expect(confirm.hasAttribute("disabled")).toBe(true);
    expect(deletes).toEqual([]);
    await app.person.type(
      within(await app.view.findByRole("dialog")).getByLabelText(
        "Type Acme to confirm",
      ),
      "e",
    );
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
    requests = [];
    await app.person.click(confirm);

    await waitFor(() => expect(currentOrganizationId()).toBe(OWN.id));
    expect(app.router.state.location.pathname).toBe("/");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.path).toBe(`/api/v2/organizations/${ACME.id}/profile`);
    expect(deletes[0]?.key).toMatch(/^[0-9a-f]{32}$/);
    expect(server.active).toBe(OWN.id);
    expect(server.organizations.map((one) => one.id)).toEqual([OWN.id]);
    // Nothing more was asked of the organization once it was gone.
    const gone = requests.indexOf(
      `DELETE /api/v2/organizations/${ACME.id}/profile`,
    );
    expect(
      requests.slice(gone + 1).filter((request) => request.includes(ACME.id)),
    ).toEqual([]);
    await waitFor(() => expect(app.view.queryByRole("dialog")).toBeNull());
  });

  test("a person's own organization stays: the server's refusal is said in the dialog and nothing changes", async () => {
    server.active = OWN.id;
    const app = await open();
    const { dialog, confirm } = await askToDelete(app, OWN.name);
    await app.person.click(confirm);
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      REFUSALS.personal.detail,
    );
    expect(currentOrganizationId()).toBe(OWN.id);
    expect(app.router.state.location.pathname).toBe("/settings/organization");
    expect(server.organizations.map((one) => one.id)).toEqual([
      OWN.id,
      ACME.id,
    ]);
  });

  test("the organization that comes with OpenBot stays, in the server's words", async () => {
    server.organizations = [{ ...OWN }, { ...DEFAULT }];
    server.active = DEFAULT.id;
    const app = await open();
    const { dialog, confirm } = await askToDelete(app, DEFAULT.name);
    await app.person.click(confirm);
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      REFUSALS.default.detail,
    );
    expect(currentOrganizationId()).toBe(DEFAULT.id);
  });

  test("a delete the server could not finish is said, and asking again deletes it", async () => {
    server.refusal = "unfinished";
    const app = await open();
    const { dialog, confirm } = await askToDelete(app, "Acme");
    await app.person.click(confirm);
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      REFUSALS.unfinished.detail,
    );
    expect(currentOrganizationId()).toBe(ACME.id);

    await app.person.click(confirm);
    await waitFor(() => expect(currentOrganizationId()).toBe(OWN.id));
    expect(deletes).toHaveLength(2);
    // Each request a person asks for is its own write, with its own key.
    expect(deletes[0]?.key).not.toBe(deletes[1]?.key);
  });

  test("an admin or a member is not offered it", async () => {
    for (const role of ["admin", "member"] as const) {
      server.organizations = [{ ...OWN }, { ...ACME, role }];
      const app = await open();
      await app.page.findByText("Members");
      expect(
        app.page.queryByRole("button", { name: "Delete organization" }),
      ).toBeNull();
      cleanup();
      queryClient.clear();
      setCurrentOrganization(undefined);
    }
  });
});

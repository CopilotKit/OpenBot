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
import {
  PendingDeletionGate,
  pendingPageDeps,
} from "@/components/auth/pending-deletion-page";
import { PageShell } from "@/components/layout/page-shell";
import {
  DeleteAccountSection,
  ResumeAccountDeletion,
} from "@/components/settings/delete-account";
import { Toaster } from "@/components/ui/toast";
import {
  clearPendingDeletion,
  resumeDeletionAfterSignIn,
  showPendingDeletion,
} from "@/lib/account-deletion/pending";
import { scheduledDeletion } from "@/lib/account-deletion/queries";
import { reauthenticationDeps } from "@/lib/account-deletion/reauthenticate";
import type { AccountDeletionBlocker } from "@/lib/api/generated/model";
import { getDeployment } from "@/lib/api/generated/organization-settings/organization-settings";
import { ListOrganizationsResponse } from "@/lib/api/generated/organizations/organizations.zod";
import {
  CancelAccountDeletionHeader,
  CancelAccountDeletionResponse,
  GetAccountDeletionResponse,
  RequestAccountDeletionBody,
  RequestAccountDeletionHeader,
  RequestAccountDeletionResponse,
} from "@/lib/api/generated/people/people.zod";
import { signedInUser } from "@/lib/auth/queries";
import { ReportedErrorComponent } from "@/lib/error-reporting";
import {
  currentOrganizationId,
  setCurrentOrganization,
} from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * Deleting your own account, from Settings, General (getAccountDeletion, requestAccountDeletion and
 * cancelAccountDeletion in api/openapi/accounts.yaml). The organizations that stop it are listed
 * first, each with what to do there; with none left, the dialog asks for the person's email address
 * and the phrase, and deletes in 14 days or now. A session too old to delete is sent through sign-in
 * and back to the dialog. Once a deletion is scheduled the app is only the page that says when and
 * offers Cancel deletion and Sign out, whether the person just asked or every request says so.
 *
 * The server answers at the API's addresses, in the API's shapes, each request and answer checked
 * against the schemas generated from the spec. The screens are the real ones, on the app's one
 * query client.
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

const EMAIL = "dana@example.com";
const DELETION = "/api/v2/people/me/account-deletion";
const CANCEL = `${DELETION}/cancel`;
const ACME: AccountDeletionBlocker = {
  organizationId: "org_acme",
  organizationName: "Acme",
  reason: "only_owner",
};
const GLOBEX: AccountDeletionBlocker = {
  organizationId: "org_globex",
  organizationName: "Globex",
  reason: "owner_must_leave",
};
const ORGANIZATIONS = [
  { id: "org_dana", slug: "dana", name: "Dana's organization", personal: true },
  { id: "org_acme", slug: "acme", name: "Acme", personal: false },
  { id: "org_globex", slug: "globex", name: "Globex", personal: false },
];

let server: {
  active: string;
  blockers: AccountDeletionBlocker[];
  scheduled: { requestedAt: string; deleteAfter: string } | null;
  /** What the next deletion request is refused with, when it is. */
  refuse: "reauthenticate" | "blocked" | null;
  /** Every request but the deletion's own is refused ACCOUNT_PENDING_DELETION. */
  pendingEverywhere: boolean;
  /** The operation isn't served: an OpenBot older than it. */
  older: boolean;
  /** Which product the deployment says it is; the personal edition doesn't serve the operation. */
  edition: "team" | "personal";
  /** The sign-in providers the deployment offers, and the ones the person signed in through. */
  providers: string[];
  signedInWith: string[];
};
let requests: string[];
let deletions: { body: unknown; key: string | null }[];
let cancels: (string | null)[];
let opened: string[];
/** Each sign-in started again at the provider, as Better Auth would be asked to start it. */
let started: Parameters<typeof reauthenticationDeps.start>[0][];

function problem(status: number, code: string, detail: string, more = {}) {
  return new Response(
    JSON.stringify({
      type: `https://open.bot/errors/${code.toLowerCase().replaceAll("_", "-")}`,
      title: detail,
      status,
      detail,
      code,
      category: "permission",
      retryable: false,
      requestId: "req_example",
      traceId: "trace_example",
      ...more,
    }),
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

function checked(schema: { parse(value: unknown): unknown }, body: unknown) {
  return Response.json(schema.parse(body));
}

const PENDING_SAID =
  "Your account is scheduled to be deleted. Cancel the deletion to use OpenBot again.";

async function answer(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(String(input), "http://openbot.invalid");
  const method = (init?.method ?? "GET").toUpperCase();
  const path = url.pathname;
  requests.push(`${method} ${path}`);
  const headers = new Headers(init?.headers);
  const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;

  if (path === "/api/auth/sign-out" && method === "POST")
    return Response.json({ success: true });
  if (path.startsWith(DELETION) && (server.older || server.edition !== "team"))
    return Response.json({ error: "not served" }, { status: 404 });
  if (path === DELETION && method === "GET")
    return checked(
      GetAccountDeletionResponse,
      server.scheduled
        ? { status: "scheduled", ...server.scheduled, blockers: [] }
        : { status: "none", blockers: server.blockers },
    );
  if (path === DELETION && method === "POST") {
    const key = headers.get("idempotency-key");
    RequestAccountDeletionHeader.parse({ "Idempotency-Key": key });
    const sent = RequestAccountDeletionBody.strict().parse(body);
    deletions.push({ body, key });
    if (server.refuse === "reauthenticate") {
      server.refuse = null;
      return problem(
        403,
        "REAUTHENTICATE",
        "To delete your account, sign in again first.",
      );
    }
    if (server.refuse === "blocked") {
      server.refuse = null;
      server.blockers = [ACME];
      return problem(
        409,
        "ACCOUNT_DELETION_BLOCKED",
        "You're the only owner of Acme. Make someone else an owner, or delete the organization, then try again.",
        { blockers: [ACME] },
      );
    }
    if (server.blockers.length > 0)
      return problem(409, "ACCOUNT_DELETION_BLOCKED", "Blocked.", {
        blockers: server.blockers,
      });
    if (
      sent.confirmEmail.toLowerCase() !== EMAIL ||
      sent.confirmPhrase.toLowerCase() !== "delete my account"
    )
      return problem(
        422,
        "ACCOUNT_DELETION_NOT_CONFIRMED",
        "That isn't the email address you sign in with.",
      );
    const deleteAfter = sent.immediate
      ? "2026-11-25T10:00:00.000Z"
      : "2026-12-09T10:00:00.000Z";
    server.scheduled = { requestedAt: "2026-11-25T10:00:00.000Z", deleteAfter };
    return new Response(
      JSON.stringify(
        RequestAccountDeletionResponse.parse({
          status: "scheduled",
          ...server.scheduled,
        }),
      ),
      { status: 202, headers: { "content-type": "application/json" } },
    );
  }
  if (path === CANCEL && method === "POST") {
    const key = headers.get("idempotency-key");
    CancelAccountDeletionHeader.parse({ "Idempotency-Key": key });
    cancels.push(key);
    server.scheduled = null;
    server.pendingEverywhere = false;
    return checked(CancelAccountDeletionResponse, { status: "none" });
  }
  // While it waits, who the person is still answers (their organizations, their own record), as
  // the server answers it; everything else is refused.
  if (
    server.pendingEverywhere &&
    // Asked as nobody (no cookies), a request is nobody's to refuse.
    init?.credentials !== "omit" &&
    path !== "/api/v2/people/me/organizations" &&
    !/^\/api\/v2\/organizations\/[^/]+\/people\/me$/.test(path)
  )
    return problem(403, "ACCOUNT_PENDING_DELETION", PENDING_SAID);
  if (path === "/api/v2/organizations/default/deployment")
    return Response.json({
      generativeUi: true,
      selfHostBanner: false,
      localEvaluation: server.edition === "personal",
      edition: server.edition,
      authProviders: server.providers,
      hostedSignIn: false,
      ssoConfigured: false,
      ssoRequired: false,
    });
  if (path === "/api/v2/people/me/organizations" && method === "GET")
    return checked(ListOrganizationsResponse, {
      organizations: ORGANIZATIONS.map((one) => ({
        ...one,
        role: "owner",
        active: one.id === server.active,
      })),
      canCreate: true,
      nextCursor: null,
    });
  if (path === "/api/auth/organization/set-active" && method === "POST") {
    server.active = (body as { organizationId: string }).organizationId;
    return Response.json({ id: server.active });
  }
  const addressed = /^\/api\/v2\/organizations\/([^/]+)\/(.+)$/.exec(path);
  if (addressed) {
    const [, organization, rest] = addressed;
    if (rest === "members/me" && method === "DELETE") {
      server.blockers = server.blockers.filter(
        (one) => one.organizationId !== organization,
      );
      return new Response(null, { status: 204 });
    }
    if (rest === "people/me")
      return Response.json({
        person: {
          id: "dana",
          email: EMAIL,
          name: "Dana Fresh",
          needsName: false,
          image: null,
          role: "owner",
          onboarding: null,
          providers: server.signedInWith,
          lastSignedInAt: null,
          revoked: false,
          configuredAdmin: false,
        },
        openbotVersion: null,
      });
  }
  return Response.json({ error: "not served" }, { status: 404 });
}

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const originalDeps = { ...pendingPageDeps };
const originalReauthentication = { ...reauthenticationDeps };

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://openbot.invalid/" });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
beforeEach(() => {
  server = {
    active: "org_dana",
    blockers: [],
    scheduled: null,
    refuse: null,
    pendingEverywhere: false,
    older: false,
    edition: "team",
    providers: [],
    signedInWith: [],
  };
  started = [];
  reauthenticationDeps.start = async (input) => {
    started.push(input);
    return {};
  };
  reauthenticationDeps.origin = () => "http://openbot.invalid";
  requests = [];
  deletions = [];
  cancels = [];
  opened = [];
  pendingPageDeps.openHome = () => opened.push("/");
  pendingPageDeps.openSignIn = () => opened.push("/sign");
  window.sessionStorage.clear();
  clearPendingDeletion();
  setCurrentOrganization(undefined);
  queryClient.clear();
  globalThis.fetch = Object.assign(answer, {
    preconnect: originalFetch.preconnect,
  });
});
afterEach(() => {
  cleanup();
  clearPendingDeletion();
  queryClient.clear();
  globalThis.fetch = originalFetch;
  Object.assign(pendingPageDeps, originalDeps);
  Object.assign(reauthenticationDeps, originalReauthentication);
});
afterAll(async () => {
  await settleReactWork();
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
  setCurrentOrganization("default");
});

/**
 * General settings' Delete account section, inside the gates the signed-in app has: the pending
 * page in place of everything, the hand-on from sign-in, and the router's error page.
 */
async function open(start = "/settings") {
  await signedInUser(queryClient);
  const rootRoute = createRootRoute({
    component: () => (
      <PendingDeletionGate>
        <ResumeAccountDeletion />
        <main>
          <Outlet />
        </main>
        <Toaster />
      </PendingDeletionGate>
    ),
  });
  const at = (path: string, component: () => ReactNode) =>
    createRoute({ getParentRoute: () => rootRoute, path, component });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [start] }),
    defaultErrorComponent: ReportedErrorComponent,
    routeTree: rootRoute.addChildren([
      at("/", () => <p>Home</p>),
      at("/sign", () => <p>Sign in</p>),
      at("/settings/organization", () => <p>Organization settings</p>),
      at("/settings", () => (
        <PageShell title="General">
          <DeleteAccountSection />
        </PageShell>
      )),
    ]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  const person = userEvent.setup({ document });
  return { view, router, person };
}

type App = Awaited<ReturnType<typeof open>>;

/** Opens the dialog and confirms with what is typed. */
async function confirmIn(
  app: App,
  email = EMAIL,
  phrase = "delete my account",
) {
  await app.person.click(
    await app.view.findByRole("button", { name: "Delete account" }),
  );
  const dialog = await app.view.findByRole("dialog", {
    name: "Delete your account?",
  });
  const later = within(dialog).getByRole("button", {
    name: "Delete in 14 days",
  });
  const now = within(dialog).getByRole("button", { name: "Delete now" });
  // Nothing to press until both are typed.
  expect(later.hasAttribute("disabled")).toBe(true);
  expect(now.hasAttribute("disabled")).toBe(true);
  await app.person.type(
    within(dialog).getByLabelText("Type your email address"),
    email,
  );
  expect(later.hasAttribute("disabled")).toBe(true);
  await app.person.type(
    within(dialog).getByLabelText("Type delete my account"),
    phrase,
  );
  return { dialog, later, now };
}

describe("deleting your account", () => {
  test("the organizations that stop it are listed with what to do, and leaving one clears it", async () => {
    server.blockers = [ACME, GLOBEX];
    const app = await open();
    const acme = (await app.view.findByText("Acme")).closest(
      "[data-slot=item]",
    ) as HTMLElement;
    expect(acme.textContent).toContain(
      "You're its only owner: make someone else an owner, or delete the organization.",
    );
    expect(
      within(acme).getByRole("button", { name: "Open its settings" }),
    ).toBeTruthy();
    const globex = app.view
      .getByText("Globex")
      .closest("[data-slot=item]") as HTMLElement;
    expect(globex.textContent).toContain("Leave this organization first.");
    // Nothing to delete while they stand.
    expect(
      app.view
        .getByRole("button", { name: "Delete account" })
        .hasAttribute("disabled"),
    ).toBe(true);

    await app.person.click(
      within(globex).getByRole("button", { name: "Leave organization" }),
    );
    const leave = await app.view.findByRole("dialog", {
      name: "Leave Globex?",
    });
    await app.person.click(
      within(leave).getByRole("button", { name: "Leave" }),
    );
    await waitFor(() => expect(app.view.queryByText("Globex")).toBeNull());
    expect(requests).toContain(
      "DELETE /api/v2/organizations/org_globex/members/me",
    );
    // The one left is an organization of their own to sort out: its settings open, in it.
    await app.person.click(
      app.view.getByRole("button", { name: "Open its settings" }),
    );
    await waitFor(() =>
      expect(app.router.state.location.pathname).toBe("/settings/organization"),
    );
    expect(server.active).toBe("org_acme");
    expect(currentOrganizationId()).toBe("org_acme");
  });

  test("the only admin of an organization with no owner is sent to its settings to make someone else an admin", async () => {
    // A self-hosted OpenBot's one organization is run by its admins, and has no owner.
    server.blockers = [{ ...ACME, reason: "only_admin" }];
    const app = await open();
    const acme = (await app.view.findByText("Acme")).closest(
      "[data-slot=item]",
    ) as HTMLElement;
    expect(acme.textContent).toContain(
      "You're its only admin: make someone else an admin.",
    );
    expect(
      within(acme).queryByRole("button", { name: "Leave organization" }),
    ).toBeNull();
    expect(
      app.view
        .getByRole("button", { name: "Delete account" })
        .hasAttribute("disabled"),
    ).toBe(true);
    await app.person.click(
      within(acme).getByRole("button", { name: "Open its settings" }),
    );
    await waitFor(() =>
      expect(app.router.state.location.pathname).toBe("/settings/organization"),
    );
  });

  test("in 14 days: confirmed with the email and the phrase, then only the page that says when, and Cancel deletion gives it back", async () => {
    const app = await open();
    // Typed as a person might: other case, spaces around.
    const { later } = await confirmIn(
      app,
      " Dana@Example.com ",
      "Delete my account",
    );
    await waitFor(() => expect(later.hasAttribute("disabled")).toBe(false));
    await app.person.click(later);

    const heading = await app.view.findByRole("heading", { level: 1 });
    expect(heading.textContent).toBe(
      `Your account will be deleted on ${new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(new Date("2026-12-09T10:00:00.000Z"))}.`,
    );
    // Nothing of the app is left on screen.
    expect(app.view.queryByRole("main")).toBeNull();
    expect(deletions).toHaveLength(1);
    expect(deletions[0]?.body).toEqual({
      confirmEmail: "Dana@Example.com",
      confirmPhrase: "Delete my account",
    });
    expect(deletions[0]?.key).toMatch(/^[0-9a-f]{32}$/);

    await app.person.click(
      app.view.getByRole("button", { name: "Cancel deletion" }),
    );
    await waitFor(() => expect(opened).toEqual(["/"]));
    expect(cancels).toHaveLength(1);
    expect(cancels[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(server.scheduled).toBeNull();
  });

  test("now: deleted at once, then signed out and sent to sign-in", async () => {
    const app = await open();
    const { now } = await confirmIn(app);
    await waitFor(() => expect(now.hasAttribute("disabled")).toBe(false));
    await app.person.click(now);
    await waitFor(() => expect(opened).toEqual(["/sign"]));
    expect(deletions[0]?.body).toEqual({
      confirmEmail: EMAIL,
      confirmPhrase: "delete my account",
      immediate: true,
    });
    expect(requests).toContain("POST /api/auth/sign-out");
  });

  test("a sign-in that is too old signs in again at its provider, never signed out, and comes back to the dialog", async () => {
    server.refuse = "reauthenticate";
    server.providers = ["google", "okta"];
    server.signedInWith = ["okta"];
    const app = await open();
    const { dialog, later } = await confirmIn(app);
    await app.person.click(later);
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "To delete your account, sign in again first.",
    );
    await app.person.click(
      within(dialog).getByRole("button", { name: "Sign in again" }),
    );
    // A new sign-in at the provider they used, which it is asked to make them do again
    // (OpenID Connect prompt=login, max_age=0), as the same person, back to General settings.
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toEqual({
      provider: "okta",
      callbackURL: "http://openbot.invalid/settings",
      loginHint: EMAIL,
      additionalParams: { prompt: "login", max_age: "0" },
    });
    // Not signed out: OpenBot's sign-out would sign them out of their company's sign-in too, whose
    // page doesn't send them back.
    expect(requests).not.toContain("POST /api/auth/sign-out");
    expect(
      window.sessionStorage.getItem("openbot-delete-account-resume"),
    ).toBeTruthy();
    cleanup();

    // Back from the provider, General settings opens the dialog again.
    queryClient.clear();
    setCurrentOrganization(undefined);
    const back = await open("/settings");
    expect(
      await back.view.findByRole("dialog", { name: "Delete your account?" }),
    ).toBeTruthy();
  });

  test("Google is asked to choose the account again, which it takes in place of prompt=login", async () => {
    server.refuse = "reauthenticate";
    server.providers = ["google"];
    server.signedInWith = ["google"];
    const app = await open();
    const { dialog, later } = await confirmIn(app);
    await app.person.click(later);
    await app.person.click(
      await within(dialog).findByRole("button", { name: "Sign in again" }),
    );
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.additionalParams).toEqual({
      prompt: "select_account",
      max_age: "0",
    });
  });

  test("a sign-in that is too old, with no provider to sign in again at, is signed out to sign in again, and back in the dialog", async () => {
    server.refuse = "reauthenticate";
    const app = await open();
    const { dialog, later } = await confirmIn(app);
    await app.person.click(later);
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "To delete your account, sign in again first.",
    );
    await app.person.click(
      within(dialog).getByRole("button", { name: "Sign in again" }),
    );
    await waitFor(() =>
      expect(app.router.state.location.pathname).toBe("/sign"),
    );
    expect(requests).toContain("POST /api/auth/sign-out");
    cleanup();

    // Signed in again, the app lands at home and takes them on to the dialog, once.
    queryClient.clear();
    setCurrentOrganization(undefined);
    const back = await open("/");
    expect(
      await back.view.findByRole("dialog", { name: "Delete your account?" }),
    ).toBeTruthy();
    expect(back.router.state.location.pathname).toBe("/settings");
    cleanup();
    queryClient.clear();
    setCurrentOrganization(undefined);
    const again = await open("/");
    await again.view.findByText("Home");
    expect(again.view.queryByRole("dialog")).toBeNull();
  });

  test("a sign-in from long ago doesn't open it", async () => {
    resumeDeletionAfterSignIn();
    const kept = Number(
      window.sessionStorage.getItem("openbot-delete-account-resume"),
    );
    window.sessionStorage.setItem(
      "openbot-delete-account-resume",
      String(kept - 31 * 60_000),
    );
    const app = await open("/");
    await app.view.findByText("Home");
    expect(app.router.state.location.pathname).toBe("/");
  });

  test("an organization that blocks it on the way closes the dialog, and the section lists it", async () => {
    server.refuse = "blocked";
    const app = await open();
    const { later } = await confirmIn(app);
    await app.person.click(later);
    await waitFor(() => expect(app.view.queryByRole("dialog")).toBeNull());
    expect(await app.view.findByText("Acme")).toBeTruthy();
    expect(server.scheduled).toBeNull();
  });

  test("an account scheduled to be deleted is refused everywhere: the router's page says when, and cancels", async () => {
    server.scheduled = {
      requestedAt: "2026-11-25T10:00:00.000Z",
      deleteAfter: "2026-12-09T10:00:00.000Z",
    };
    server.pendingEverywhere = true;
    const rootRoute = createRootRoute({
      // Who they are answers; the first screen's own read is refused.
      beforeLoad: async () => {
        await signedInUser(queryClient);
        await getDeployment("org_dana", { fallback: "Could not load." });
      },
      component: () => <p>The app</p>,
    });
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      defaultErrorComponent: ReportedErrorComponent,
      routeTree: rootRoute,
    });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    );
    const heading = await view.findByRole("heading", { level: 1 });
    await waitFor(() => expect(heading.textContent).toContain("December"));
    expect(view.queryByText("The app")).toBeNull();
    expect(view.getByRole("button", { name: "Sign out" })).toBeTruthy();
    // Refused for it is an answer: asked once, never again.
    expect(
      requests.filter(
        (one) => one === "GET /api/v2/organizations/org_dana/deployment",
      ),
    ).toHaveLength(1);
    await userEvent
      .setup({ document })
      .click(view.getByRole("button", { name: "Cancel deletion" }));
    await waitFor(() => expect(opened).toEqual(["/"]));
  });

  test("waiting out the 14 days, Delete now on the pending page: confirmed as in Settings, deleted at once, then sent to sign-in", async () => {
    server.scheduled = {
      requestedAt: "2026-11-25T10:00:00.000Z",
      deleteAfter: "2026-12-09T10:00:00.000Z",
    };
    server.pendingEverywhere = true;
    const app = await open("/");
    showPendingDeletion({ deleteAfter: "2026-12-09T10:00:00.000Z" });
    await app.person.click(
      await app.view.findByRole("button", { name: "Delete now" }),
    );
    const dialog = await app.view.findByRole("dialog", {
      name: "Delete your account now?",
    });
    expect(dialog.textContent).toContain(
      "Your account is deleted straight away, and you can't undo it.",
    );
    // Now, and nothing else: no Delete in 14 days for somebody already waiting.
    expect(
      within(dialog).queryByRole("button", { name: "Delete in 14 days" }),
    ).toBeNull();
    const now = within(dialog).getByRole("button", { name: "Delete now" });
    expect(now.hasAttribute("disabled")).toBe(true);
    await app.person.type(
      within(dialog).getByLabelText("Type your email address"),
      EMAIL,
    );
    await app.person.type(
      within(dialog).getByLabelText("Type delete my account"),
      "delete my account",
    );
    await waitFor(() => expect(now.hasAttribute("disabled")).toBe(false));
    await app.person.click(now);
    await waitFor(() => expect(opened).toEqual(["/sign"]));
    expect(deletions[0]?.body).toEqual({
      confirmEmail: EMAIL,
      confirmPhrase: "delete my account",
      immediate: true,
    });
    expect(requests).toContain("POST /api/auth/sign-out");
  });

  test("a sign-in too old to delete now from the pending page signs in again at its provider, and comes back to it with the dialog open", async () => {
    server.scheduled = {
      requestedAt: "2026-11-25T10:00:00.000Z",
      deleteAfter: "2026-12-09T10:00:00.000Z",
    };
    server.pendingEverywhere = true;
    server.refuse = "reauthenticate";
    server.providers = ["okta"];
    server.signedInWith = ["okta"];
    const app = await open("/");
    showPendingDeletion({ deleteAfter: "2026-12-09T10:00:00.000Z" });
    await app.person.click(
      await app.view.findByRole("button", { name: "Delete now" }),
    );
    const dialog = await app.view.findByRole("dialog", {
      name: "Delete your account now?",
    });
    await app.person.type(
      within(dialog).getByLabelText("Type your email address"),
      EMAIL,
    );
    await app.person.type(
      within(dialog).getByLabelText("Type delete my account"),
      "delete my account",
    );
    await app.person.click(
      within(dialog).getByRole("button", { name: "Delete now" }),
    );
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "To delete your account, sign in again first.",
    );
    await app.person.click(
      within(dialog).getByRole("button", { name: "Sign in again" }),
    );
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({
      provider: "okta",
      loginHint: EMAIL,
      additionalParams: { prompt: "login", max_age: "0" },
    });
    expect(requests).not.toContain("POST /api/auth/sign-out");
    cleanup();
    clearPendingDeletion();

    // Back from the provider: still waiting, so the pending page, with the dialog open again.
    queryClient.clear();
    setCurrentOrganization(undefined);
    // As the signed-in gate finds it, before anything of the app draws (routes/_authed.tsx).
    showPendingDeletion({ deleteAfter: "2026-12-09T10:00:00.000Z" });
    const back = await open("/settings");
    expect(
      await back.view.findByRole("dialog", {
        name: "Delete your account now?",
      }),
    ).toBeTruthy();
  });

  test("an OpenBot older than deleting an account shows nothing for it", async () => {
    server.older = true;
    const app = await open();
    await waitFor(() => expect(requests).toContain(`GET ${DELETION}`));
    await settleReactWork();
    expect(app.view.queryByText("Delete account")).toBeNull();
  });

  test("the personal edition, with no account to delete, never asks: not on the way in, not in Settings", async () => {
    server.edition = "personal";
    // The signed-in gate (routes/_authed.tsx), as every page is opened.
    expect(await scheduledDeletion(queryClient)).toBeUndefined();
    const app = await open();
    await waitFor(() =>
      expect(requests).toContain(
        "GET /api/v2/organizations/default/deployment",
      ),
    );
    await settleReactWork();
    expect(app.view.queryByText("Delete account")).toBeNull();
    expect(requests.filter((one) => one.includes(DELETION))).toEqual([]);
  });
});

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { afterAll, afterEach, expect, test } from "bun:test";
import type { ReactNode } from "react";

/**
 * The deployment's own Templates screen: who may install, where files may be read from, and what has
 * been imported.
 *
 * THE PROPERTY THIS FILE EXISTS FOR is that the screen offers no way to grant anything. It renders a
 * ledger of what templates ASKED for — including the author's sentence, verbatim — and the only
 * write on it is Retract. Granting one of those asks happens on the coworker's own page, through the
 * route that reads the live grant tables and refuses an ask this deployment cannot satisfy. A Grant
 * button appearing here would be a second path to a permission with a second set of checks, which is
 * the one thing this feature does not have, and it is the kind of thing added in good faith by
 * somebody who thought the screen looked incomplete.
 *
 * The second property is the environment floor. `OPENBOT_TEMPLATE_INSTALLERS` sets a value an
 * administrator may raise and may not lower, and a disabled control with no explanation reads as a
 * broken screen rather than as a deployment decision — the `INITIAL_ADMIN_EMAILS` pattern.
 *
 * NO MODULE MOCKS, for the reason every other browser-side file here records: `mock.module` in bun
 * is process-wide and does not come back.
 */
if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
}
const { cleanup, render, screen, waitFor } = await import(
  "@testing-library/react"
);

const IMPORT = {
  id: "11111111-1111-1111-1111-111111111111",
  agentId: "agent_renewal",
  agentName: "Renewal Desk",
  digest: "a".repeat(64),
  slug: "renewal-desk",
  templateVersion: "1.3",
  authorClaim: "acme-revops",
  source: "gallery",
  sourceRef: "renewal-desk",
  importedBy: "someone@example.test",
  importedAt: "2026-08-30T10:00:00.000Z",
  requests: [
    {
      importId: "11111111-1111-1111-1111-111111111111",
      kind: "mcp",
      ref: "google-drive/search_files",
      why: "The ledger lives in Drive.",
      status: "requested",
      decidedBy: null,
      decidedAt: null,
    },
  ],
  boundaries: [
    {
      importId: "11111111-1111-1111-1111-111111111111",
      agentId: "agent_renewal",
      expression: 'bot.id == "agent_renewal" && (intent == "run_command")',
      sourceKey: "shell",
      appliedAt: "2026-08-30T10:00:00.000Z",
      removedAt: null,
    },
  ],
};

const OPEN_SETTINGS = {
  installers: "anyone",
  floor: "anyone",
  allowedSources: ["jerelvelarde/awesome-openbot-templates"],
  sources: [],
  configured: true,
};

let servedSettings: unknown = OPEN_SETTINGS;
let servedImports: unknown[] = [IMPORT];

afterEach(() => {
  cleanup();
  servedSettings = OPEN_SETTINGS;
  servedImports = [IMPORT];
});

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const path = typeof input === "string" ? input : String(input);
  if (path === "/api/admin/templates/settings") {
    return Response.json(servedSettings);
  }
  if (path === "/api/admin/templates/imports") {
    return Response.json({ imports: servedImports });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}) as typeof fetch;

const { Route } = await import("@/routes/_authed/admin/templates");
const TemplatesPage = Route.options.component;
if (!TemplatesPage) {
  throw new Error("The templates route has no component to render.");
}

function routed(node: ReactNode) {
  const rootRoute = createRootRoute({ component: Outlet });
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => node,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/boundaries",
      component: () => null,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return <RouterProvider router={router as never} />;
}

async function renderTemplates() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    routed(
      <QueryClientProvider client={client}>
        <TemplatesPage />
      </QueryClientProvider>,
    ),
  );
  await waitFor(() =>
    expect(screen.getByText("Who may install")).toBeDefined(),
  );
}

test("an import is listed by the coworker it became, with the claim labelled as one", async () => {
  await renderTemplates();
  await screen.findByText("Renewal Desk");

  const body = document.body.textContent ?? "";
  expect(body).toContain("author claim acme-revops");
  expect(body).toContain("From the gallery");
  expect(body).toContain("someone@example.test");
  // The summary states the current answer rather than the field's name.
  expect(body).toContain("1 ask, 1 unanswered.");
  expect(body).toContain("1 clause in force.");
});

/*
 * The dialog's CONTENT is asserted server-side, not here.
 *
 * What it shows — the ask, the author's sentence, the compiled clause — is held down by
 * `server/tests/template-gallery-routes.integration.test.ts`, against the payload this screen
 * renders. It is not asserted through the screen because the detail is a dialog, and a dialog is a
 * portal: `bun test` runs every file in one process, some of the app's module graph decides at
 * module scope whether it has a browser at all, and whichever file loads that graph first decides it
 * for everybody. The dialog opens correctly in a browser and refused to mount here whenever
 * `router.test.ts` was walked first. What this file can assert without depending on any of that is
 * that the row is a button, which is what opens it.
 */
test("every import in the list is a button, which is what opens that detail", async () => {
  await renderTemplates();
  const row = await screen.findByRole("button", { name: /Renewal Desk/ });
  expect(row.tagName).toBe("BUTTON");
});

test("the environment's floor disables the setting and says which variable set it", async () => {
  servedSettings = { ...OPEN_SETTINGS, installers: "admin", floor: "admin" };
  await renderTemplates();

  /*
   * `aria-disabled` rather than the `disabled` attribute: Base UI's Switch renders a button and
   * marks it disabled for assistive technology, which is the state a person actually meets. A test
   * reading the native attribute passes on a control that is still clickable.
   */
  const toggle = await screen.findByLabelText("Administrators only");
  expect(toggle.getAttribute("aria-disabled")).toBe("true");
  expect(document.body.textContent ?? "").toContain(
    "OPENBOT_TEMPLATE_INSTALLERS set this",
  );
});

test("an empty allowlist says nothing is fetched, and offers nothing to register", async () => {
  servedSettings = { ...OPEN_SETTINGS, allowedSources: [] };
  await renderTemplates();
  await screen.findByText("Where templates may be read from");

  expect(document.body.textContent ?? "").toContain(
    "OPENBOT_TEMPLATE_SOURCES ships empty",
  );
  expect(screen.queryByText("Register a source")).toBeNull();
});

test("with an allowlist and nothing registered, it names what is permitted", async () => {
  await renderTemplates();
  await screen.findByText("Where templates may be read from");

  const body = document.body.textContent ?? "";
  expect(body).toContain("Nothing is registered, so nothing is fetched.");
  expect(body).toContain("jerelvelarde/awesome-openbot-templates");
  expect(screen.queryByText("Register a source")).not.toBeNull();
});

test("no coworker from a template says so rather than showing an empty card", async () => {
  servedImports = [];
  await renderTemplates();
  await waitFor(() =>
    expect(
      (document.body.textContent ?? "").includes(
        "No coworker here came from a template.",
      ),
    ).toBe(true),
  );
});

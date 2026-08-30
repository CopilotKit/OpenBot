import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, expect, test } from "bun:test";

/**
 * The consent ledger, after the consent screen has gone.
 *
 * The property under test is which rows offer a Grant button. A row is `unavailable` when the
 * connector is not connected here and `not_in_build` when no component answers to that name, and the
 * server refuses to grant either — so offering the button was offering an act that could only end in
 * an error message, on the one screen an administrator uses to warm a cold Bot up. Declining stays
 * on every row, because recording that somebody said no is a real decision whatever this deployment
 * happens to have installed.
 *
 * The admin gate here is a hint for the screen and decides nothing; `requireAdmin` on the decide
 * route is the refusal. It is still worth pinning that a non-admin is not shown buttons that would
 * only be refused.
 *
 * NO MODULE MOCKS. `mock.module` in bun is process-wide and does not come back. The transport is
 * stubbed at `fetch` and restored afterwards.
 */
/*
 * Guarded, because `register` throws outright on a second call and bun walks every test file into
 * one process. Whichever DOM test file the walk reaches first installs the window; the rest find it
 * already there. Registering unconditionally made the second such file throw during import, which
 * takes its whole suite with it and reports nothing.
 */
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
/*
 * A DOM before Testing Library. `screen` binds its queries to `document.body` at import time, so a
 * static import would be hoisted above the line above and bind to nothing.
 */
const { cleanup, render, screen, waitFor } = await import(
  "@testing-library/react"
);

const AGENT = "agent-1";

/** One row of each unmet status, as the ledger route hands them over. */
const REQUESTS = [
  {
    importId: "import-1",
    kind: "mcp",
    ref: "jira/create_issue",
    why: "Raising the ticket is the point of the skill.",
    status: "requested",
    decidedBy: null,
    decidedAt: null,
  },
  {
    importId: "import-1",
    kind: "mcp",
    ref: "zendesk/search_tickets",
    why: "Reads the ticket the invoice is disputed on.",
    status: "unavailable",
    decidedBy: null,
    decidedAt: null,
  },
  {
    importId: "import-1",
    kind: "component",
    ref: "showBarChart",
    why: "Ageing buckets.",
    status: "not_in_build",
    decidedBy: null,
    decidedAt: null,
  },
];

let role: "admin" | "user" = "admin";

afterEach(() => {
  cleanup();
  role = "admin";
});

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const path = typeof input === "string" ? input : input.toString();
  if (path === "/api/me") {
    return Response.json({
      user: { id: "u1", email: "a@example.com", role },
    });
  }
  if (path === `/api/templates/imports/${AGENT}`) {
    return Response.json({
      import: {
        id: "import-1",
        agentId: AGENT,
        digest: "a".repeat(64),
        slug: "renewal-desk",
        templateVersion: "1.3",
        authorClaim: "acme-revops",
        source: "paste",
        sourceRef: null,
        document: {},
        importedBy: "u1",
        importedAt: "2026-08-30T10:00:00.000Z",
      },
      requests: REQUESTS,
      boundaries: [],
    });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}) as typeof fetch;

const { TemplateRequests } = await import(
  "@/components/agents/template-requests"
);

async function renderLedger() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TemplateRequests agentId={AGENT} />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(screen.getByText("jira/create_issue")).toBeDefined(),
  );
}

/** Each row's own controls, found through the `<li>` its reference is in. */
function row(ref: string): HTMLElement {
  const anchor = screen.getByText(ref).closest("li");
  if (!anchor) throw new Error(`No row on screen for ${ref}.`);
  return anchor;
}

function buttons(ref: string): string[] {
  return [...row(ref).querySelectorAll("button")].map(
    (button) => button.textContent ?? "",
  );
}

test("a row this deployment can satisfy is offered a grant", async () => {
  await renderLedger();

  expect(buttons("jira/create_issue")).toEqual(["Grant", "Decline"]);
});

/**
 * The regression: `grantable` looked at the kind and the shape of the reference and not at status.
 *
 * So an ask the server had already recorded as unsatisfiable — no such connector here, no such
 * component in this build — was still offered a Grant button that could only be refused.
 */
test("a row nothing here can satisfy is not offered a grant", async () => {
  await renderLedger();

  expect(buttons("zendesk/search_tickets")).toEqual(["Decline"]);
  expect(buttons("showBarChart")).toEqual(["Decline"]);

  // And the row says what would unblock it instead of showing a button that cannot work.
  expect(row("zendesk/search_tickets").textContent).toContain(
    "Connect it on the Plugins page first",
  );
  expect(row("showBarChart").textContent).toContain(
    "A build carrying that component is what unblocks this",
  );
});

test("somebody who cannot decide is shown no decision at all", async () => {
  role = "user";
  await renderLedger();

  expect(document.querySelectorAll("button").length).toBe(0);
  expect(document.body.textContent ?? "").toContain(
    "An administrator decides each of these.",
  );
});

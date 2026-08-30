import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, expect, test } from "bun:test";

/**
 * How the template family reads on the audit page.
 *
 * The bug this pins: nine event types were added to the closed list in `server/src/audit.ts` and
 * this screen, which has to agree about that list, was not told. Every one of them fell through to
 * the fallback that calls an unrecognised type "Allowed" — so `template.import_refused`, the row an
 * investigator opens this page to find, said the deployment had allowed the document it turned
 * away, in the muted foreground rather than the refusal colour. That is the one wrong answer, and a
 * trail that is confidently wrong is worse than a silent one.
 *
 * Rendered rather than unit-tested against a lookup table, because the fallback is the thing under
 * test: a table that knows nothing still prints a word, and only the rendered cell shows which.
 *
 * NO MODULE MOCKS. `mock.module` in bun is process-wide and does not come back, so mocking
 * `@/lib/client` here would change what every other file in the suite imports. The transport is
 * stubbed at `fetch` and restored afterwards.
 */
/*
 * Registered only when nothing else has already done it.
 *
 * `register()` throws outright when a DOM is installed, and bun runs the app tests in one process,
 * so whichever browser-side file loads second used to take the whole suite down with "Happy DOM has
 * already been globally registered" — a failure that says nothing about the code under test and
 * moves depending on which file the runner happened to reach first.
 */
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
/*
 * A DOM before Testing Library. `screen` binds its queries to `document.body` at import time, so a
 * static import would be hoisted above the line above and bind to nothing.
 */
const { cleanup, render, screen, waitFor } = await import(
  "@testing-library/react"
);
const userEvent = (await import("@testing-library/user-event")).default;

const DIGEST = "9f2c1ab77d3e";

/** One row of each shape the template family writes, as the API hands them over. */
const EVENTS = [
  {
    id: "1",
    actorUserId: null,
    eventType: "template.import_refused",
    targetType: "template",
    targetId: DIGEST,
    payload: {
      reason: "secret_shape",
      field: "bot.roleDescription",
      slug: "renewal-desk",
      digest: DIGEST,
    },
    createdAt: "2026-08-30T10:00:00.000Z",
  },
  {
    id: "2",
    actorUserId: null,
    eventType: "template.capability_declined",
    targetType: "agent",
    targetId: "agent-1",
    payload: {
      bot: "agent-1",
      importId: "import-1",
      kind: "connector",
      ref: "jira",
    },
    createdAt: "2026-08-30T10:01:00.000Z",
  },
  {
    id: "3",
    actorUserId: null,
    eventType: "template.capability_requested",
    targetType: "agent",
    targetId: "agent-1",
    payload: { kind: "component", ref: "invoice-lookup", status: "unmet" },
    createdAt: "2026-08-30T10:02:00.000Z",
  },
  {
    id: "4",
    actorUserId: null,
    eventType: "template.exported",
    targetType: "agent",
    targetId: "agent-1",
    payload: { templateSlug: "renewal-desk", digest: DIGEST, stripped: [] },
    createdAt: "2026-08-30T10:03:00.000Z",
  },
  {
    id: "5",
    actorUserId: null,
    eventType: "template.imported",
    targetType: "agent",
    targetId: "agent-1",
    payload: { templateSlug: "renewal-desk", digest: DIGEST, source: "paste" },
    createdAt: "2026-08-30T10:04:00.000Z",
  },
  {
    id: "6",
    actorUserId: null,
    eventType: "template.capability_granted",
    targetType: "agent",
    targetId: "agent-1",
    payload: { bot: "agent-1", kind: "connector", ref: "zendesk" },
    createdAt: "2026-08-30T10:05:00.000Z",
  },
  {
    id: "7",
    actorUserId: null,
    eventType: "template.boundary_applied",
    targetType: "agent",
    targetId: "agent-1",
    payload: { templateSlug: "renewal-desk", clauses: ["shell == 'never'"] },
    createdAt: "2026-08-30T10:06:00.000Z",
  },
  {
    id: "8",
    actorUserId: null,
    eventType: "template.boundary_removed",
    targetType: "agent",
    targetId: "agent-1",
    payload: { importId: "import-1", clauses: ["shell == 'never'"] },
    createdAt: "2026-08-30T10:07:00.000Z",
  },
  {
    id: "9",
    actorUserId: null,
    eventType: "template.retracted",
    targetType: "agent",
    targetId: "agent-1",
    payload: { importId: "import-1", revoked: [], boundaries: 1 },
    createdAt: "2026-08-30T10:08:00.000Z",
  },
];

/*
 * Testing Library's automatic cleanup hooks into a global `afterEach` that bun does not provide, so
 * without this every test renders a second audit table into the same document and `getByText` finds
 * the row twice. The failure looks like a duplicate-render bug in the page, which it is not.
 */
afterEach(cleanup);

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

/** Every path this page reads, and a record of what it asked for. */
const asked: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const path = typeof input === "string" ? input : String(input);
  asked.push(path);
  if (path.startsWith("/api/admin/audit-events")) {
    return Response.json({ events: EVENTS });
  }
  if (path.startsWith("/api/agents")) {
    return Response.json({ agents: [{ id: "agent-1", name: "Renewal Desk" }] });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}) as typeof fetch;

const { Route } = await import("@/routes/_authed/admin/audit");
const AuditPage = Route.options.component;
if (!AuditPage) throw new Error("The audit route has no component to render.");

function renderAuditPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AuditPage />
    </QueryClientProvider>,
  );
}

test("no template row claims the deployment allowed it", async () => {
  renderAuditPage();
  await waitFor(() =>
    expect(screen.getByText("template.import_refused")).toBeDefined(),
  );

  /*
   * The whole family, in one assertion. Every row on this page is a template row, so the word
   * "Allowed" appearing anywhere in the table means the fallback caught a type this screen does not
   * know — which is what it did for all nine of them.
   */
  expect(document.body.textContent ?? "").not.toContain("Allowed");

  for (const decision of [
    "Refused, and nothing was installed",
    "A person declined this ask",
    "Asked for, and not granted here",
    "Left here as a file",
    "Installed from somebody's file",
    "A person granted this ask",
    "The template's boundary, put on this Bot",
    "The template's boundary, taken off this Bot",
    "The import was taken back",
  ]) {
    expect(screen.getByText(decision)).toBeDefined();
  }
});

test("a refused import reads as a refusal, in the refusal colour", async () => {
  renderAuditPage();
  const refusal = await screen.findByText("Refused, and nothing was installed");
  expect(refusal.className).toContain("text-destructive");

  // A decline is a person turning an ask down, and takes the same colour.
  expect(screen.getByText("A person declined this ask").className).toContain(
    "text-destructive",
  );

  /*
   * An unmet ask is not a refusal. Nothing was forbidden, so nothing here is coloured as though it
   * had been — colouring it would devalue the two rows above.
   */
  expect(
    screen.getByText("Asked for, and not granted here").className,
  ).not.toContain("text-destructive");
});

test("a refused import says which refusal it was, and about which document", async () => {
  renderAuditPage();
  await waitFor(() =>
    expect(screen.getByText("template.import_refused")).toBeDefined(),
  );

  // The code the server wrote, because it is the half that can be counted, and the field it names.
  expect(screen.getByText("secret_shape · bot.roleDescription")).toBeDefined();

  // The subject column names the document rather than showing a dash, with the bytes in the title.
  const slug = screen.getAllByText("renewal-desk")[0];
  expect(slug).toBeDefined();
  expect(slug?.getAttribute("title")).toBe(DIGEST);

  // A capability row names what was asked for, which is the only thing "declined" answers.
  expect(screen.getByText("connector: jira")).toBeDefined();
  expect(screen.getByText("component: invoice-lookup")).toBeDefined();
});

test("the Blocked filter asks the server for refused imports", async () => {
  renderAuditPage();
  await waitFor(() =>
    expect(screen.getByText("template.import_refused")).toBeDefined(),
  );

  asked.length = 0;
  await userEvent.click(screen.getByText("Blocked"));

  await waitFor(() => {
    const blocked = asked.find((path) =>
      path.startsWith("/api/admin/audit-events?"),
    );
    expect(blocked).toBeDefined();
    /*
     * The saved view a person clicks for "what did this deployment turn away". A refused import
     * leaves no Bot, no skill and no ledger row, so a filter that omits it hides the only evidence
     * the attempt was ever made.
     */
    expect(blocked).toContain("template.import_refused");
    expect(blocked).toContain("template.capability_declined");
    // The designed outcome is not a refusal and does not belong in this list.
    expect(blocked).not.toContain("template.capability_requested");
  });
});

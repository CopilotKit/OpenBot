import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * The export panel, and the press that used to dead-end on it.
 *
 * A draft is unique per author and name, so exporting one coworker twice collided with the draft the
 * first press wrote and came back refused: "you already have a template draft called X, rename one
 * of them." There is no rename control on this panel, and the draft being complained about is not
 * shown on it either — so the sentence named an act nobody could perform, at the one moment somebody
 * is trying to hand their work to somebody else.
 *
 * What is pinned here is the pair of properties that replaced it. The draft that already exists
 * comes back with the author's edits intact and the panel SAYS so, because a person who is silently
 * handed an older document will not notice. And the re-pack is a press of its own that sends the
 * file the server held back through the ordinary draft edit — never something that happens to
 * somebody's work on its way past.
 *
 * NO MODULE MOCKS. `mock.module` in bun is process-wide and does not come back, so a file that
 * mocked `@/lib/client` here would silently change what every other test file in this suite imports.
 * The transport is stubbed at `fetch` and restored afterwards.
 */
/*
 * Registered with an address, and only if nothing else has registered already.
 *
 * `register` throws outright on a second call and bun walks every test file into one process, so
 * whichever DOM file the walk reaches first installs the window and the rest find it there. The
 * address matters as much as the guard: Happy DOM defaults to `about:blank`, whose origin is the
 * STRING "null", and Better Auth throws `Invalid base URL: null` while it is still being imported.
 */
if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
}
/*
 * A DOM before Testing Library. `screen` binds its queries to `document.body` at import time, so a
 * static import would be hoisted above the line above and bind to nothing.
 */
const { cleanup, render, screen, waitFor } = await import(
  "@testing-library/react"
);
const userEvent = (await import("@testing-library/user-event")).default;

const AGENT = "agent-1";

/** The parsed document the panel inventories, which is all it reads out of the response. */
const DOCUMENT = {
  format: 1,
  template: {
    slug: "renewal-desk",
    version: "1.3",
    author: "acme-revops",
    summary: "Chases overdue invoices.",
  },
  bot: {
    name: "Renewal Desk",
    title: "Accounts Receivable",
    roleDescription: "Chase overdue invoices.",
    avatarSeed: "renewal-desk",
    runtime: "managed",
    skills: ["check-renewal-risk"],
  },
  skills: [
    {
      slug: "check-renewal-risk",
      title: "Check renewal risk",
      summary: "Pull the contract.",
      instructions: "Find the contract and read the renewal date.",
      tools: [],
    },
  ],
  requests: { connectors: [], components: [] },
  boundary: {
    shell: "never",
    files: "none",
    browser: "read_only",
    navigateHosts: [],
    mcp: "read_only",
  },
};

/** What the author has in their draft, and what a fresh pack of the coworker would say instead. */
const EDITED_YAML = "openbot_template: 1\n# edited by hand\n";
const FRESH_YAML = "openbot_template: 1\n# straight off the coworker\n";

/**
 * What the export route answers with next.
 *
 * `repack` present is the server saying it packed the coworker, found the draft already there, and
 * returned that one rather than writing over it.
 */
let served: Record<string, unknown> = {};
/** Every write this panel made, so a test can assert what was sent and what was not. */
let patched: { path: string; source: unknown }[] = [];

afterEach(() => {
  cleanup();
  served = {};
  patched = [];
});

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = typeof input === "string" ? input : input.toString();
  if (path === `/api/agents/${AGENT}/template`) {
    return Response.json(served, { status: 201 });
  }
  if (path.startsWith("/api/templates/")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { source?: unknown };
    patched.push({ path, source: body.source });
    // The server's serialisation of what it accepted, which is what the panel puts back on screen.
    return Response.json({
      yaml: `${String(body.source)}# as the server holds it\n`,
      digest: "b".repeat(64),
    });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}) as typeof fetch;

const { ExportTemplate } = await import("@/components/agents/export-template");

/** Press Export and wait for the panel the draft is on. */
async function exportOnce() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ExportTemplate agentId={AGENT} />
    </QueryClientProvider>,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Export template" }),
  );
  await waitFor(() => expect(screen.getByText("Template draft")).toBeDefined());
}

/** The file box, which this panel keeps behind a press until there is something to save. */
async function fileText(): Promise<string> {
  await userEvent.click(screen.getByRole("button", { name: "Show the file" }));
  const box = screen.getByLabelText("Template file");
  if (!(box instanceof HTMLTextAreaElement)) {
    throw new Error("The file box is not a textarea.");
  }
  return box.value;
}

test("an export that wrote the draft says nothing about re-packing", async () => {
  served = {
    templateId: "tpl_1",
    yaml: FRESH_YAML,
    digest: "a".repeat(64),
    template: DOCUMENT,
    stripped: ["agents.configuration.endpoint did not travel."],
  };

  await exportOnce();

  expect(screen.queryByText(/You had already exported/)).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Re-pack from the coworker" }),
  ).toBeNull();
  expect(await fileText()).toBe(FRESH_YAML);
});

test("a second export shows the draft that already existed, and says so", async () => {
  served = {
    templateId: "tpl_1",
    yaml: EDITED_YAML,
    digest: "a".repeat(64),
    template: DOCUMENT,
    stripped: ["agents.configuration.endpoint did not travel."],
    repack: FRESH_YAML,
  };

  await exportOnce();

  /*
   * The sentence is the point. Without it a person gets their own older document back and has no way
   * to tell it apart from the pack they just asked for.
   */
  expect(
    screen.getByText(/You had already exported this coworker/).textContent,
  ).toContain("nothing was packed over them");
  // What is on screen is the draft, not the pack the server held back.
  expect(await fileText()).toBe(EDITED_YAML);
  // And nothing was written on the way here. The edits survive because no write happened at all.
  expect(patched).toEqual([]);
});

test("re-packing is a press of its own, and it replaces the document", async () => {
  served = {
    templateId: "tpl_1",
    yaml: EDITED_YAML,
    digest: "a".repeat(64),
    template: DOCUMENT,
    stripped: [],
    repack: FRESH_YAML,
  };

  await exportOnce();
  await userEvent.click(
    screen.getByRole("button", { name: "Re-pack from the coworker" }),
  );

  // Through the ordinary draft edit, carrying the file the export handed over — so the parser and
  // the secret scanner run over it exactly as they do over anything an author types.
  await waitFor(() => expect(patched).toHaveLength(1));
  expect(patched[0]).toEqual({
    path: "/api/templates/tpl_1",
    source: FRESH_YAML,
  });

  // The offer is gone, because the draft now IS the fresh pack, and the box shows what the server
  // accepted rather than what was posted to it.
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Re-pack from the coworker" }),
    ).toBeNull(),
  );
  expect(screen.queryByText(/You had already exported/)).toBeNull();
  expect(await fileText()).toBe(`${FRESH_YAML}# as the server holds it\n`);
});

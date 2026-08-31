import { afterAll, afterEach, expect, test } from "bun:test";
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
import type { ReactNode } from "react";

/**
 * A template's own page, and the three things it exists to do.
 *
 * It is the reading surface: somebody studies a stranger's instructions here, closes the page, and
 * has changed nothing. That makes three properties worth pinning rather than reasoning about.
 *
 * THE PROSE IS UNABRIDGED. Every character of `role_description` and of every skill's
 * `instructions` is on the page. A truncation here would hide the part worth hiding something in,
 * on the screen built for reading it.
 *
 * NO ADDRESS IS A LINK. `author` and `source` are typed by whoever wrote the file and verified by
 * nobody. An honest template's `source` looks exactly like a hostile one's, so neither is clickable.
 *
 * NOTHING IS WRITTEN. The page has one control and it navigates to the consent screen. If a button
 * that installs ever appears here, the reading surface has become a second import path with none of
 * the consent screen's checks in front of it.
 *
 * NO MODULE MOCKS: `mock.module` in bun is process-wide and does not come back. The transport is
 * stubbed at `fetch` and restored afterwards.
 */
if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
}
const { cleanup, render, screen, waitFor } = await import(
  "@testing-library/react"
);

/** A long instruction, so a truncating renderer would visibly lose the end of it. */
const ROLE =
  "Chase overdue invoices and draft the follow-up. " +
  "Name every document you used. ".repeat(8) +
  "NEVER send anything yourself.";

const SKILL_INSTRUCTIONS =
  "Find the contract before answering. " + "Read it, do not guess. ".repeat(8);

const DETAIL = {
  entry: {
    slug: "renewal-desk",
    digest: "d".repeat(64),
    name: "Renewal Desk",
    title: "Accounts Receivable",
    summary: "Chases overdue invoices and drafts the follow-up.",
    avatarSeed: "renewal-desk",
    author: "acme-revops",
    version: "1.3",
    license: "Apache-2.0",
    source: "https://github.com/acme/openbot-templates",
    runtime: "managed",
    connectors: ["google-drive"],
    components: [],
    skills: ["check-renewal-risk"],
    origin: { kind: "directory", filename: "renewal-desk.openbot.yaml" },
  },
  template: {
    format: 1,
    template: {
      slug: "renewal-desk",
      summary: "Chases overdue invoices and drafts the follow-up.",
      author: "acme-revops",
      source: "https://github.com/acme/openbot-templates",
      version: "1.3",
      license: "Apache-2.0",
    },
    bot: {
      name: "Renewal Desk",
      title: "Accounts Receivable",
      roleDescription: ROLE,
      avatarSeed: "renewal-desk",
      runtime: "managed",
      skills: ["check-renewal-risk"],
    },
    skills: [
      {
        slug: "check-renewal-risk",
        title: "Check renewal risk",
        summary: "Pull the contract and the recent tickets.",
        instructions: SKILL_INSTRUCTIONS,
        tools: ["google-drive/search_files"],
      },
    ],
    requests: {
      connectors: [
        {
          id: "google-drive",
          why: "The invoice ledger lives in Drive.",
          tools: [
            { ref: "google-drive/search_files", why: "Find the ledger." },
          ],
        },
      ],
      components: [],
    },
    boundary: {
      shell: "never",
      files: "none",
      browser: "read_only",
      navigateHosts: [],
      mcp: "read_only",
    },
    notes: "Point this at whichever folder holds your contracts.",
  },
  digest: "d".repeat(64),
  yaml: "openbot_template: 1\ntemplate:\n  slug: renewal-desk\n",
};

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const path = typeof input === "string" ? input : String(input);
  if (path.startsWith("/api/templates/gallery/")) {
    return Response.json(DETAIL);
  }
  return Response.json({ error: "not found" }, { status: 404 });
}) as typeof fetch;

const { TemplateDetail } = await import(
  "@/routes/_authed/_app/agents/gallery/$slug"
);

afterEach(() => {
  cleanup();
});

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
      path: "/agents/gallery",
      component: () => null,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return <RouterProvider router={router as never} />;
}

async function renderDetail() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    routed(
      <QueryClientProvider client={client}>
        <TemplateDetail slug="renewal-desk" />
      </QueryClientProvider>,
    ),
  );
  await waitFor(() =>
    expect(screen.getByText("The instructions it carries")).toBeDefined(),
  );
}

test("the prose a model will be given is on the page in full", async () => {
  await renderDetail();

  const body = document.body.textContent ?? "";
  // The whole of it, including the last sentence a truncating renderer would drop.
  expect(body).toContain(ROLE);
  expect(body).toContain("NEVER send anything yourself.");
  // And the skill's instructions, which reach a model the same way.
  expect(body).toContain(SKILL_INSTRUCTIONS);
  expect(body).toContain(
    "This text is given to a model as instructions. It was written by a stranger.",
  );
});

test("nothing model-visible is clipped by a class that hides the end of it", async () => {
  await renderDetail();

  /*
   * Asserted against the DOM rather than trusted. `truncate` and `line-clamp-*` are one careless
   * copy-paste away on a page of prose, and either would silently hide the half of an instruction
   * worth hiding something in.
   */
  for (const box of document.querySelectorAll("pre")) {
    const className = box.getAttribute("class") ?? "";
    expect(className).not.toContain("truncate");
    expect(className).not.toContain("line-clamp");
  }
});

test("the author and the address are text, and nothing on the page links out", async () => {
  await renderDetail();

  const body = document.body.textContent ?? "";
  expect(body).toContain("Author claim");
  expect(body).toContain("acme-revops");
  expect(body).toContain("https://github.com/acme/openbot-templates");

  for (const anchor of document.querySelectorAll("a")) {
    const href = anchor.getAttribute("href") ?? "";
    expect(href.startsWith("http")).toBe(false);
    expect(anchor.textContent ?? "").not.toContain("acme");
  }
});

test("the file itself is on the page, so the reading is not only an interpretation", async () => {
  await renderDetail();
  expect(document.body.textContent ?? "").toContain("openbot_template: 1");
});

test("the ceiling is stated, and the asks carry the author's own reasons", async () => {
  await renderDetail();

  const body = document.body.textContent ?? "";
  expect(body).toContain("What it will be allowed to do");
  expect(body).toContain("The invoice ledger lives in Drive.");
  expect(body).toContain("Find the ledger.");
});

/**
 * The page reads; it does not write.
 *
 * Its one control goes to the consent screen, which is where the resolution and the only button
 * that writes anything live. A control here that installed would be a second import path with none
 * of those checks in front of it.
 */
test("the only control leads to the consent screen and nothing here installs", async () => {
  await renderDetail();

  const use = await screen.findByText("Use this template");
  expect(use.closest("a")?.getAttribute("href")).toBe(
    "/agents/gallery?use=renewal-desk",
  );

  const labels = [...document.querySelectorAll("button")].map(
    (button) => button.textContent ?? "",
  );
  expect(labels.some((label) => label.includes("Import"))).toBe(false);
  expect(labels.some((label) => label.includes("Grant"))).toBe(false);
});

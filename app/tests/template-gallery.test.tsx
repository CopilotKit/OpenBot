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
 * The gallery, and the two things it must not do with a stranger's strings.
 *
 * A template's `author` and `source` are typed by whoever wrote the file and verified by nobody.
 * They sit a centimetre from a Bot's name while somebody decides whether to trust it, which makes
 * two properties worth pinning rather than reasoning about: the address is rendered as TEXT and
 * never as an anchor, so there is nothing to click before the reader has finished reading; and the
 * word "claim" appears beside the author, so the deployment's own screen is not the one place the
 * claim reads as a fact.
 *
 * The third thing pinned here is an absence. There is no install count, no download count and no
 * rating anywhere in this feature, because nothing counts anything — a number beside a template
 * would be invented or supplied by its own author. Popularity is the strongest signal a marketplace
 * gives and this one refuses to fake it, so a test asserts the words are not on the screen: a
 * later well-meaning addition of "1.2k installs" should fail here rather than ship.
 *
 * NO MODULE MOCKS. `mock.module` in bun is process-wide and does not come back, so mocking
 * `@/lib/client` or the router here would change what every other file in the suite imports. The
 * transport is stubbed at `fetch` and restored afterwards, and the router is a real one over a
 * memory history.
 */
/*
 * Registered with an address, and only if nothing else has registered already.
 *
 * `register()` throws outright when a DOM is installed and bun walks every test file into one
 * process. The address matters separately: Happy DOM defaults to `about:blank`, whose origin is the
 * STRING "null", and Better Auth throws `Invalid base URL: null` while it is being imported.
 */
if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
}
/*
 * A DOM before Testing Library. `screen` binds its queries to `document.body` at import time, so a
 * static import would be hoisted above the registration and bind to nothing.
 */
const { cleanup, render, screen, waitFor } = await import(
  "@testing-library/react"
);

/**
 * A card whose author claim is an address, which is the hostile shape.
 *
 * `source` looking like a URL is the ordinary case rather than an attack — every honest template
 * has one — and that is exactly why it must not be a link: the reader cannot tell an honest one
 * from a hostile one by looking, so neither is clickable.
 */
const CARD = {
  slug: "renewal-desk",
  digest: "a".repeat(64),
  name: "Renewal Desk",
  title: "Accounts Receivable",
  summary: "Chases overdue invoices and drafts the follow-up.",
  author: "acme-revops",
  version: "1.3",
  license: "Apache-2.0",
  source: "https://github.com/acme/openbot-templates",
  runtime: "managed",
  connectors: ["google-drive"],
  components: [],
  skills: ["check-renewal-risk"],
  origin: { kind: "directory", filename: "renewal-desk.openbot.yaml" },
};

const SKIP = {
  where: "broken.openbot.yaml",
  reason: "unparseable",
  message: "openbot_template must be 1.",
};

let servedTemplates: unknown[] = [CARD];
let servedSkips: unknown[] = [];
let listStatus = 200;

afterEach(() => {
  cleanup();
  servedTemplates = [CARD];
  servedSkips = [];
  listStatus = 200;
});

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const path = typeof input === "string" ? input : String(input);
  if (path === "/api/templates/gallery") {
    if (listStatus !== 200) {
      return Response.json(
        { error: "The template gallery could not be read." },
        { status: listStatus },
      );
    }
    return Response.json({
      templates: servedTemplates,
      skipped: servedSkips,
      installers: "anyone",
    });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}) as typeof fetch;

const { TemplateGallery } = await import(
  "@/routes/_authed/_app/agents/gallery"
);

/** A real router over a memory history, so every `Link` on the page resolves without a mock. */
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
      path: "/agents",
      component: () => null,
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
  // The app's router is registered globally for typing; this one only has to resolve the handful of
  // paths this screen links to.
  return <RouterProvider router={router as never} />;
}

async function renderGallery() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    routed(
      <QueryClientProvider client={client}>
        <TemplateGallery onClose={() => {}} reading={null} />
      </QueryClientProvider>,
    ),
  );
  await waitFor(() => expect(screen.getByText("In the box")).toBeDefined());
}

test("a card carries the name, the claim, the summary and what it asks for", async () => {
  await renderGallery();
  await screen.findByText("Renewal Desk");

  const body = document.body.textContent ?? "";
  expect(body).toContain("Chases overdue invoices and drafts the follow-up.");
  // The word that makes the author a claim rather than a fact.
  expect(body).toContain("Author claim");
  expect(body).toContain("acme-revops");
  // What it WANTS, said as a want.
  expect(body).toContain("google-drive");
  expect(body).toContain("Nothing is granted by importing it.");
});

/**
 * The rule this screen shares with the consent screen, asserted the same way it is there: by
 * reading the DOM rather than by trusting that nobody wrote an anchor.
 */
test("the author's address is text, and there is no link to it anywhere", async () => {
  await renderGallery();
  await screen.findByText("Renewal Desk");

  expect(document.body.textContent ?? "").toContain(
    "https://github.com/acme/openbot-templates",
  );
  for (const anchor of document.querySelectorAll("a")) {
    const href = anchor.getAttribute("href") ?? "";
    expect(href.startsWith("http")).toBe(false);
    expect(anchor.textContent ?? "").not.toContain("acme");
  }
});

test("the only link off a card is the one that opens the consent screen", async () => {
  await renderGallery();
  const use = await screen.findByText("Use this template");
  expect(use.closest("a")?.getAttribute("href")).toBe(
    "/agents/gallery?use=renewal-desk",
  );
});

/**
 * The absence, asserted. A count here would be a number nothing in this feature can produce
 * honestly, and the failure mode is somebody adding one because a gallery is expected to have them.
 */
test("nothing on the page counts, rates or ranks anything", async () => {
  await renderGallery();
  await screen.findByText("Renewal Desk");

  const body = (document.body.textContent ?? "").toLowerCase();
  for (const forbidden of [
    "install",
    "download",
    "rating",
    "stars",
    "popular",
    "trending",
  ]) {
    expect(`${forbidden}: ${body.includes(forbidden)}`).toBe(
      `${forbidden}: false`,
    );
  }
});

test("a file the gallery could not read is named rather than left as an absence", async () => {
  servedSkips = [SKIP];
  await renderGallery();
  await screen.findByText("Not listed");

  const body = document.body.textContent ?? "";
  expect(body).toContain("broken.openbot.yaml");
  expect(body).toContain("openbot_template must be 1.");
  // And the template that did parse is still on the page beside it.
  expect(body).toContain("Renewal Desk");
});

test("an empty gallery says so; a failed read says something else", async () => {
  servedTemplates = [];
  await renderGallery();
  expect(
    (document.body.textContent ?? "").includes(
      "This deployment ships no templates.",
    ),
  ).toBe(true);

  cleanup();
  listStatus = 500;
  await renderGallery();
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "The template gallery could not be read.",
    ),
  );
});

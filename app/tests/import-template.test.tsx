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
import { afterAll, expect, test } from "bun:test";
import type { ReactNode } from "react";

/**
 * The consent screen, rendered.
 *
 * The section order is the property worth pinning: the whole argument of this screen is that a
 * stranger's prose comes before the capability list and the button, and an ordering is exactly the
 * kind of thing a later refactor moves without anybody noticing. So is the pair of rules underneath
 * it — that the prose is text rather than markup, and that an address the author typed is never an
 * anchor.
 *
 * NO MODULE MOCKS. `mock.module` in bun is process-wide and does not come back, so a file that
 * mocked `@/lib/client` or the router here would silently change what every other test file in the
 * suite imports — which is not hypothetical: doing it broke `plugin-grants.test.ts` and would have
 * broken `router.test.ts` on a different walk order. The transport is stubbed at `fetch`, which is
 * restored afterwards, and the router is a real one over a memory history.
 */
GlobalRegistrator.register();
/*
 * A DOM before Testing Library, and that ordering is why these two imports are dynamic. `screen`
 * binds its queries to `document.body` at import time, so a static import is hoisted above the
 * line above and binds to nothing.
 */
const { render, screen, waitFor } = await import("@testing-library/react");
const userEvent = (await import("@testing-library/user-event")).default;

const template = {
  format: 1,
  template: {
    slug: "renewal-desk",
    version: "1.3",
    author: "acme-revops",
    source: "https://github.com/acme/openbot-templates",
    summary: "Chases overdue invoices.",
    license: "Apache-2.0",
  },
  bot: {
    name: "Renewal Desk",
    title: "Accounts Receivable",
    roleDescription: "Chase overdue invoices.\n<script>alert(1)</script>",
    avatarSeed: "renewal-desk",
    runtime: "remote",
    skills: ["check-renewal-risk"],
    remote: {
      authHeader: "Authorization",
      requiresKey: true,
      exampleUrl: "https://renewals.example.com/agui",
      sendsConversationTo: "renewals.example.com",
    },
  },
  skills: [
    {
      slug: "check-renewal-risk",
      title: "Check renewal risk",
      summary: "Pull the contract.",
      instructions: "Find the contract and read the renewal date.",
      tools: ["google-drive/search_files"],
    },
  ],
  requests: {
    connectors: [
      {
        id: "google-drive",
        why: "The ledger lives in Drive.",
        tools: [{ ref: "google-drive/search_files", why: "Find the ledger." }],
      },
    ],
    components: [{ name: "showBarChart", why: "Ageing buckets." }],
  },
  boundary: {
    shell: "never",
    files: "read_only",
    browser: "read_only",
    navigateHosts: ["billing.acme.example"],
    mcp: "read_only",
  },
  notes: "Point this at your contracts folder.",
};

const plan = {
  digest: "a".repeat(64),
  connectors: [
    {
      id: "google-drive",
      why: "The ledger lives in Drive.",
      verdict: "unavailable",
      tools: [
        {
          ref: "google-drive/search_files",
          why: "Find the ledger.",
          verdict: "unavailable",
        },
      ],
    },
  ],
  components: [
    {
      name: "showBarChart",
      why: "Ageing buckets.",
      verdict: "not_in_build",
      published: false,
    },
  ],
  skills: [
    {
      slug: "check-renewal-risk",
      title: "Check renewal risk",
      collides: true,
      identical: false,
      resolution: "suffix",
      installAs: "check-renewal-risk-2",
      suffixCandidate: "check-renewal-risk-2",
      paired: true,
    },
  ],
  endpoint: {
    required: true,
    reason: "remote",
    requiresKey: true,
    authHeader: "Authorization",
    exampleUrl: "https://renewals.example.com/agui",
    sendsConversationTo: "renewals.example.com",
  },
  slugDecisions: { "check-renewal-risk": "suffix" },
};

/**
 * The server, as far as this screen is concerned.
 *
 * `client` and `tryClient` are the real ones, so the envelope unwrapping and the refusal handling
 * are exercised rather than stubbed past.
 */
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const path = typeof input === "string" ? input : input.toString();
  if (path === "/api/templates/preview") {
    return Response.json({ template, digest: plan.digest, plan });
  }
  if (path === "/api/computers/policy") {
    // The shipped policy, which is what the amber block is generated from.
    return Response.json({
      policy: { mode: "enforce", deny: [], allow: ["true"] },
    });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}) as typeof fetch;

const { ImportTemplate } = await import("@/components/agents/import-template");

/** A real router over a memory history, so `Link` and `useNavigate` resolve without a mock. */
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
  // The app's router is registered globally for typing; this one is a different instance and only
  // has to resolve the two paths this screen reaches for.
  return <RouterProvider router={router as never} />;
}

test("the consent screen renders every section in order", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    routed(
      <QueryClientProvider client={client}>
        <ImportTemplate />
      </QueryClientProvider>,
    ),
  );

  // The router mounts its route asynchronously, so nothing is on screen on the first tick.
  await waitFor(() =>
    expect(screen.getByLabelText("Template file")).toBeDefined(),
  );
  const box = screen.getByLabelText("Template file");
  await userEvent.type(box, "openbot_template: 1");
  await userEvent.click(screen.getByText("Read this template"));

  await waitFor(() =>
    expect(screen.getByText("Import this coworker?")).toBeDefined(),
  );

  const body = document.body.textContent ?? "";
  const order = [
    "1. What this Bot is",
    "2. Its skills",
    "3. Where it runs",
    "4. What it is asking for",
    "5. What it will be allowed to do",
    "6. What this install will not do",
  ].map((heading) => body.indexOf(heading));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);

  // Verbatim, and the script tag is text rather than markup.
  expect(body).toContain("<script>alert(1)</script>");
  expect(document.querySelectorAll("script").length).toBe(0);

  // The claim is rendered, and it is not a link.
  expect(body).toContain("https://github.com/acme/openbot-templates");
  expect(
    [...document.querySelectorAll("a")].some((anchor) =>
      (anchor.getAttribute("href") ?? "").includes("acme"),
    ),
  ).toBe(false);

  expect(body).toContain("Not granted by this install.");
  expect(body).toContain("This deployment currently allows every action.");
  expect(body).toContain(
    "Every message anyone sends this coworker is sent to this address",
  );
  expect(body).toContain("renewals.example.com");
  expect(body).toContain("There is already a skill called /check-renewal-risk");
  expect(screen.getByText("Import Renewal Desk")).toBeDefined();
});

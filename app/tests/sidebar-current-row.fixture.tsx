import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { queryClient } from "@/query-client";
import { router } from "@/router";

/**
 * The whole app as main.tsx mounts it, on the real route tree (app/src/routeTree.gen.ts), for
 * sidebar-current-row.test.tsx to bundle and load in a real browser. The server is a stand-in that
 * answers what the default sidebar, the Bots page and the invitations page read for a person in two
 * organizations with one invitation waiting; anything else is the API's plain not found, and its
 * path is kept in `window.unanswered` for the test to print.
 */
const ACME = { id: "org_acme", slug: "acme", name: "Acme" };
const RESEARCH = {
  id: "org_research",
  slug: "research",
  name: "Acme Research",
};
const unanswered: string[] = [];
(window as unknown as { unanswered: string[] }).unanswered = unanswered;

function problem(status: number, code: string): Response {
  return new Response(JSON.stringify({ status, code, title: code }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

const day = 24 * 60 * 60 * 1000;
const invitation = {
  id: "inv_1",
  organization: RESEARCH,
  role: "member",
  status: "pending",
  invitedBy: { id: "lee", name: "Lee Park", email: "lee@example.com" },
  createdAt: new Date(Date.now() - day).toISOString(),
  expiresAt: new Date(Date.now() + 6 * day).toISOString(),
};

globalThis.fetch = async (input, init) => {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    location.origin,
  );
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  const path = url.pathname;
  if (path === "/api/v2/organizations/default/deployment")
    return Response.json({
      generativeUi: true,
      selfHostBanner: false,
      localEvaluation: false,
      edition: "team",
    });
  if (path === "/api/v2/people/me/organizations")
    return Response.json({
      organizations: [ACME, RESEARCH].map((one) => ({
        ...one,
        role: "owner",
        active: one.id === ACME.id,
      })),
      canCreate: true,
      nextCursor: null,
    });
  if (path === "/api/v2/people/me/invitations")
    return Response.json({ invitations: [invitation], nextCursor: null });
  if (path === `/api/v2/organizations/${ACME.id}/people/me`)
    return Response.json({
      person: {
        id: "dana",
        email: "dana@example.com",
        name: "Dana Fresh",
        needsName: false,
        image: null,
        role: "admin",
        onboarding: null,
      },
      openbotVersion: "main-20261113-9",
    });
  if (method === "GET" && path === `/api/v2/organizations/${ACME.id}/bots`)
    return Response.json({ bots: [], nextCursor: null });
  if (
    method === "GET" &&
    path === `/api/v2/organizations/${ACME.id}/conversations`
  )
    return Response.json({ conversations: [], nextCursor: null });
  unanswered.push(`${method} ${path}`);
  return problem(404, "NOT_FOUND");
};

/** No socket: nothing here answers one. */
class OfflineWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 3;
  onclose = null;
  onerror = null;
  onmessage = null;
  onopen = null;
  close() {}
  send() {}
}
globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>,
  );

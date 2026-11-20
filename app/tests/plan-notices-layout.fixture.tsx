import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { PlanBanner } from "@/components/layout/plan-banner";
import { OrganizationSettingsPage } from "@/components/organizations/organization-settings-page";
import { TooltipProvider } from "@/components/ui/tooltip";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { organizationKeys } from "@/lib/organizations/queries";
import { type PlanStatus, planKeys } from "@/lib/plan/queries";
import { queryClient } from "@/query-client";

/**
 * The places an organization's plan shows, as a page of their own for plan-notices-layout.test.tsx
 * to bundle and load in Chromium: the bar over every page, the Plan row on the organization's
 * settings, and the chat when a run is refused for want of a plan. Every answer the screens read is
 * put in the cache first, as the server would answer it, and nothing is fetched.
 *
 * `?scene=shell|settings|chat`, `?plan=<status>`, `?admin=1` for an owner, `?theme=dark`.
 */
const query = new URLSearchParams(location.search);
const scene = query.get("scene") ?? "shell";
const status = query.get("plan") ?? "trialing";
const admin = query.get("admin") === "1";
if (query.get("theme") === "dark")
  document.documentElement.classList.add("dark");

const ORG = "Jq3xT9mLw2Vb8RnC5sYd0fKe";
const ADD_CARD = `/api/auth/hosted/checkout?organizationId=${ORG}`;
const DAY = 24 * 60 * 60 * 1000;

const plan: PlanStatus = {
  required: status !== "not_required",
  status,
  trialEndsAt:
    status === "trialing"
      ? new Date(Date.now() + 23 * DAY - 60_000).toISOString()
      : null,
  renewsAt:
    status === "active" ? new Date(Date.now() + 12 * DAY).toISOString() : null,
  addCardUrl: admin && status !== "not_required" ? ADD_CARD : null,
};

// Nothing else is fetched: every other answer is in the cache, and stays the answer. The plan is
// served too, since a refused run reads it again.
globalThis.fetch = (async (input: RequestInfo | URL) =>
  String(input).endsWith("/plan")
    ? Response.json(plan)
    : new Response(null, { status: 404 })) as unknown as typeof fetch;
queryClient.setDefaultOptions({
  queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
});
setCurrentOrganization(ORG);
queryClient.setQueryData(planKeys.current(), plan);
queryClient.setQueryData(deploymentKeys.capabilities(), {
  generativeUi: true,
  selfHostBanner: false,
  localEvaluation: false,
  edition: "team",
  hostedSignIn: true,
});
queryClient.setQueryData(authKeys.currentUser(), {
  id: "ana",
  email: "ana@example.com",
  name: "Ana Lopez",
  role: admin ? "owner" : "member",
});
queryClient.setQueryData(organizationKeys.mine(), {
  organizations: [
    {
      id: ORG,
      slug: "acme-research",
      name: "Acme Research",
      role: admin ? "owner" : "member",
      active: true,
      personal: false,
    },
  ],
  canCreate: true,
  currentId: ORG,
});
queryClient.setQueryData(organizationKeys.members(ORG), [
  {
    id: "ana",
    email: "ana@example.com",
    name: "Ana Lopez",
    image: null,
    role: "owner",
    joinedAt: "2026-11-20T09:00:00Z",
    removable: false,
    assignableRoles: [],
  },
  {
    id: "sam",
    email: "sam@example.com",
    name: "Sam Okafor",
    image: null,
    role: "member",
    joinedAt: "2026-11-20T10:00:00Z",
    removable: admin,
    assignableRoles: admin ? ["admin"] : [],
  },
]);
queryClient.setQueryData(organizationKeys.sentInvitations(ORG), []);

// As the server words the refusal of a run (the problem's detail), for an admin and for a member.
const REFUSED =
  status === "past_due"
    ? "This organization's last payment didn't go through, so Bots can't run until the card is updated."
    : plan.addCardUrl !== null
      ? "Bots in this organization can't run until a card is added. Add a card to start your 30-day free trial."
      : "Bots in this organization can't run until an admin adds a card.";
const ASKED: Message[] = [
  { id: "u1", role: "user", content: "Summarize this week's signups for me" },
];

function Scene() {
  if (scene === "settings") return <OrganizationSettingsPage />;
  if (scene === "chat")
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatTranscript messages={ASKED} restoring={false} stopped={REFUSED} />
      </div>
    );
  return (
    <h1 className="p-4 font-semibold text-2xl" data-below="">
      Start a conversation
    </h1>
  );
}

const width = Number(query.get("width") ?? 650);
const rootRoute = createRootRoute({
  component: () => (
    <div
      className="flex h-svh flex-col overflow-auto bg-background text-foreground"
      style={{ width }}
    >
      <PlanBanner />
      <Scene />
    </div>
  ),
});
const router = createRouter({
  routeTree: rootRoute,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="/api/copilotkit">
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );

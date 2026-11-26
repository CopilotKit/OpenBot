import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { PendingDeletionGate } from "@/components/auth/pending-deletion-page";
import { GroupChat } from "@/components/channels/group-chat";
import { OrganizationSettingsPage } from "@/components/organizations/organization-settings-page";
import { PeopleTypeahead } from "@/components/teams/people-typeahead";
import { ThemeProvider } from "@/components/theme-provider";
import { showPendingDeletion } from "@/lib/account-deletion/pending";
import { deploymentKeys } from "@/lib/deployment/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { organizationKeys } from "@/lib/organizations/queries";
import { queryClient } from "@/query-client";
import { Route as GeneralRoute } from "@/routes/_authed/settings/index";
import { ME_PATH, meResponse } from "./accounts-api";
import { approvalInboxResponse } from "./approvals-api";
import { answerBotsList } from "./bots-api";
import { answerGroupRead, type GroupFixture } from "./conversations-api";

/**
 * Settings, General, with its Delete account section, as a page of its own for
 * delete-account-layout.test.tsx to bundle and load in a browser. `?state=`:
 *
 *  - `blockers`: two organizations stand in the way, one Dana is the only owner of and one she
 *    has to leave;
 *  - `clear` (anything else): nothing stands in the way, and the test opens the dialog;
 *  - `reauthenticate`: as clear, and the server asks her to sign in again when she confirms;
 *  - `pending`: her account is scheduled to be deleted, and the app is only the pending page.
 *
 * The server's answers come from a fetch here, as the API gives them, so nothing is asked of a
 * server.
 */
const state = new URLSearchParams(location.search).get("state") ?? "clear";

setCurrentOrganization("default");
queryClient.setDefaultOptions({
  queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
});
queryClient.setQueryData(deploymentKeys.capabilities(), {
  generativeUi: true,
  selfHostBanner: false,
  localEvaluation: false,
  edition: "team",
});
const MINE = {
  organizations: [
    {
      id: "default",
      slug: "dana",
      name: "Dana's organization",
      role: "owner",
      personal: true,
      active: true,
    },
  ],
  canCreate: true,
  nextCursor: null,
};
queryClient.setQueryData(organizationKeys.mine(), {
  ...MINE,
  currentId: "default",
});

const BLOCKERS = [
  {
    organizationId: "org_acme",
    organizationName: "Acme Freight",
    reason: "only_owner",
  },
  {
    organizationId: "org_globex",
    organizationName: "Globex Design Studio",
    reason: "owner_must_leave",
  },
];

/** The organization's members: Priya's account is scheduled to be deleted. */
const MEMBERS = [
  ["dana", "Dana Whitfield", "owner", false],
  ["priya", "Priya Raman", "member", true],
  ["sam", "Sam Ortiz", "member", false],
].map(([id, name, role, deactivated], index) => ({
  id,
  email: `${id}@acme.test`,
  name,
  image: null,
  role,
  joinedAt: `2026-11-0${index + 1}T09:00:00.000Z`,
  removable: id !== "dana",
  assignableRoles: id === "dana" ? [] : ["admin"],
  deactivated,
}));

if (state === "pending")
  showPendingDeletion({ deleteAfter: "2026-12-09T10:00:00.000Z" });

/**
 * A conversation with a Bot that Dana shares with Sam, where Priya said something before she
 * deleted her account: her line stays, with no sender.
 */
const GROUP = "channel_ghost";
const GHOST_GROUP: GroupFixture = {
  bots: [{ id: "research", name: "Research" }],
  people: [
    {
      userId: "dana",
      email: "dana@acme.test",
      name: "Dana Whitfield",
      creator: true,
    },
    {
      userId: "sam",
      email: "sam@acme.test",
      name: "Sam Ortiz",
      creator: false,
    },
  ],
  messages: [
    {
      id: "g-1",
      ownerUserId: "",
      agentId: null,
      text: "Can you pull last quarter's freight costs by lane?",
      status: "completed",
      createdAt: "2026-11-20T09:00:00.000Z",
    },
    {
      id: "g-1:research",
      ownerUserId: "",
      agentId: "research",
      text: "Here are last quarter's freight costs by lane. The Rotterdam lane rose 12%.",
      status: "completed",
      createdAt: "2026-11-20T09:00:30.000Z",
    },
    {
      id: "g-2",
      ownerUserId: "sam",
      agentId: null,
      text: "Thanks. Can you compare that with the quarter before?",
      status: "completed",
      createdAt: "2026-11-24T10:00:00.000Z",
    },
  ],
};

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input), location.origin).pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  if (state === "ghost") {
    const answered =
      answerGroupRead(input, init, GROUP, GHOST_GROUP) ??
      answerBotsList(input, init, {
        visible: [{ id: "research", name: "Research", avatarSeed: "research" }],
      }) ??
      approvalInboxResponse(path, {
        enabled: true,
        requests: [],
        rules: [],
        teamRules: [],
        questions: [],
      });
    if (answered) return answered;
  }
  if (path === ME_PATH)
    return meResponse({
      user: {
        id: "dana",
        email: "dana@acme.test",
        name: "Dana Whitfield",
        role: "owner",
      },
    });
  if (path === `${ME_PATH}/instructions`)
    return Response.json({ instructions: "" });
  if (path === `${ME_PATH}/preferences`)
    return Response.json({
      messageListEmphasis: "thread",
      selfHostBannerDismissed: false,
      dismissedNotices: [],
      noticesDue: [],
      narration: null,
      skin: "openbot",
      proactive: "on",
    });
  if (path === "/api/v2/people/me/organizations") return Response.json(MINE);
  if (path === "/api/v2/organizations/default/members") {
    const search =
      new URL(String(input), location.origin).searchParams
        .get("search")
        ?.toLowerCase() ?? "";
    return Response.json({
      members: MEMBERS.filter((one) =>
        `${one.name} ${one.email}`.toLowerCase().includes(search),
      ),
      nextCursor: null,
    });
  }
  if (path === "/api/v2/organizations/default/invitations")
    return Response.json({ invitations: [], nextCursor: null });
  if (path === "/api/v2/people/me/account-deletion" && method === "GET")
    return Response.json(
      state === "pending"
        ? {
            status: "scheduled",
            requestedAt: "2026-11-25T10:00:00.000Z",
            deleteAfter: "2026-12-09T10:00:00.000Z",
            blockers: [],
          }
        : { status: "none", blockers: state === "blockers" ? BLOCKERS : [] },
    );
  if (path === "/api/v2/people/me/account-deletion" && method === "POST")
    return Response.json(
      {
        type: "https://open.bot/errors/reauthenticate",
        title: "Sign in again.",
        status: 403,
        detail: "To delete your account, sign in again first.",
        code: "REAUTHENTICATE",
        category: "auth",
        retryable: false,
        requestId: "req_example",
        traceId: "trace_example",
      },
      {
        status: 403,
        headers: { "content-type": "application/problem+json" },
      },
    );
  return Response.json({ detail: "not served" }, { status: 404 });
}) as typeof fetch;

const General = GeneralRoute.options.component as ComponentType;

/** The box that picks somebody from the organization, as the Add people dialog holds it. */
function Picker() {
  return (
    <div className="mx-auto w-full max-w-lg px-4 pt-12">
      <PeopleTypeahead
        label="People to add to Sales"
        onChoose={() => {}}
        unavailable={(person) => (person.id === "dana" ? "In this team" : null)}
      />
    </div>
  );
}

/** The conversation, as Dana reads it. */
function Ghost() {
  return <GroupChat channelId={GROUP} />;
}

const Page =
  state === "members"
    ? OrganizationSettingsPage
    : state === "picker"
      ? Picker
      : state === "ghost"
        ? Ghost
        : General;
const rootRoute = createRootRoute({
  component: () => (
    <div className="bg-background text-foreground">
      <ThemeProvider>
        <PendingDeletionGate>
          <div className="flex h-svh flex-col">
            <Page />
          </div>
        </PendingDeletionGate>
      </ThemeProvider>
    </div>
  ),
});
const router = createRouter({
  routeTree: rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => null,
    }),
  ]),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );

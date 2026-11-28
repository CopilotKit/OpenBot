import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { ComputersPage } from "@/components/manage/computers-page";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getGetBotResponseMock } from "@/lib/api/generated/bots/bots.msw";
import type {
  ComputerRestore,
  WorkspaceSnapshots,
} from "@/lib/api/generated/model";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";

/**
 * A Bot's Computer page with its saved copies, as a page of its own for
 * workspace-snapshots-layout.test.tsx to bundle and load in Chromium. The page is the real one, in
 * the frame a Bot's page draws (`BotSubpage`), and what the server answers is answered here.
 *
 * `?scene=list|running|failed|admin`, `?theme=dark`. `list` is the person's own computer after a
 * restore that went well; `admin` is an admin, who also sees the other people's computers this Bot
 * runs on.
 */
const query = new URLSearchParams(location.search);
const scene = query.get("scene") ?? "list";
if (query.get("theme") === "dark")
  document.documentElement.classList.add("dark");
const admin = scene === "admin";

setCurrentOrganization("default");
queryClient.setDefaultOptions({ queries: { retry: false } });

const BOT = "fernhill-guide";
const ORGANIZATION = "/api/v2/organizations/default";

const SNAPSHOTS = [
  {
    id: "snap_20261121t1504z_9xq1",
    takenAt: "2026-11-21T15:04:12Z",
    kind: "before-restore",
  },
  {
    id: "snap_20261121t0300z_4kq2",
    takenAt: "2026-11-21T03:00:41Z",
    kind: "daily",
  },
  {
    id: "snap_20261120t0300z_7mn3",
    takenAt: "2026-11-20T03:00:38Z",
    kind: "daily",
  },
  {
    id: "snap_20261119t0300z_2ab8",
    takenAt: "2026-11-19T03:00:40Z",
    kind: "daily",
  },
  {
    id: "snap_20261118t0300z_6cd1",
    takenAt: "2026-11-18T03:00:37Z",
    kind: "daily",
  },
] as const;

const restore: ComputerRestore | null =
  scene === "running"
    ? {
        id: "rst_5f2a9c",
        snapshotId: SNAPSHOTS[2].id,
        snapshotTakenAt: SNAPSHOTS[2].takenAt,
        beforeSnapshotId: SNAPSHOTS[0].id,
        state: "running",
        startedAt: "2026-11-21T15:04:10Z",
        finishedAt: null,
        error: null,
      }
    : scene === "failed"
      ? {
          id: "rst_5f2a9c",
          snapshotId: SNAPSHOTS[2].id,
          snapshotTakenAt: SNAPSHOTS[2].takenAt,
          beforeSnapshotId: SNAPSHOTS[0].id,
          state: "failed",
          startedAt: "2026-11-21T15:04:10Z",
          finishedAt: "2026-11-21T15:09:02Z",
          error:
            "Couldn't put the saved copy back. The computer is as it was before, and nothing was lost. Try again in a moment.",
        }
      : scene === "list"
        ? {
            id: "rst_5f2a9c",
            snapshotId: SNAPSHOTS[2].id,
            snapshotTakenAt: SNAPSHOTS[2].takenAt,
            beforeSnapshotId: SNAPSHOTS[0].id,
            state: "done",
            startedAt: "2026-11-21T15:04:10Z",
            finishedAt: "2026-11-21T15:07:55Z",
            error: null,
          }
        : null;

const mine: WorkspaceSnapshots = {
  computer: "person:ana",
  available: true,
  canRestore: true,
  snapshots: [...SNAPSHOTS],
  restore,
};
const dana: WorkspaceSnapshots = {
  computer: "person:dana",
  available: true,
  canRestore: true,
  snapshots: SNAPSHOTS.filter((snapshot) => snapshot.kind === "daily"),
  restore: null,
};

const seat = (id: string, name: string, email: string) => ({
  computer: `person:${id}`,
  kind: "person",
  personId: id,
  person: { name, email },
  botId: BOT,
  running: true,
  startedAt: "2026-11-21T08:12:03Z",
  egress: null,
});

const bot = {
  ...getGetBotResponseMock().bot,
  id: BOT,
  name: "Fernhill Guide",
  mine: true,
  canManage: true,
  hidden: false,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input), location.origin);
  const path = url.pathname;
  if (path === `${ORGANIZATION}/deployment`)
    return json({
      generativeUi: true,
      selfHostBanner: false,
      localEvaluation: false,
      edition: "team",
      hostedSignIn: true,
      botComputers: true,
    });
  if (path === `${ORGANIZATION}/people/me`)
    return json({
      person: {
        id: "ana",
        email: "ana@example.com",
        name: "Ana Lopez",
        image: null,
        role: admin ? "admin" : "member",
        needsName: false,
        onboarding: null,
        providers: [],
        lastSignedInAt: null,
        revoked: false,
        configuredAdmin: false,
      },
      openbotVersion: null,
    });
  if (path === `${ORGANIZATION}/bots/${BOT}`) return json({ bot });
  if (path === `${ORGANIZATION}/bots`)
    return json({ bots: [bot], nextCursor: null });
  if (path === `${ORGANIZATION}/people/me/host-access`)
    return json({ connected: false, desktop: false, grants: [], pending: [] });
  if (path === `${ORGANIZATION}/computers`)
    return json({
      computers: [
        seat("ana", "Ana Lopez", "ana@example.com"),
        seat("dana", "Dana Whitfield", "dana.whitfield@northwind.example"),
        seat("sam", "Sam Ortiz", "sam.ortiz@northwind.example"),
      ],
      isolation: "per-person",
      nextCursor: null,
    });
  if (path === `${ORGANIZATION}/computers/${BOT}/workspace-snapshots`)
    return json(url.searchParams.get("computer") ? dana : mine);
  if (path === `${ORGANIZATION}/computers/${BOT}/restore`)
    return json(
      {
        status: 409,
        code: "COMPUTER_RESTORE_RUNNING",
        detail:
          "This computer is already being restored. Wait for it to finish, then try again.",
      },
      409,
    );
  return json({ detail: "Not here." }, 404);
}) as typeof fetch;

const rootRoute = createRootRoute({
  component: () => (
    <div className="flex h-svh flex-col overflow-hidden bg-background text-foreground">
      <BotSubpage
        agentId={BOT}
        description="Choose the folders this Bot can read on this computer, and manage its browser."
        title="Computer"
      >
        {(agent) => <ComputersPage agentId={agent.id} />}
      </BotSubpage>
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
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );

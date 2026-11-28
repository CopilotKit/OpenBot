import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { ComputersPage } from "@/components/manage/computers-page";
import type {
  ComputerRestore,
  WorkspaceSnapshots,
} from "@/lib/api/generated/model";
import { queryClient } from "@/query-client";
import { ME_PATH, meResponse } from "./accounts-api";
import { DEPLOYMENT_PATH, deploymentResponse } from "./admin-settings-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's Computer page lists its computer's saved copies and restores one only when the person
 * picks it and confirms.
 *
 * Drawn for real: the page with its own queries and the generated client, against a server stand-in
 * at the API's addresses that answers as the server does and keeps every request it was sent. The
 * restore is answered running, and the copies' next read says so, as the server does once a restore
 * has started.
 */

const ORGANIZATION = "/api/v2/organizations/default";
const COMPUTERS_PATH = `${ORGANIZATION}/computers`;
const HOST_ACCESS_PATH = `${ORGANIZATION}/people/me/host-access`;
const BOTS_PATH = `${ORGANIZATION}/bots`;
const BOT = "fernhill-guide";
const SNAPSHOTS_PATH = `${COMPUTERS_PATH}/${BOT}/workspace-snapshots`;
const RESTORE_PATH = `${COMPUTERS_PATH}/${BOT}/restore`;

/** Midday UTC, so the date is the same one in every time zone the suite runs in. */
const DAILY = {
  id: "snap_20261121t1200z_4kq2",
  takenAt: "2026-11-21T12:00:41Z",
  kind: "daily",
} as const;
const BEFORE = {
  id: "snap_20261120t1504z_9xq1",
  takenAt: "2026-11-20T15:04:12Z",
  kind: "before-restore",
} as const;
const OLDER = {
  id: "snap_20261119t1200z_7mn3",
  takenAt: "2026-11-19T12:00:38Z",
  kind: "daily",
} as const;

function copies(
  computer: string,
  overrides: Partial<WorkspaceSnapshots> = {},
): WorkspaceSnapshots {
  return {
    computer,
    available: true,
    canRestore: true,
    snapshots: [DAILY, BEFORE, OLDER],
    restore: null,
    ...overrides,
  };
}

function running(snapshotId: string, takenAt: string): ComputerRestore {
  return {
    id: "rst_5f2a9c",
    snapshotId,
    snapshotTakenAt: takenAt,
    beforeSnapshotId: null,
    state: "running",
    startedAt: "2026-11-21T15:04:10Z",
    finishedAt: null,
    error: null,
  };
}

type Sent = {
  method: string;
  path: string;
  search: string;
  body: unknown;
  key: string | null;
};

/**
 * The server: who is asking, the Bot's computers, and each computer's copies. A POST to restore
 * answers 202 running (or `refuse`), and from then on that computer's copies say it runs.
 */
function serve({
  admin = false,
  mine = copies("person:ada"),
  others = {} as Record<string, WorkspaceSnapshots>,
  read = 200,
  refuse,
}: {
  admin?: boolean;
  mine?: WorkspaceSnapshots;
  others?: Record<string, WorkspaceSnapshots>;
  /** The status the copies' read answers with: 403 and 404 are refusals the page hides. */
  read?: number;
  refuse?: { status: number; code: string; detail: string };
}) {
  const sent: Sent[] = [];
  const answers: Record<string, WorkspaceSnapshots> = {
    [mine.computer]: mine,
    ...others,
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://openbot.test");
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    sent.push({
      method,
      path,
      search: url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      key: headers.get("Idempotency-Key"),
    });
    if (path === DEPLOYMENT_PATH)
      return deploymentResponse({ botComputers: true });
    if (path === ME_PATH)
      return meResponse({
        user: { id: "ada", name: "Ada", role: admin ? "admin" : "member" },
      });
    if (path === HOST_ACCESS_PATH)
      return Response.json({
        connected: false,
        desktop: false,
        grants: [],
        pending: [],
      });
    if (path === BOTS_PATH)
      return Response.json({ bots: [], nextCursor: null });
    if (path === COMPUTERS_PATH)
      return Response.json({
        computers: [
          {
            computer: "person:ada",
            kind: "person",
            personId: "ada",
            person: { name: "Ada", email: "ada@example.com" },
            botId: BOT,
            running: true,
            startedAt: "2026-11-21T04:21:42.051Z",
            egress: null,
          },
          {
            computer: "person:dana",
            kind: "person",
            personId: "dana",
            person: { name: "Dana Whitfield", email: "dana@example.com" },
            botId: BOT,
            running: true,
            startedAt: "2026-11-21T04:21:42.051Z",
            egress: null,
          },
        ],
        isolation: "per-person",
        nextCursor: null,
      });
    if (path === SNAPSHOTS_PATH) {
      if (read !== 200)
        return Response.json(
          { status: read, code: "FORBIDDEN", detail: "Not yours." },
          {
            status: read,
            headers: { "content-type": "application/problem+json" },
          },
        );
      const computer = url.searchParams.get("computer") ?? mine.computer;
      return Response.json(answers[computer]);
    }
    if (path === RESTORE_PATH && method === "POST") {
      if (refuse)
        return Response.json(
          { status: refuse.status, code: refuse.code, detail: refuse.detail },
          {
            status: refuse.status,
            headers: { "content-type": "application/problem+json" },
          },
        );
      const body = JSON.parse(String(init?.body)) as {
        snapshotId: string;
        computer?: string;
      };
      const computer = body.computer ?? mine.computer;
      const copy = answers[computer].snapshots.find(
        (snapshot) => snapshot.id === body.snapshotId,
      );
      const restore = running(body.snapshotId, copy?.takenAt ?? "");
      answers[computer] = { ...answers[computer], restore };
      return Response.json(restore, { status: 202 });
    }
    return Response.json({ detail: "Not here." }, { status: 404 });
  }) as typeof fetch;
  return {
    sent,
    restores: () =>
      sent.filter(
        (request) => request.method === "POST" && request.path === RESTORE_PATH,
      ),
    reads: () => sent.filter((request) => request.path === SNAPSHOTS_PATH),
  };
}

let originalFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register();
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

/** The page, in the app's one query client, as the app draws it. */
function draw() {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <ComputersPage agentId={BOT} />,
    }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

async function settle(ms = 250) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** The dialog Base UI portals to the body, by its title. */
async function dialogTitled(view: ReturnType<typeof draw>, title: RegExp) {
  const heading = await view.findByRole("heading", { name: title });
  const dialog = heading.closest("[role=dialog]");
  if (!(dialog instanceof HTMLElement)) throw new Error("no dialog");
  return within(dialog);
}

describe("a Bot's saved copies", () => {
  test("lists the copies newest first, and restores the one the person confirms", async () => {
    const server = serve({});
    const view = draw();

    expect(
      await view.findByRole("heading", { name: "Saved copies" }),
    ).toBeTruthy();
    const section = within(
      view
        .getByRole("heading", { name: "Saved copies" })
        .closest("section") as HTMLElement,
    );
    const titles = section
      .getAllByText(/November|Before restore/)
      .map((title) => title.textContent ?? "");
    // The daily copy reads as its date; the one saved before a restore says so first.
    expect(titles[0]).toMatch(/^Saturday, November 21|^Saturday, 21 November/);
    expect(titles[1]).toMatch(/^Before restore, Friday/);
    expect(titles[2]).toMatch(/^Thursday/);
    const restoreButtons = section.getAllByRole("button", { name: "Restore" });
    expect(restoreButtons).toHaveLength(3);
    // Nothing is restored by looking.
    expect(server.restores()).toEqual([]);

    fireEvent.click(restoreButtons[0]);
    const confirm = await dialogTitled(view, /^Restore from Saturday/);
    expect(
      confirm.getByText(
        /Every file and browser sign-in on this computer goes back/,
      ),
    ).toBeTruthy();
    expect(
      confirm.getByText(/OpenBot first saves the computer as it is now/),
    ).toBeTruthy();
    fireEvent.click(confirm.getByRole("button", { name: "Restore it" }));

    await waitFor(() => expect(server.restores()).toHaveLength(1));
    const [restore] = server.restores();
    expect(restore.body).toEqual({ snapshotId: DAILY.id });
    expect(restore.key).toBeTruthy();

    // The copies are read again, the restore is under way, and every Restore waits for it.
    expect(
      await view.findByText(
        /^Restoring this computer to how it was on Saturday/,
      ),
    ).toBeTruthy();
    expect(view.getByText(/Bots on it wait until it's back/)).toBeTruthy();
    for (const button of section.getAllByRole("button", { name: "Restore" }))
      expect(button.hasAttribute("disabled")).toBe(true);
  });

  test("a restore already running when the page opens says so at the top", async () => {
    serve({
      mine: copies("person:ada", {
        restore: running(OLDER.id, OLDER.takenAt),
      }),
    });
    const view = draw();

    const notice = await view.findByRole("status");
    expect(notice.textContent).toMatch(
      /^Restoring this computer to how it was on Thursday/,
    );
  });

  test("a refused restore says the server's sentence beside the buttons, and the dialog stays", async () => {
    serve({
      refuse: {
        status: 409,
        code: "COMPUTER_RESTORE_RUNNING",
        detail:
          "This computer is already being restored. Wait for it to finish, then try again.",
      },
    });
    const view = draw();

    fireEvent.click(
      (await view.findAllByRole("button", { name: "Restore" }))[1],
    );
    const confirm = await dialogTitled(view, /^Restore from Friday/);
    fireEvent.click(confirm.getByRole("button", { name: "Restore it" }));
    expect((await confirm.findByRole("alert")).textContent).toBe(
      "This computer is already being restored. Wait for it to finish, then try again.",
    );
    expect(confirm.getByRole("button", { name: "Restore it" })).toBeTruthy();
  });

  test("a person who may not restore sees the copies with no Restore", async () => {
    serve({ mine: copies("person:ada", { canRestore: false }) });
    const view = draw();

    expect(
      await view.findByRole("heading", { name: "Saved copies" }),
    ).toBeTruthy();
    expect(view.getAllByText(/November/).length).toBeGreaterThan(0);
    expect(view.queryByRole("button", { name: "Restore" })).toBeNull();
  });

  test("where this OpenBot keeps no copies, or the read is refused, there is no section", async () => {
    for (const setup of [
      { mine: copies("person:ada", { available: false, snapshots: [] }) },
      { read: 403 },
      { read: 404 },
    ]) {
      const server = serve(setup);
      const view = draw();
      await waitFor(() => expect(server.reads().length).toBeGreaterThan(0));
      await settle();
      expect(view.queryByRole("heading", { name: "Saved copies" })).toBeNull();
      expect(view.queryByRole("alert")).toBeNull();
      cleanup();
      queryClient.clear();
    }
  });

  test("with none saved yet, it says the first arrives within a day", async () => {
    serve({ mine: copies("person:ada", { snapshots: [] }) });
    const view = draw();

    expect(await view.findByText("No saved copies yet")).toBeTruthy();
    expect(
      view.getByText("OpenBot saves the first one within a day."),
    ).toBeTruthy();
  });
});

describe("an admin restoring another person's computer", () => {
  test("Restore… is on the other person's row only, and restores their computer by name", async () => {
    const server = serve({
      admin: true,
      others: { "person:dana": copies("person:dana") },
    });
    const view = draw();

    const offers = await view.findAllByRole("button", { name: "Restore…" });
    // Ada's own row has none: her own copies are the section below.
    expect(offers).toHaveLength(1);
    const danaRow = offers[0].closest("[data-slot=item]") as HTMLElement;
    expect(within(danaRow).getByText(/Dana Whitfield/)).toBeTruthy();

    fireEvent.click(offers[0]);
    const list = await dialogTitled(view, /^Dana Whitfield's computer$/);
    await waitFor(() =>
      expect(
        server
          .reads()
          .some((read) => read.search === "?computer=person%3Adana"),
      ).toBe(true),
    );
    fireEvent.click(
      (await list.findAllByRole("button", { name: "Restore" }))[2],
    );

    const confirm = await dialogTitled(view, /^Restore from Thursday/);
    fireEvent.click(confirm.getByRole("button", { name: "Restore it" }));

    await waitFor(() => expect(server.restores()).toHaveLength(1));
    expect(server.restores()[0].body).toEqual({
      snapshotId: OLDER.id,
      computer: "person:dana",
    });
    // Dana's computer is the one restoring; Ada's own section says nothing of it.
    expect(
      await list.findByText(
        /^Restoring this computer to how it was on Thursday/,
      ),
    ).toBeTruthy();
    expect(view.getAllByRole("status")).toHaveLength(1);
  });
});

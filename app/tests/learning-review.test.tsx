import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
  LearningProposal,
  LearningProposalDetail,
  PersonalReview,
} from "@openbot/shared/learning";
import { environmentManager, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { LearningReview } from "@/components/settings/learning-review";
import { personalReviewQueryOptions } from "@/lib/learning/queries";
import { queryClient } from "@/query-client";
import { LearningSettingsPage } from "@/routes/_authed/settings/learning";

let wasServer = true;
beforeAll(() => {
  GlobalRegistrator.register();
  wasServer = environmentManager.isServer();
  environmentManager.setIsServer(() => false);
});
afterAll(() => {
  environmentManager.setIsServer(() => wasServer);
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
let review: PersonalReview | null;
let insights: LearningProposalDetail["insights"] = [];
const posts: string[] = [];
const puts: { url: string; body: unknown }[] = [];

const proposal = (
  id: string,
  title: string,
  operation: LearningProposal["operation"],
  status: LearningProposal["status"] = "pending_review",
): LearningProposal => ({
  id,
  title,
  description: `${title} description`,
  reason: "Seen in your recordings.",
  operation,
  status,
  createdAt: "2026-11-01T00:00:00Z",
  reviewedAt: null,
});

const body = (canReview: boolean): PersonalReview => ({
  canReview,
  autoApprove: false,
  sources: [
    {
      containerId: "user-1",
      kind: "recordings",
      label: "From your recordings",
      latestRun: null,
      proposals: [
        proposal("p1", "refund-order", "add"),
        proposal("p2", "close-ticket", "update"),
        proposal("p3", "old-skill", "remove"),
        proposal("p4", "done-skill", "add", "approved"),
      ],
    },
  ],
});

beforeEach(() => {
  queryClient.clear();
  posts.length = 0;
  puts.length = 0;
  review = body(false);
  insights = [];
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      const method = init?.method ?? "GET";
      if (url === "/api/settings/learning/review") return Response.json(review);
      if (url === "/api/capabilities")
        return Response.json({ edition: "personal" });
      if (url === "/api/settings/learning")
        return Response.json({
          mode: "closed",
          sharingAllowed: true,
          skills: [],
        });
      if (method === "PUT") {
        const sent = JSON.parse(String(init?.body));
        puts.push({ url, body: sent });
        return Response.json(sent);
      }
      const detail =
        /^\/api\/settings\/learning\/proposals\/([^/?]+)\?container=(.+)$/.exec(
          url,
        );
      if (detail && method === "GET")
        return Response.json({
          proposal: {
            ...proposal(detail[1] ?? "", "refund-order", "add"),
            files: [{ path: "SKILL.md", content: "Look up the order." }],
            insights,
          },
        });
      if (method === "POST") {
        posts.push(url);
        return Response.json({ proposal: { id: "p1", status: "approved" } });
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function draw() {
  return render(
    <QueryClientProvider client={queryClient}>
      <LearningReview />
    </QueryClientProvider>,
  );
}

test("lists the pending proposals with what each does", async () => {
  const view = draw();
  await view.findByText("Waiting for an admin");
  expect(await view.findByText("New skill")).toBeTruthy();
  expect(view.getByText("Update to close-ticket")).toBeTruthy();
  expect(view.getByText("Remove old-skill")).toBeTruthy();
  expect(view.queryByText("done-skill")).toBeNull();
});

test("with admins approving, a person's pending proposal opens read-only", async () => {
  const view = draw();
  fireEvent.click(await view.findByText("refund-order"));
  await view.findByText("Look up the order.");
  expect(view.queryByText("Approve and publish")).toBeNull();
  expect(view.getByText("Done")).toBeTruthy();
  expect(view.getByText(/An admin reviews these/)).toBeTruthy();
});

test("with people approving, a person approves from the dialog", async () => {
  review = body(true);
  const view = draw();
  fireEvent.click(await view.findByText("refund-order"));
  fireEvent.click(await view.findByText("Approve and publish"));
  await waitFor(() =>
    expect(posts).toEqual([
      "/api/settings/learning/proposals/p1/approve?container=user-1",
    ]),
  );
  expect(
    await view.findByText(
      "Published. Your Bots use it from their next conversation.",
    ),
  ).toBeTruthy();
});

test("says so when proposals couldn't be read", async () => {
  review = {
    canReview: true,
    autoApprove: false,
    sources: [
      {
        containerId: "user-1",
        kind: "recordings",
        label: "From your recordings",
        latestRun: null,
        proposals: null,
      },
    ],
  };
  const view = draw();
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toBe(
    "Couldn't read your proposed skills. Reload the page.",
  );
});

test("says some were unreadable when another source was read", async () => {
  review = {
    canReview: true,
    autoApprove: false,
    sources: [
      {
        containerId: "user-1",
        kind: "recordings",
        label: "From your recordings",
        latestRun: null,
        proposals: null,
      },
      {
        containerId: "user-2",
        kind: "recordings",
        label: "More recordings",
        latestRun: null,
        proposals: [],
      },
    ],
  };
  const view = draw();
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain("Couldn't read some of your");
});

test("says what to expect when nothing is waiting", async () => {
  review = { canReview: true, autoApprove: null, sources: [] };
  const view = draw();
  expect(await view.findByText("Nothing to review")).toBeTruthy();
  expect(
    await view.findByText(
      "New proposals show up here after Learning analyses your recordings.",
    ),
  ).toBeTruthy();
});

test("in the personal edition the empty state mentions conversations", async () => {
  review = { canReview: true, autoApprove: false, sources: [] };
  const view = draw();
  expect(
    await view.findByText(
      "New proposals show up here after Learning analyses your recordings and conversations.",
    ),
  ).toBeTruthy();
});

test("with people approving, the latest run shows and Learn now starts one", async () => {
  review = body(true);
  const first = review.sources[0];
  if (first)
    first.latestRun = {
      id: "run-1",
      status: "succeeded",
      trigger: "manual",
      proposals: 2,
      insights: null,
      failureCode: null,
      createdAt: "2026-11-01T00:00:00Z",
      startedAt: null,
      completedAt: null,
    };
  const view = draw();
  expect(await view.findByText("Latest run finished.")).toBeTruthy();
  fireEvent.click(await view.findByRole("button", { name: "Learn now" }));
  await waitFor(() =>
    expect(posts).toEqual(["/api/settings/learning/runs?container=user-1"]),
  );
  expect(
    await view.findByText(
      "Learning started. New proposals show up here when it finishes.",
    ),
  ).toBeTruthy();
});

const run = (id: string, createdAt: string) => ({
  id,
  status: "succeeded" as const,
  trigger: "manual" as const,
  proposals: 1,
  insights: null,
  failureCode: null,
  createdAt,
  startedAt: null,
  completedAt: null,
});

test("turning automatic approval off shows proposals from recordings and from conversations to review", async () => {
  review = {
    canReview: true,
    autoApprove: false,
    sources: [
      {
        containerId: "user-1",
        kind: "recordings",
        label: "From your recordings",
        latestRun: null,
        proposals: [proposal("p1", "refund-order", "add")],
      },
      {
        containerId: "user-1-chat",
        kind: "conversations",
        label: "From your conversations",
        latestRun: run("run-2", "2026-11-02T00:00:00Z"),
        proposals: [proposal("p5", "reply-politely", "add")],
      },
    ],
  };
  const view = draw();
  expect(await view.findByText("From your recordings")).toBeTruthy();
  expect(view.getByText("From your conversations")).toBeTruthy();
  expect(view.getByText("refund-order")).toBeTruthy();
  expect(view.getByText("reply-politely")).toBeTruthy();
  expect(view.getByText("No run yet.")).toBeTruthy();
  expect(view.getByText("Latest run finished.")).toBeTruthy();
  const buttons = view.getAllByRole("button", { name: "Learn now" });
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[1] as HTMLElement);
  await waitFor(() =>
    expect(posts).toEqual([
      "/api/settings/learning/runs?container=user-1-chat",
    ]),
  );
});

test("sources with the same label make one group with one Learn now", async () => {
  review = {
    canReview: true,
    autoApprove: false,
    sources: ["a", "b"].map((id) => ({
      containerId: `bot-${id}`,
      kind: "conversations" as const,
      label: "From your conversations",
      latestRun: null,
      proposals: [proposal(`p-${id}`, `skill-${id}`, "add")],
    })),
  };
  const view = draw();
  expect(await view.findByText("skill-a")).toBeTruthy();
  expect(view.getAllByText("From your conversations")).toHaveLength(1);
  fireEvent.click(view.getByText("skill-b"));
  fireEvent.click(await view.findByText("Approve and publish"));
  await waitFor(() =>
    expect(posts).toEqual([
      "/api/settings/learning/proposals/p-b/approve?container=bot-b",
    ]),
  );
  posts.length = 0;
  fireEvent.click(await view.findByText("Done"));
  fireEvent.click(await view.findByRole("button", { name: "Learn now" }));
  await waitFor(() =>
    expect(posts).toEqual([
      "/api/settings/learning/runs?container=bot-a",
      "/api/settings/learning/runs?container=bot-b",
    ]),
  );
});

test("Learn now starts every source in the group even when one fails", async () => {
  review = {
    canReview: true,
    autoApprove: false,
    sources: ["a", "b"].map((id) => ({
      containerId: `bot-${id}`,
      kind: "conversations" as const,
      label: "From your conversations",
      latestRun: null,
      proposals: [],
    })),
  };
  const ok = global.fetch;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (
        String(path) === "/api/settings/learning/runs?container=bot-a" &&
        init?.method === "POST"
      ) {
        posts.push(String(path));
        return Response.json({ error: "Nope" }, { status: 500 });
      }
      return ok(path, init);
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "Learn now" }));
  await waitFor(() =>
    expect(posts).toEqual([
      "/api/settings/learning/runs?container=bot-a",
      "/api/settings/learning/runs?container=bot-b",
    ]),
  );
  expect((await view.findByRole("alert")).textContent).toBeTruthy();
});

test("with admins approving, there is no Learn now", async () => {
  const view = draw();
  await view.findByText("Waiting for an admin");
  expect(view.queryByRole("button", { name: "Learn now" })).toBeNull();
  expect(view.queryByText(/Latest run/)).toBeNull();
});

test("evidence names the recording by its title", async () => {
  const recording = (id: string, title: string | null) => ({
    kind: "recording" as const,
    id,
    title,
    available: true,
    eventCount: 2,
    events: ["Open the order", "Click Refund"],
  });
  insights = [
    {
      id: "i1",
      statement: "Refunds start from the order page.",
      impact: "Faster refunds.",
      evidence: [recording("r1", "Refund an order"), recording("r2", null)],
    },
  ];
  const view = draw();
  fireEvent.click(await view.findByText("refund-order"));
  expect(await view.findByText("Refund an order")).toBeTruthy();
  expect(view.getByText("A recording")).toBeTruthy();
  expect(view.getAllByText("Open the order, Click Refund")).toHaveLength(2);
});

test("the personal edition shows Learning with automatic approval on and no sharing", async () => {
  const base = body(true);
  review = {
    ...base,
    autoApprove: true,
    sources: base.sources.map((source) => ({ ...source, proposals: [] })),
  };
  const view = render(
    <QueryClientProvider client={queryClient}>
      <LearningSettingsPage />
    </QueryClientProvider>,
  );
  const approve = await view.findByRole("switch", {
    name: "Approve new skills automatically",
  });
  expect(approve.getAttribute("aria-checked")).toBe("true");
  expect(view.queryByText("Who else's Bots use your Skills")).toBeNull();
  expect(view.getByRole("button", { name: "Learn now" })).toBeTruthy();
  expect(view.queryByText("Nothing to review")).toBeNull();
  fireEvent.click(approve);
  await waitFor(() =>
    expect(puts).toEqual([
      {
        url: "/api/settings/learning/auto-approve",
        body: { autoApprove: false },
      },
    ]),
  );
});

test("a source Learning is off for says so plainly, without the read failure alert", async () => {
  review = {
    canReview: true,
    autoApprove: false,
    sources: [
      {
        containerId: "user-1",
        kind: "recordings",
        label: "From your recordings",
        latestRun: null,
        proposals: null,
        unavailable: "learning-off",
      },
    ],
  };
  const view = draw();
  expect(
    await view.findByText(
      "Learning isn't available in Intelligence, so nothing is proposed here.",
    ),
  ).toBeTruthy();
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.queryByText("Nothing to review")).toBeNull();
});

test("a source that failed to read still alerts next to one that is unavailable", async () => {
  const source = (id: string) => ({
    containerId: id,
    kind: "recordings" as const,
    label: `Source ${id}`,
    latestRun: null,
  });
  review = {
    canReview: true,
    autoApprove: false,
    sources: [
      { ...source("a"), proposals: null, unavailable: "learning-off" },
      { ...source("b"), proposals: null },
    ],
  };
  const view = draw();
  expect((await view.findByRole("alert")).textContent).toBe(
    "Couldn't read your proposed skills. Reload the page.",
  );
});

test("the review is read again every ten seconds only while a run is going", () => {
  const options = personalReviewQueryOptions();
  const interval = (status: string | null) => {
    const data = {
      canReview: true,
      autoApprove: false,
      sources: [
        {
          containerId: "user-1",
          kind: "recordings",
          label: "From your recordings",
          proposals: [],
          latestRun: status ? { status } : null,
        },
      ],
    };
    const refetchInterval = options.refetchInterval as (
      query: unknown,
    ) => unknown;
    return refetchInterval({ state: { data } });
  };
  expect(interval("batching")).toBe(10_000);
  expect(interval("queued")).toBe(10_000);
  expect(interval("succeeded")).toBe(false);
  expect(interval("failed")).toBe(false);
  expect(interval(null)).toBe(false);
});

test("when a refetch finds fewer proposals waiting, Your skills is refreshed", async () => {
  review = body(true);
  const view = draw();
  await view.findByText("refund-order");
  const invalidated: unknown[] = [];
  const original = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filters: { queryKey?: unknown }) => {
    invalidated.push(filters?.queryKey);
    return original(filters as never);
  }) as typeof queryClient.invalidateQueries;
  try {
    review = {
      ...body(true),
      sources: [
        {
          ...body(true).sources[0]!,
          proposals: [proposal("p1", "refund-order", "add", "approved")],
        },
      ],
    };
    await queryClient.invalidateQueries({ queryKey: ["learning", "review"] });
    await waitFor(() =>
      expect(invalidated).toContainEqual(["learning", "personal"]),
    );
  } finally {
    queryClient.invalidateQueries = original;
  }
});

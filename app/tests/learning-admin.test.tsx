import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
  LearningOverview,
  LearningProposal,
  LearningProposalDetail,
  LearningRunSummary,
  LearningSettings,
} from "@openbot/shared/learning";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { queryClient } from "@/query-client";
import { LearningPage, runPollInterval } from "@/routes/_authed/admin/learning";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
const originalFetch = global.fetch;
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function page() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: LearningPage });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("an administrator excludes a Bot and saves without losing the default or pause state", async () => {
  let settings: LearningSettings = {
    enabled: false,
    defaultTarget: { containerId: "support" },
    agents: { bot: { containerId: "sales" } },
  };
  let saved: LearningSettings | undefined;
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/settings")) {
        if (init?.method === "PUT") {
          saved = JSON.parse(String(init.body));
          settings = saved!;
        }
        return Response.json({ settings });
      }
      if (path.includes("/api/agents")) return Response.json({ agents: [] });
      return Response.json(
        { error: "Learning in the backend is unavailable." },
        { status: 502 },
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = page();
  const participation = await view.findByLabelText("bot participation");
  fireEvent.change(participation, { target: { value: "exclude" } });
  fireEvent.click(view.getByRole("button", { name: "Save Learning settings" }));
  await waitFor(() =>
    expect(saved).toEqual({
      enabled: false,
      defaultTarget: { containerId: "support" },
      agents: { bot: null },
    }),
  );
  await view.findByText("Settings saved.");
});

test("an unavailable settings store shows an error instead of an editable empty configuration", async () => {
  global.fetch = Object.assign(
    async () =>
      Response.json(
        { error: "Learning settings could not be accessed." },
        { status: 503 },
      ),
    { preconnect: originalFetch.preconnect },
  );
  const view = page();
  await waitFor(() =>
    expect(
      view.getAllByText("Learning settings could not be accessed.").length,
    ).toBeGreaterThan(0),
  );
  expect(
    view.queryByRole("button", { name: "Save Learning settings" }),
  ).toBeNull();
});

test("active and hidden Bots both have participation controls", async () => {
  const bot = (id: string) => ({
    id,
    name: id,
    title: "Bot",
    roleDescription: "Helps",
    avatarSeed: id,
    visibility: "public",
    endpoint: null,
    builtIn: true,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: id === "hidden-bot",
    systemOwned: true,
    canManage: true,
    mine: false,
  });
  global.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/settings"))
        return Response.json({
          settings: { enabled: false, defaultTarget: null, agents: {} },
        });
      if (path === "/api/agents?hidden=true")
        return Response.json({ agents: [bot("hidden-bot")] });
      if (path === "/api/agents")
        return Response.json({ agents: [bot("active-bot")] });
      return Response.json({ error: "Unavailable" }, { status: 502 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = page();
  await view.findByLabelText("hidden-bot participation");
  expect(view.queryByLabelText("active-bot participation")).not.toBeNull();
});

function serve(body: unknown) {
  global.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/settings")) return Response.json(body);
      if (path.includes("/api/agents")) return Response.json({ agents: [] });
      return Response.json({ error: "unavailable" }, { status: 502 });
    },
    { preconnect: originalFetch.preconnect },
  );
}

test.each([
  [
    { enabled: true, defaultTarget: null, agents: {} },
    { state: "absent", containerId: "openbot" },
    'This project has no "openbot" Learning container yet',
  ],
  [
    { enabled: true, defaultTarget: { containerId: "openbot" }, agents: {} },
    { state: "assigned", containerId: "openbot" },
    'OpenBot assigned this project\'s "openbot" container automatically',
  ],
  [
    { enabled: true, defaultTarget: null, agents: {} },
    { state: "not_entitled" },
    "plan doesn't include Learning",
  ],
] as const)(
  "the page says what automatic assignment found (%#)",
  async (settings, automatic, expected) => {
    serve({ settings, automatic });
    const view = page();
    await view.findByText(expected, { exact: false });
  },
);

test("a deployment that chose its own container hears nothing about automatic assignment", async () => {
  serve({
    settings: {
      enabled: true,
      defaultTarget: { containerId: "support" },
      agents: {},
    },
    automatic: { state: "saved" },
  });
  const view = page();
  await view.findByLabelText("Default container ID");
  await waitFor(() =>
    expect(view.queryByText("Loading Learning settings…")).toBeNull(),
  );
  expect(view.queryByText("OpenBot assigned", { exact: false })).toBeNull();
  expect(
    view.queryByText("Learning container yet", { exact: false }),
  ).toBeNull();
});

test("a missing container shows exactly what to run, and a Create button only when the deployment can", async () => {
  const instructions =
    "Sign in once with npx --yes copilotkit@latest login, then run bun scripts/setup-learning.ts.";
  serve({
    settings: { enabled: true, defaultTarget: null, agents: {} },
    automatic: { state: "absent", containerId: "openbot", instructions },
  });
  const cannot = page();
  await cannot.findByText(instructions, { exact: false });
  expect(
    cannot.queryByRole("button", { name: "Create the openbot container" }),
  ).toBeNull();
  cleanup();

  let created = 0;
  const settings = { enabled: true, defaultTarget: null, agents: {} };
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/container") && init?.method === "POST") {
        created++;
        return Response.json({
          automatic: { state: "assigned", containerId: "openbot" },
        });
      }
      if (path.endsWith("/settings"))
        return Response.json({
          settings:
            created > 0
              ? { ...settings, defaultTarget: { containerId: "openbot" } }
              : settings,
          automatic:
            created > 0
              ? { state: "assigned", containerId: "openbot" }
              : {
                  state: "absent",
                  containerId: "openbot",
                  instructions,
                  canCreate: true,
                },
        });
      if (path.includes("/api/agents")) return Response.json({ agents: [] });
      return Response.json({ error: "unavailable" }, { status: 502 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const can = page();
  fireEvent.click(
    await can.findByRole("button", { name: "Create the openbot container" }),
  );
  await can.findByText("container automatically", { exact: false });
  expect(created).toBe(1);
  // Let the refetch the creation started settle before the DOM is torn down.
  await waitFor(() =>
    expect(
      can.queryByRole("button", { name: "Create the openbot container" }),
    ).toBeNull(),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
});

describe("reviewing proposed skills", () => {
  const PROPOSAL = "0198a012-a20f-77c0-9e33-8992f18e74d1";
  const SKILL_MD =
    "---\nname: Refund triage\ndescription: Sort refund requests.\n---\n\n# Refund triage\n\n1. Read the order date from the conversation.\n";
  const pending: LearningProposal = {
    id: PROPOSAL,
    title: "Refund triage",
    description:
      "Sort refund requests by whether they are inside the 30-day window.",
    reason: "Three support conversations checked the order date by hand.",
    operation: "add",
    status: "pending_review",
    createdAt: "2026-11-04T12:00:00.000Z",
    reviewedAt: null,
  };
  const PERSON = "user-dana";
  const PERSON_PROPOSAL = "0198a012-a20f-77c0-9e33-8992f18e74d2";
  const personPending: LearningProposal = {
    ...pending,
    id: PERSON_PROPOSAL,
    title: "Quote follow-up",
    description: "Send a follow-up after a quote goes quiet.",
  };
  const detail: LearningProposalDetail = {
    ...pending,
    files: [
      { path: "SKILL.md", content: SKILL_MD },
      { path: "references/policy.md", content: "Refunds inside 30 days." },
    ],
    insights: [
      {
        id: "0198a012-a20f-77c0-9e33-8992f18e74a9",
        statement: "Agents look up the order date before every refund answer.",
        impact: "Answers refund questions without a hand check.",
        evidence: [
          {
            kind: "conversation",
            id: "thread-1",
            title: "Refund for order 1182",
            available: true,
            messages: [
              {
                id: "message-1",
                role: "user",
                content: "Can I get a refund on order 1182?",
              },
            ],
          },
        ],
      },
    ],
  };
  const noDashboard: LearningOverview = {
    configuration: "configured",
    container: { id: "openbot", name: "OpenBot" },
    pendingThreadCount: null,
    pendingCandidateCount: 1,
    publishedSkillCount: null,
    insightCount: null,
    hasActiveRun: false,
    latestRunStatus: null,
    links: { learning: null, candidates: null, runs: null },
  };
  afterEach(() => queryClient.clear());

  /** The page on the app's own query client, as it runs, so a decision refreshes the list. */
  function shared() {
    const rootRoute = createRootRoute({ component: LearningPage });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  }

  function intelligence(overview: LearningOverview = noDashboard) {
    let status: LearningProposal["status"] = "pending_review";
    let personStatus: LearningProposal["status"] = "pending_review";
    let sharingDecided = false;
    const posts: string[] = [];
    const bodies: unknown[] = [];
    const gets: string[] = [];
    global.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (init?.method === "POST") {
          posts.push(path);
          bodies.push(init.body);
        } else if (!init?.method) gets.push(path);
        if (path.endsWith("/settings"))
          return Response.json({
            settings: {
              enabled: true,
              defaultTarget: { containerId: "openbot" },
              agents: {},
            },
            automatic: { state: "saved" },
          });
        if (path.includes("/api/agents")) return Response.json({ agents: [] });
        if (path === "/api/admin/learning/people/proposals")
          return Response.json({
            people: [
              {
                userId: PERSON,
                name: "Dana Reyes",
                proposals: [{ ...personPending, status: personStatus }],
              },
              { userId: "user-unreadable", name: "Sam Ortiz", proposals: null },
            ],
          });
        if (
          path ===
          `/api/admin/learning/people/${PERSON}/proposals/${PERSON_PROPOSAL}/reject`
        ) {
          personStatus = "rejected";
          return Response.json({
            proposal: { id: PERSON_PROPOSAL, status: personStatus },
          });
        }
        if (
          path ===
          `/api/admin/learning/people/${PERSON}/proposals/${PERSON_PROPOSAL}/approve`
        ) {
          personStatus = "approved";
          return Response.json({
            proposal: { id: PERSON_PROPOSAL, status: personStatus },
          });
        }
        if (
          path ===
          `/api/admin/learning/people/${PERSON}/proposals/${PERSON_PROPOSAL}`
        )
          return Response.json({
            proposal: {
              ...detail,
              ...personPending,
              status: personStatus,
            },
          });
        if (path === "/api/admin/learning/sharing-requests")
          return Response.json({
            requests: sharingDecided
              ? []
              : [
                  {
                    userId: PERSON,
                    name: "Dana Reyes",
                    skillName: "quote-follow-up",
                    requestedAt: "2026-11-05T09:00:00.000Z",
                  },
                ],
          });
        if (
          path ===
          `/api/admin/learning/sharing-requests/${PERSON}/quote-follow-up/approve`
        ) {
          sharingDecided = true;
          return Response.json({ sharing: "approved" });
        }
        if (
          path === `/api/admin/learning/people/${PERSON}/skills/quote-follow-up`
        )
          return Response.json({
            skill: {
              name: "quote-follow-up",
              description: "Follow up on a quiet quote.",
              files: [
                {
                  path: "SKILL.md",
                  text: "---\nname: quote-follow-up\n---\n\nAsk whether the quote still fits.\n",
                },
              ],
            },
          });
        if (path.startsWith("/api/admin/learning/overview"))
          return Response.json({ overview });
        if (path === `/api/admin/learning/proposals/${PROPOSAL}/reject`) {
          status = "rejected";
          return Response.json({ proposal: { id: PROPOSAL, status } });
        }
        if (path === `/api/admin/learning/proposals/${PROPOSAL}/approve`) {
          status = "approved";
          return Response.json({ proposal: { id: PROPOSAL, status } });
        }
        if (path === `/api/admin/learning/proposals/${PROPOSAL}`)
          return Response.json({ proposal: { ...detail, status } });
        if (path === "/api/admin/learning/proposals")
          return Response.json({
            containerId: "openbot",
            proposals: [{ ...pending, status }],
          });
        if (path === "/api/admin/learning/skills")
          return Response.json({
            containerId: "openbot",
            skills: [
              {
                name: "invoice-lookup",
                description: "Find an invoice by number.",
              },
            ],
          });
        if (path === "/api/admin/learning/skills/invoice-lookup")
          return Response.json({
            skill: {
              name: "invoice-lookup",
              description: "Find an invoice by number.",
              files: [
                {
                  path: "SKILL.md",
                  text: "---\nname: invoice-lookup\n---\n\nSearch billing for the invoice number.\n",
                },
              ],
            },
          });
        if (path === "/api/admin/learning/runs" && init?.method !== "POST")
          return Response.json({ containerId: "openbot", runs: [] });
        if (path === "/api/admin/learning/runs")
          return Response.json({
            run: {
              id: "0198a012-a20f-77c0-9e33-8992f18e74c1",
              status: "queued",
            },
          });
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
      { preconnect: originalFetch.preconnect },
    );
    const recorded = Object.assign(posts, { bodies, gets });
    record = (path, init) => {
      if (init?.method === "POST") {
        posts.push(path);
        bodies.push(init.body);
      } else if (!init?.method) gets.push(path);
    };
    return recorded;
  }

  let record: (path: string, init?: RequestInit) => void = () => {};

  /** Answer some paths yourself and leave the rest to what `intelligence()` installed. */
  function override(
    handler: (path: string, init?: RequestInit) => Response | undefined,
  ) {
    const base = global.fetch;
    global.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const answer = handler(String(input), init);
        if (answer) record(String(input), init);
        return answer ?? base(input, init);
      },
      { preconnect: originalFetch.preconnect },
    );
  }

  test("lists proposed skills, opens one with its SKILL.md and evidence, and approves it", async () => {
    const posts = intelligence();
    const view = shared();
    fireEvent.click(await view.findByRole("button", { name: /Refund triage/ }));
    await view.findByText("Read the order date from the conversation.");
    expect(view.getByText("Can I get a refund on order 1182?")).not.toBeNull();
    expect(view.getByText("references/policy.md")).not.toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Approve and publish" }));
    await view.findByText("Published. Bots on this container use it", {
      exact: false,
    });
    expect([...posts]).toEqual([
      `/api/admin/learning/proposals/${PROPOSAL}/approve`,
    ]);
    fireEvent.click(view.getByRole("button", { name: "Done" }));
    // The list refreshed from the server, not from a guess.
    await waitFor(() =>
      expect(
        view.getByRole("button", { name: /Refund triage/ }).textContent,
      ).toContain("Published"),
    );
  });

  test("an admin approves a person's proposal", async () => {
    const posts = intelligence();
    const view = shared();
    const row = await view.findByRole("button", { name: /Quote follow-up/ });
    expect(row.textContent).toContain("Dana Reyes");
    await view.findByText("Couldn't read Sam Ortiz's skills.", {
      exact: false,
    });
    fireEvent.click(row);
    await view.findByText("Read the order date from the conversation.");
    fireEvent.click(view.getByRole("button", { name: "Approve and publish" }));
    await view.findByText("Their Bots use it from their next conversation.", {
      exact: false,
    });
    expect([...posts]).toEqual([
      `/api/admin/learning/people/${PERSON}/proposals/${PERSON_PROPOSAL}/approve`,
    ]);
  });

  test("an admin approves a sharing request", async () => {
    const posts = intelligence();
    const view = shared();
    const row = await view.findByRole("button", { name: /Quote follow up/ });
    expect(row.textContent).toContain("Dana Reyes");
    fireEvent.click(row);
    await view.findByText("Ask whether the quote still fits.");
    fireEvent.click(view.getByRole("button", { name: "Approve sharing" }));
    await waitFor(() =>
      expect([...posts]).toEqual([
        `/api/admin/learning/sharing-requests/${PERSON}/quote-follow-up/approve`,
      ]),
    );
    expect(JSON.parse(String(posts.bodies.at(-1)))).toEqual({
      requestedAt: "2026-11-05T09:00:00.000Z",
    });
    await waitFor(() =>
      expect(
        view.queryByRole("button", { name: /Quote follow up/ }),
      ).toBeNull(),
    );
  });

  const SHARING = `/api/admin/learning/sharing-requests/${PERSON}/quote-follow-up`;
  const CHANGED =
    "This skill changed after you opened it. Open it again to see the new version.";

  test("an admin declines a sharing request", async () => {
    const posts = intelligence();
    override((path) =>
      path === `${SHARING}/decline`
        ? Response.json({ sharing: "declined" })
        : undefined,
    );
    const view = shared();
    fireEvent.click(
      await view.findByRole("button", { name: /Quote follow up/ }),
    );
    await view.findByText("Ask whether the quote still fits.");
    fireEvent.click(view.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect([...posts]).toEqual([`${SHARING}/decline`]));
    expect(JSON.parse(String(posts.bodies.at(-1)))).toEqual({
      requestedAt: "2026-11-05T09:00:00.000Z",
    });
  });

  test("after a refused sharing decision, approving again sends the request's current version", async () => {
    let requestedAt = "2026-11-05T09:00:00.000Z";
    let decided = false;
    const sent: string[] = [];
    const posts = intelligence();
    override((path, init) => {
      if (path === "/api/admin/learning/sharing-requests")
        return Response.json({
          requests: decided
            ? []
            : [
                {
                  userId: PERSON,
                  name: "Dana Reyes",
                  skillName: "quote-follow-up",
                  requestedAt,
                },
              ],
        });
      if (path === `${SHARING}/approve`) {
        const sentAt = JSON.parse(String(init?.body)).requestedAt;
        sent.push(sentAt);
        if (sentAt !== "2026-11-06T08:00:00.000Z") {
          requestedAt = "2026-11-06T08:00:00.000Z";
          return Response.json({ error: CHANGED }, { status: 409 });
        }
        decided = true;
        return Response.json({ sharing: "approved" });
      }
      return undefined;
    });
    const view = shared();
    fireEvent.click(
      await view.findByRole("button", { name: /Quote follow up/ }),
    );
    await view.findByText("Ask whether the quote still fits.");
    fireEvent.click(view.getByRole("button", { name: "Approve sharing" }));
    const alert = await view.findByRole("alert");
    expect(alert.textContent).toBe(CHANGED);
    expect(
      view.queryByText("Ask whether the quote still fits."),
    ).not.toBeNull();
    await waitFor(() =>
      expect(
        (
          view.getByRole("button", {
            name: "Approve sharing",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(view.getByRole("button", { name: "Approve sharing" }));
    await waitFor(() =>
      expect(sent).toEqual([
        "2026-11-05T09:00:00.000Z",
        "2026-11-06T08:00:00.000Z",
      ]),
    );
    expect(posts.length).toBe(2);
    await waitFor(() =>
      expect(
        view.queryByRole("button", { name: /Quote follow up/ }),
      ).toBeNull(),
    );
  });

  test("a sharing decision waits for the skill to be shown", async () => {
    const posts = intelligence();
    let release: (response: Response) => void = () => {};
    const base = global.fetch;
    global.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) =>
        String(input) ===
        `/api/admin/learning/people/${PERSON}/skills/quote-follow-up`
          ? new Promise<Response>((resolve) => {
              release = resolve;
            })
          : base(input, init),
      { preconnect: originalFetch.preconnect },
    );
    const view = shared();
    fireEvent.click(
      await view.findByRole("button", { name: /Quote follow up/ }),
    );
    const approve = await view.findByRole("button", {
      name: "Approve sharing",
    });
    const decline = view.getByRole("button", { name: "Decline" });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect((decline as HTMLButtonElement).disabled).toBe(true);
    release(
      Response.json({
        skill: {
          name: "quote-follow-up",
          description: "Follow up on a quiet quote.",
          files: [
            { path: "SKILL.md", text: "Ask whether the quote still fits.\n" },
          ],
        },
      }),
    );
    await view.findByText("Ask whether the quote still fits.");
    await waitFor(() =>
      expect((approve as HTMLButtonElement).disabled).toBe(false),
    );
    expect([...posts]).toEqual([]);
  });

  test("a sharing decision stays off when the skill could not be read", async () => {
    const posts = intelligence();
    override((path) =>
      path === `/api/admin/learning/people/${PERSON}/skills/quote-follow-up`
        ? Response.json({ error: "Couldn't read this skill." }, { status: 503 })
        : undefined,
    );
    const view = shared();
    fireEvent.click(
      await view.findByRole("button", { name: /Quote follow up/ }),
    );
    await view.findByText("Couldn't read this skill.");
    expect(
      (
        view.getByRole("button", {
          name: "Approve sharing",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (view.getByRole("button", { name: "Decline" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect([...posts]).toEqual([]);
  });

  test("an admin rejects a proposed skill", async () => {
    const posts = intelligence();
    const view = shared();
    fireEvent.click(await view.findByRole("button", { name: /Refund triage/ }));
    await view.findByText("Read the order date from the conversation.");
    fireEvent.click(view.getByRole("button", { name: "Reject" }));
    await view.findByText("Rejected. It won't be published.");
    expect([...posts]).toEqual([
      `/api/admin/learning/proposals/${PROPOSAL}/reject`,
    ]);
  });

  test("a failed approve of a proposed skill shows why and leaves the choice open", async () => {
    intelligence();
    override((path) =>
      path === `/api/admin/learning/proposals/${PROPOSAL}/approve`
        ? Response.json(
            { error: "Couldn't publish this skill." },
            { status: 502 },
          )
        : undefined,
    );
    const view = shared();
    fireEvent.click(await view.findByRole("button", { name: /Refund triage/ }));
    await view.findByText("Read the order date from the conversation.");
    fireEvent.click(view.getByRole("button", { name: "Approve and publish" }));
    await view.findByText("Couldn't publish this skill.");
    expect(
      view.queryByRole("button", { name: "Approve and publish" }),
    ).not.toBeNull();
    expect(view.queryByRole("button", { name: "Reject" })).not.toBeNull();
  });

  test("an admin rejects a person's proposal", async () => {
    const posts = intelligence();
    const view = shared();
    fireEvent.click(
      await view.findByRole("button", { name: /Quote follow-up/ }),
    );
    await view.findByText("Read the order date from the conversation.");
    fireEvent.click(view.getByRole("button", { name: "Reject" }));
    await view.findByText("Rejected. It won't be published.");
    expect([...posts]).toEqual([
      `/api/admin/learning/people/${PERSON}/proposals/${PERSON_PROPOSAL}/reject`,
    ]);
  });

  test("a failed approve of a person's proposal shows why", async () => {
    intelligence();
    override((path) =>
      path ===
      `/api/admin/learning/people/${PERSON}/proposals/${PERSON_PROPOSAL}/approve`
        ? Response.json(
            { error: "Couldn't publish this skill." },
            { status: 502 },
          )
        : undefined,
    );
    const view = shared();
    fireEvent.click(
      await view.findByRole("button", { name: /Quote follow-up/ }),
    );
    await view.findByText("Read the order date from the conversation.");
    fireEvent.click(view.getByRole("button", { name: "Approve and publish" }));
    await view.findByText("Couldn't publish this skill.");
    expect(
      view.queryByRole("button", { name: "Approve and publish" }),
    ).not.toBeNull();
  });

  test("when settings fail to load, each approval section says so instead of vanishing", async () => {
    intelligence();
    override((path) =>
      path.endsWith("/settings")
        ? Response.json(
            { error: "Learning settings could not be accessed." },
            { status: 503 },
          )
        : path === "/api/admin/learning/sharing-requests"
          ? Response.json({ requests: [] })
          : undefined,
    );
    const view = shared();
    // The app's query client retries a failed read once, a second later.
    const slow = { timeout: 3000 };
    await view.findByText("Approval", {}, slow);
    await view.findByText("From people's recordings", {}, slow);
    await view.findByText("Sharing requests", {}, slow);
    expect(
      view.getAllByText("Learning settings could not be accessed.").length,
    ).toBeGreaterThanOrEqual(4);
  });

  test("Nothing to review is not said while someone's skills could not be read", async () => {
    intelligence();
    override((path) =>
      path === "/api/admin/learning/people/proposals"
        ? Response.json({
            people: [
              { userId: "user-unreadable", name: "Sam Ortiz", proposals: null },
            ],
          })
        : undefined,
    );
    const view = shared();
    await view.findByText("Couldn't read Sam Ortiz's skills.", {
      exact: false,
    });
    expect(view.queryByText("Nothing to review")).toBeNull();
  });

  test("Who approves cannot be closed while it saves, so the result stays in view", async () => {
    intelligence();
    let release: (response: Response) => void = () => {};
    const base = global.fetch;
    global.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === "/api/admin/learning/personal-review"
          ? new Promise<Response>((resolve) => {
              release = resolve;
            })
          : base(input, init),
      { preconnect: originalFetch.preconnect },
    );
    const view = shared();
    fireEvent.click(
      await view.findByRole("button", {
        name: /Who approves skills learned from people's recordings/,
      }),
    );
    fireEvent.click(
      await view.findByRole("button", {
        name: /Each person, for their own Bots/,
      }),
    );
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    await view.findByRole("button", { name: "Saving…" });
    const cancel = view.getByRole("button", {
      name: "Cancel",
    }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    release(
      Response.json({ error: "Couldn't save who approves." }, { status: 500 }),
    );
    await view.findByText("Couldn't save who approves.");
  });

  test("Refresh status also reads proposed skills, analysis runs and published skills again", async () => {
    const posts = intelligence();
    const view = shared();
    await view.findByRole("button", { name: /Invoice lookup/ });
    const count = (path: string) =>
      posts.gets.filter((get) => get === path).length;
    const before = [
      "/api/admin/learning/runs",
      "/api/admin/learning/proposals",
      "/api/admin/learning/skills",
    ].map(count);
    fireEvent.click(view.getByRole("button", { name: "Refresh status" }));
    await waitFor(() =>
      expect(
        [
          "/api/admin/learning/runs",
          "/api/admin/learning/proposals",
          "/api/admin/learning/skills",
        ].map(count),
      ).toEqual(before.map((n) => n + 1)),
    );
  });

  test("a run that failed says so in plain words, and with no container says so like the sections beside it", async () => {
    intelligence();
    override((path, init) =>
      path === "/api/admin/learning/runs" && !init?.method
        ? Response.json({
            containerId: "openbot",
            runs: [
              {
                id: "0198a012-a20f-77c0-9e33-8992f18e74c3",
                status: "failed",
                trigger: "automatic",
                proposals: null,
                insights: null,
                failureCode: "LEARNING_MODEL_NOT_CONFIGURED",
                createdAt: "2026-11-04T10:00:00.000Z",
                startedAt: null,
                completedAt: null,
              },
              {
                id: "0198a012-a20f-77c0-9e33-8992f18e74c4",
                status: "failed",
                trigger: "automatic",
                proposals: null,
                insights: null,
                failureCode: "SOMETHING_NEW",
                createdAt: "2026-11-03T10:00:00.000Z",
                startedAt: null,
                completedAt: null,
              },
            ],
          })
        : undefined,
    );
    const view = shared();
    await view.findByText("The backend has no model set up for Learning yet.");
    expect(view.getByText("The run failed.")).not.toBeNull();
    expect(view.queryByText("LEARNING_MODEL_NOT_CONFIGURED")).toBeNull();
    cleanup();
    queryClient.clear();
    intelligence();
    override((path, init) =>
      path === "/api/admin/learning/runs" && !init?.method
        ? Response.json({ containerId: null, runs: [] })
        : undefined,
    );
    const none = shared();
    await none.findByText("Analysis runs");
    await none.findByText("No container");
    expect(none.queryByText("No analysis runs yet")).toBeNull();
  });

  test("runs are polled while one is queued or running, and not otherwise", () => {
    const run = (status: LearningRunSummary["status"]) =>
      ({ status }) as LearningRunSummary;
    expect(runPollInterval([run("succeeded"), run("queued")])).toBe(10_000);
    expect(runPollInterval([run("batching")])).toBe(10_000);
    expect(runPollInterval([run("succeeded"), run("failed")])).toBe(false);
    expect(runPollInterval([])).toBe(false);
    expect(runPollInterval(undefined)).toBe(false);
  });

  test("a failed sharing requests read shows its error instead of hiding the section", async () => {
    intelligence();
    const base = global.fetch;
    global.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === "/api/admin/learning/sharing-requests"
          ? new Response("{}", { status: 500 })
          : base(input, init),
      { preconnect: originalFetch.preconnect },
    );
    const view = shared();
    await view.findByText("Sharing requests");
    await view.findByText("Couldn't load sharing requests. Try again.");
  });

  test("people's proposals are not listed once each person approves their own", async () => {
    const posts = intelligence();
    const base = global.fetch;
    global.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).endsWith("/settings")
          ? Response.json({
              settings: {
                enabled: true,
                defaultTarget: { containerId: "openbot" },
                agents: {},
                personalReview: "people",
              },
              automatic: { state: "saved" },
            })
          : base(input, init),
      { preconnect: originalFetch.preconnect },
    );
    const view = shared();
    await view.findByRole("button", { name: /Refund triage/ });
    expect(view.queryByRole("button", { name: /Quote follow-up/ })).toBeNull();
    await view.findByText("Sharing requests");
    expect(posts.gets).not.toContain("/api/admin/learning/people/proposals");
  });

  test("Who approves opens a dialog and saves people", async () => {
    intelligence();
    const base = global.fetch;
    const puts: { path: string; body: unknown }[] = [];
    global.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/admin/learning/personal-review") {
          puts.push({ path, body: JSON.parse(String(init?.body)) });
          return Response.json({
            settings: { enabled: true, agents: {}, personalReview: "people" },
          });
        }
        return base(input, init);
      },
      { preconnect: originalFetch.preconnect },
    );
    const view = shared();
    const row = await view.findByRole("button", {
      name: /Who approves skills learned from people's recordings/,
    });
    expect(row.textContent).toContain("Admins");
    fireEvent.click(row);
    fireEvent.click(
      await view.findByRole("button", {
        name: /Each person, for their own Bots/,
      }),
    );
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(puts).toEqual([
        {
          path: "/api/admin/learning/personal-review",
          body: { personalReview: "people" },
        },
      ]),
    );
  });

  test("saving Participation leaves who approves alone", async () => {
    intelligence();
    const base = global.fetch;
    const puts: { path: string; body: Record<string, unknown> }[] = [];
    global.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (init?.method === "PUT") {
          puts.push({ path, body: JSON.parse(String(init.body)) });
          return Response.json({
            settings: { enabled: false, agents: {}, personalReview: "people" },
          });
        }
        if (path.endsWith("/settings"))
          return Response.json({
            settings: {
              enabled: true,
              defaultTarget: { containerId: "openbot" },
              agents: {},
              personalReview: "admins",
              autoApprove: true,
            },
            automatic: { state: "saved" },
          });
        return base(input, init);
      },
      { preconnect: originalFetch.preconnect },
    );
    const view = shared();
    fireEvent.click(await view.findByLabelText(/Turn on automatic learning/));
    fireEvent.click(
      await view.findByRole("button", {
        name: /Who approves skills learned from people's recordings/,
      }),
    );
    fireEvent.click(
      await view.findByRole("button", {
        name: /Each person, for their own Bots/,
      }),
    );
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(puts.map((put) => put.path)).toContain(
        "/api/admin/learning/personal-review",
      ),
    );
    fireEvent.click(
      view.getByRole("button", { name: "Save Learning settings" }),
    );
    await waitFor(() =>
      expect(puts.some((put) => put.path.endsWith("/settings"))).toBe(true),
    );
    const settingsPut = puts.find((put) => put.path.endsWith("/settings"));
    expect(settingsPut?.body.enabled).toBe(false);
    expect("personalReview" in (settingsPut?.body ?? {})).toBe(false);
    expect("autoApprove" in (settingsPut?.body ?? {})).toBe(false);
  });

  test("Published skills lists the container's skills and opens one", async () => {
    intelligence();
    const view = shared();
    await view.findByText("Published skills");
    fireEvent.click(
      await view.findByRole("button", { name: /Invoice lookup/ }),
    );
    await view.findByText("Search billing for the invoice number.");
  });

  test("Learn now starts Learning on the container shown", async () => {
    const posts = intelligence();
    const view = shared();
    await view.findByRole("button", { name: /Refund triage/ });
    fireEvent.click(view.getByRole("button", { name: "Learn now" }));
    await view.findByText("Learning started.", { exact: false });
    expect([...posts]).toEqual(["/api/admin/learning/runs"]);
  });

  test("lists analysis runs and drops the link out to them", async () => {
    const runsLink = "https://app.intelligence.example/o/acme/support/runs";
    const runs: LearningRunSummary[] = [
      {
        id: "0198a012-a20f-77c0-9e33-8992f18e74c2",
        status: "succeeded",
        trigger: "manual",
        proposals: 2,
        insights: 5,
        failureCode: null,
        createdAt: "2026-11-05T10:00:00.000Z",
        startedAt: "2026-11-05T10:00:01.000Z",
        completedAt: "2026-11-05T10:03:00.000Z",
      },
      {
        id: "0198a012-a20f-77c0-9e33-8992f18e74c3",
        status: "failed",
        trigger: "automatic",
        proposals: null,
        insights: null,
        failureCode: "LEARNING_MODEL_NOT_CONFIGURED",
        createdAt: "2026-11-04T10:00:00.000Z",
        startedAt: null,
        completedAt: null,
      },
    ];
    intelligence({
      ...noDashboard,
      links: {
        learning: "https://app.intelligence.example/o/acme/support/learning",
        candidates: null,
        runs: runsLink,
      },
    });
    const fallback = global.fetch;
    global.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === "/api/admin/learning/runs" && !init?.method
          ? Response.json({ containerId: "openbot", runs })
          : fallback(input, init),
      { preconnect: originalFetch.preconnect },
    );
    const view = shared();
    await view.findByText("Analysis runs");
    await view.findByText("The backend has no model set up for Learning yet.");
    expect(view.queryByText("LEARNING_MODEL_NOT_CONFIGURED")).toBeNull();
    expect(view.getByText("Finished · Manual")).not.toBeNull();
    expect(view.getByText("Failed · Automatic")).not.toBeNull();
    await view.findByText("Manage Learning in the backend dashboard");
    const anchors = Array.from(view.container.querySelectorAll("a"));
    expect(anchors.some((a) => a.getAttribute("href") === runsLink)).toBe(
      false,
    );
  });

  test("a sign-in Learning can't use is said on the page, before anyone presses Learn now", async () => {
    const said =
      "Learning can't run on the model you signed in with. To use it, sign OpenBot in with an OpenAI or Anthropic API key, or a Claude or ChatGPT plan.";
    intelligence({ ...noDashboard, modelProblem: said });
    const view = shared();
    expect((await view.findByText(said)).getAttribute("role")).toBe("alert");
    cleanup();
    queryClient.clear();
    intelligence();
    const fine = shared();
    await fine.findByText("OpenBot (openbot)");
    expect(fine.queryByText(said)).toBeNull();
  });

  test("with no dashboard there is no link into one, and with one the links stay", async () => {
    intelligence();
    const without = shared();
    await without.findByText("OpenBot (openbot)");
    expect(
      without.queryByText("Manage Learning in the backend dashboard"),
    ).toBeNull();
    expect(without.queryByText("Threads ready")).toBeNull();
    expect(without.getByText("Candidates to review")).not.toBeNull();
    cleanup();
    queryClient.clear();
    intelligence({
      ...noDashboard,
      pendingThreadCount: 4,
      publishedSkillCount: 2,
      insightCount: 3,
      links: {
        learning: "https://app.intelligence.example/o/acme/support/learning",
        candidates: null,
        runs: null,
      },
    });
    const managed = shared();
    expect(
      (
        await managed.findByText("Manage Learning in the backend dashboard")
      ).getAttribute("href"),
    ).toBe("https://app.intelligence.example/o/acme/support/learning");
    expect(managed.getByText("Threads ready")).not.toBeNull();
  });
});

test("an Intelligence with Learning switched off says so, not that it can't be reached", async () => {
  serve({
    settings: { enabled: true, defaultTarget: null, agents: {} },
    automatic: { state: "learning_off" },
  });
  const view = page();
  await view.findByText("Learning is switched off in the backend", {
    exact: false,
  });
  expect(
    view.queryByText("Couldn't reach the backend", { exact: false }),
  ).toBeNull();
});

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  LearningEvidence,
  LearningProposal,
  LearningProposalDetail,
} from "@/lib/api/generated/model";
import type {
  LearningOverview,
  LearningRunSummary,
} from "@/lib/learning/queries";
import { queryClient } from "@/query-client";
import { LearningPage, runPollInterval } from "@/routes/_authed/admin/learning";
import { answerBotsList } from "./bots-api";
import {
  LEARNING,
  learningConfigurationBody,
  learningContract,
  page as listPage,
  personLearning,
  problem,
  requestOf,
  runBody,
  served,
} from "./learning-api";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
const originalFetch = global.fetch;
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

/** What the server says when it can't reach Learning (LEARNING_UNREACHABLE). */
const UNREACHABLE = "Couldn't reach Learning in the backend. Try again.";
/** What the server says when Learning couldn't read the skills (LEARNING_UNAVAILABLE). */
const UNAVAILABLE =
  "Couldn't read your Skills from the backend just now. Try again.";

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

/** Learning's settings and what automatic assignment found, as reading them answers. */
const configuration = (
  settings: Record<string, unknown>,
  automatic: Record<string, unknown> | null = null,
) =>
  served(
    learningContract.GetLearningSettingsResponse,
    learningConfigurationBody({ settings, automatic }),
  );

test("an administrator excludes a Bot and saves without losing the default or pause state", async () => {
  let settings: Record<string, unknown> = {
    enabled: false,
    defaultTarget: { containerId: "support" },
    bots: { bot: { containerId: "sales" } },
  };
  let saved: Record<string, unknown> | null = null;
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = requestOf(input, init);
      if (request.path === LEARNING.settings) {
        if (request.method === "PATCH") {
          saved = request.body;
          settings = { ...settings, ...saved };
          return served(
            learningContract.UpdateLearningSettingsResponse,
            learningConfigurationBody({ settings }),
          );
        }
        return configuration(settings);
      }
      const bots = answerBotsList(input, init, { visible: [] });
      if (bots) return bots;
      return problem(502, UNREACHABLE, "LEARNING_UNREACHABLE");
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = page();
  const user = userEvent.setup({ document });
  await user.click(
    await view.findByRole("combobox", { name: "bot participation" }),
  );
  await user.click(
    await view.findByRole("option", { name: "Leave out of Learning" }),
  );
  fireEvent.click(view.getByRole("button", { name: "Save Learning settings" }));
  await waitFor(() =>
    expect(saved).toEqual({
      enabled: false,
      defaultTarget: { containerId: "support" },
      bots: { bot: null },
    }),
  );
  await view.findByText("Settings saved.");
});

test("an unavailable settings store shows an error instead of an editable empty configuration", async () => {
  global.fetch = Object.assign(
    async () =>
      problem(
        500,
        "Learning settings could not be accessed.",
        "INTERNAL_ERROR",
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
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestOf(input, init).path === LEARNING.settings)
        return configuration({ enabled: false });
      const bots = answerBotsList(input, init, {
        visible: [bot("active-bot")],
        hidden: [bot("hidden-bot")],
      });
      if (bots) return bots;
      return problem(502, UNREACHABLE, "LEARNING_UNREACHABLE");
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = page();
  await view.findByLabelText("hidden-bot participation");
  expect(view.queryByLabelText("active-bot participation")).not.toBeNull();
});

// Seen in WebKit: the page's native select and checkbox drew as grey system boxes, unlike every other control.
test("Automatic learning draws OpenBot's own controls, not the browser's", async () => {
  serve(
    {
      enabled: true,
      defaultTarget: { containerId: "openbot" },
      bots: { bot: { containerId: "sales" } },
    },
    { state: "saved" },
  );
  const view = page();
  const participation = await view.findByRole("combobox", {
    name: "bot participation",
  });
  expect(participation.getAttribute("data-slot")).toBe("select-trigger");
  expect(
    view
      .getByRole("combobox", { name: "Show the container for" })
      .getAttribute("data-slot"),
  ).toBe("select-trigger");
  expect(
    view
      .getByRole("checkbox", { name: /Turn on automatic learning/ })
      .getAttribute("data-slot"),
  ).toBe("checkbox");
  expect(view.container.querySelector("select")).toBeNull();
});

function serve(
  settings: Record<string, unknown>,
  automatic: Record<string, unknown> | null,
) {
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestOf(input, init).path === LEARNING.settings)
        return configuration(settings, automatic);
      const bots = answerBotsList(input, init, { visible: [] });
      if (bots) return bots;
      return problem(502, UNREACHABLE, "LEARNING_UNREACHABLE");
    },
    { preconnect: originalFetch.preconnect },
  );
}

test.each([
  [
    { enabled: true, defaultTarget: null },
    { state: "absent", containerId: "openbot" },
    'This project has no "openbot" Learning container yet',
  ],
  [
    { enabled: true, defaultTarget: { containerId: "openbot" } },
    { state: "assigned", containerId: "openbot" },
    'OpenBot assigned this project\'s "openbot" container automatically',
  ],
  [
    { enabled: true, defaultTarget: null },
    { state: "not_entitled" },
    "plan doesn't include Learning",
  ],
] as const)(
  "the page says what automatic assignment found (%#)",
  async (settings, automatic, expected) => {
    serve(settings, automatic);
    const view = page();
    await view.findByText(expected, { exact: false });
  },
);

test("a deployment that chose its own container hears nothing about automatic assignment", async () => {
  serve(
    { enabled: true, defaultTarget: { containerId: "support" } },
    { state: "saved" },
  );
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
  serve(
    { enabled: true, defaultTarget: null },
    { state: "absent", containerId: "openbot", instructions },
  );
  const cannot = page();
  await cannot.findByText(instructions, { exact: false });
  expect(
    cannot.queryByRole("button", { name: "Create the openbot container" }),
  ).toBeNull();
  cleanup();

  let created = 0;
  const settings = { enabled: true, defaultTarget: null };
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = requestOf(input, init);
      if (
        request.path === LEARNING.createContainer &&
        request.method === "POST"
      ) {
        created++;
        return served(learningContract.CreateAutomaticLearningSpaceResponse, {
          automatic: { state: "assigned", containerId: "openbot" },
        });
      }
      if (request.path === LEARNING.settings)
        return configuration(
          created > 0
            ? { ...settings, defaultTarget: { containerId: "openbot" } }
            : settings,
          created > 0
            ? { state: "assigned", containerId: "openbot" }
            : {
                state: "absent",
                containerId: "openbot",
                instructions,
                canCreate: true,
              },
        );
      const bots = answerBotsList(input, init, { visible: [] });
      if (bots) return bots;
      return problem(502, UNREACHABLE, "LEARNING_UNREACHABLE");
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
  const INSIGHT = "0198a012-a20f-77c0-9e33-8992f18e74a9";
  const SKILL_MD =
    "---\nname: Refund triage\ndescription: Sort refund requests.\n---\n\n# Refund triage\n\n1. Read the order date from the conversation.\n";
  const pending: LearningProposal = {
    id: PROPOSAL,
    runId: "0198a012-a20f-77c0-9e33-8992f18e74c0",
    title: "Refund triage",
    description:
      "Sort refund requests by whether they are inside the 30-day window.",
    reason: "Three support conversations checked the order date by hand.",
    operation: "add",
    status: "pending_review",
    createdAt: "2026-11-04T12:00:00.000Z",
    reviewedAt: null,
    publishedSkillId: null,
  };
  const PERSON = "user-dana";
  /** The Learning space Dana's recordings join. */
  const PERSON_SPACE = "user-dana";
  const PERSON_PROPOSAL = "0198a012-a20f-77c0-9e33-8992f18e74d2";
  const DANA = personLearning(PERSON);
  const personPending: LearningProposal = {
    ...pending,
    id: PERSON_PROPOSAL,
    title: "Quote follow-up",
    description: "Send a follow-up after a quote goes quiet.",
  };
  const detail: LearningProposalDetail = {
    ...pending,
    files: [
      { path: "references/policy.md", content: "Refunds inside 30 days." },
      { path: "SKILL.md", content: SKILL_MD },
    ],
    insights: [
      {
        id: INSIGHT,
        statement: "Agents look up the order date before every refund answer.",
        impact: "Answers refund questions without a hand check.",
      },
    ],
  };
  const evidence: LearningEvidence[] = [
    {
      kind: "conversation",
      threadId: "thread-1",
      threadName: "Refund for order 1182",
      threadPresent: true,
      unavailable: null,
      messageCount: 1,
      cited: [
        {
          id: "message-1",
          role: "user",
          content: "Can I get a refund on order 1182?",
        },
      ],
    },
  ];
  /** The one sharing request waiting, by the id an admin decides it with. */
  const REQUEST = "sharing-request-1";
  const sharingRequest = (requestedAt: string) => ({
    id: REQUEST,
    personId: PERSON,
    name: "Dana Reyes",
    skillName: "quote-follow-up",
    requestedAt,
  });
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
  const settings = {
    enabled: true,
    defaultTarget: { containerId: "openbot" },
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

  /** A review as approving or rejecting a proposal answers it. */
  const reviewed = (proposalId: string, status: "approved" | "rejected") =>
    served(learningContract.ApproveLearningProposalResponse, {
      proposalId,
      operation: "add",
      status,
      publishedSkillId: status === "approved" ? "skill-1" : null,
    });

  /**
   * OpenBot's Learning API for the page, as the server answers it. Records each write (its address,
   * with any query, and its body) and each read's path.
   */
  function serveLearning(overview: LearningOverview = noDashboard) {
    let status: LearningProposal["status"] = "pending_review";
    let personStatus: LearningProposal["status"] = "pending_review";
    let sharingDecided = false;
    const posts: string[] = [];
    const bodies: unknown[] = [];
    const gets: string[] = [];
    global.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const request = requestOf(input, init);
        if (request.method === "GET") gets.push(request.path);
        else {
          posts.push(url);
          bodies.push(request.body);
        }
        if (request.path === LEARNING.settings && request.method === "GET")
          return configuration(settings, { state: "saved" });
        const bots = answerBotsList(input, init, { visible: [] });
        if (bots) return bots;
        if (request.path === LEARNING.peopleProposals)
          return listPage(
            learningContract.ListPersonalLearningProposalsResponse,
            "people",
            [
              {
                personId: PERSON,
                name: "Dana Reyes",
                containerId: PERSON_SPACE,
                proposals: [{ ...personPending, status: personStatus }],
              },
              {
                personId: "user-unreadable",
                name: "Sam Ortiz",
                containerId: "user-unreadable",
                proposals: null,
              },
            ],
          );
        if (request.path === `${DANA.proposal(PERSON_PROPOSAL)}/reject`) {
          personStatus = "rejected";
          return reviewed(PERSON_PROPOSAL, personStatus);
        }
        if (request.path === `${DANA.proposal(PERSON_PROPOSAL)}/approve`) {
          personStatus = "approved";
          return reviewed(PERSON_PROPOSAL, personStatus);
        }
        if (request.path === DANA.proposal(PERSON_PROPOSAL))
          return served(learningContract.GetPersonLearningProposalResponse, {
            ...detail,
            ...personPending,
            status: personStatus,
          });
        if (request.path === DANA.evidence(INSIGHT))
          return served(learningContract.GetPersonLearningEvidenceResponse, {
            evidence,
          });
        if (request.path === LEARNING.sharingRequests)
          return listPage(
            learningContract.ListSkillSharingRequestsResponse,
            "requests",
            sharingDecided ? [] : [sharingRequest("2026-11-05T09:00:00.000Z")],
          );
        if (request.path === LEARNING.sharingDecision(REQUEST, "approve")) {
          sharingDecided = true;
          return served(learningContract.ApproveSkillSharingResponse, {
            skillName: "quote-follow-up",
            sharing: "approved",
          });
        }
        if (request.path === DANA.learnedSkill("quote-follow-up"))
          return served(learningContract.GetLearnedSkillResponse, {
            name: "quote-follow-up",
            description: "Follow up on a quiet quote.",
            files: [
              {
                path: "SKILL.md",
                text: "---\nname: quote-follow-up\n---\n\nAsk whether the quote still fits.\n",
              },
            ],
          });
        if (request.path === LEARNING.overview)
          return served(learningContract.GetLearningOverviewResponse, overview);
        if (request.path === `${LEARNING.proposal(PROPOSAL)}/reject`) {
          status = "rejected";
          return reviewed(PROPOSAL, status);
        }
        if (request.path === `${LEARNING.proposal(PROPOSAL)}/approve`) {
          status = "approved";
          return reviewed(PROPOSAL, status);
        }
        if (request.path === LEARNING.proposal(PROPOSAL))
          return served(learningContract.GetLearningProposalResponse, {
            ...detail,
            status,
          });
        if (request.path === LEARNING.evidence(INSIGHT))
          return served(learningContract.GetLearningEvidenceResponse, {
            evidence,
          });
        if (request.path === LEARNING.proposals)
          return listPage(
            learningContract.ListLearningProposalsResponse,
            "proposals",
            [{ ...pending, status }],
          );
        if (request.path === LEARNING.skills)
          return served(learningContract.ListPublishedSkillsResponse, {
            containerId: "openbot",
            skills: [
              {
                name: "invoice-lookup",
                description: "Find an invoice by number.",
              },
            ],
            nextCursor: null,
          });
        if (request.path === LEARNING.skill("invoice-lookup"))
          return served(learningContract.GetPublishedSkillResponse, {
            name: "invoice-lookup",
            description: "Find an invoice by number.",
            files: [
              {
                path: "SKILL.md",
                text: "---\nname: invoice-lookup\n---\n\nSearch billing for the invoice number.\n",
              },
            ],
          });
        if (request.path === LEARNING.runs && request.method === "GET")
          return listPage(
            learningContract.ListOrganizationLearningRunsResponse,
            "runs",
            [],
          );
        if (request.path === LEARNING.runs)
          return served(
            learningContract.StartOrganizationLearningRunResponse,
            runBody({
              id: "0198a012-a20f-77c0-9e33-8992f18e74c1",
              status: "queued",
            }),
            202,
          );
        return problem(500, "unexpected", "INTERNAL_ERROR");
      },
      { preconnect: originalFetch.preconnect },
    );
    const recorded = Object.assign(posts, { bodies, gets });
    record = (input, init) => {
      const request = requestOf(input, init);
      if (request.method === "GET") gets.push(request.path);
      else {
        posts.push(String(input));
        bodies.push(request.body);
      }
    };
    return recorded;
  }

  let record: (input: string, init?: RequestInit) => void = () => {};

  /** Answer some requests yourself and leave the rest to what `serveLearning()` installed. */
  function override(
    handler: (
      request: ReturnType<typeof requestOf>,
      init?: RequestInit,
    ) => Response | undefined,
  ) {
    const base = global.fetch;
    global.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const answer = handler(requestOf(input, init), init);
        if (answer) record(String(input), init);
        return answer ?? base(input, init);
      },
      { preconnect: originalFetch.preconnect },
    );
  }

  test("lists proposed skills, opens one with its SKILL.md and evidence, and approves it", async () => {
    const posts = serveLearning();
    const view = shared();
    fireEvent.click(await view.findByRole("button", { name: /Refund triage/ }));
    await view.findByText("Read the order date from the conversation.");
    expect(view.getByText("Can I get a refund on order 1182?")).not.toBeNull();
    expect(view.getByText("references/policy.md")).not.toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Approve and publish" }));
    await view.findByText("Published. Bots on this container use it", {
      exact: false,
    });
    expect([...posts]).toEqual([`${LEARNING.proposal(PROPOSAL)}/approve`]);
    fireEvent.click(view.getByRole("button", { name: "Done" }));
    // The list refreshed from the server, not from a guess.
    await waitFor(() =>
      expect(
        view.getByRole("button", { name: /Refund triage/ }).textContent,
      ).toContain("Published"),
    );
  });

  test("an admin approves a person's proposal", async () => {
    const posts = serveLearning();
    const view = shared();
    const row = await view.findByRole("button", { name: /Quote follow-up/ });
    expect(row.textContent).toContain("Dana Reyes");
    await view.findByText("Couldn't read Sam Ortiz's skills.", {
      exact: false,
    });
    fireEvent.click(row);
    await view.findByText("Read the order date from the conversation.");
    expect(view.getByText("Can I get a refund on order 1182?")).not.toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Approve and publish" }));
    await view.findByText("Their Bots use it from their next conversation.", {
      exact: false,
    });
    expect([...posts]).toEqual([
      `${DANA.proposal(PERSON_PROPOSAL)}/approve?containerId=${PERSON_SPACE}`,
    ]);
  });

  test("an admin approves a sharing request", async () => {
    const posts = serveLearning();
    const view = shared();
    const row = await view.findByRole("button", { name: /Quote follow up/ });
    expect(row.textContent).toContain("Dana Reyes");
    fireEvent.click(row);
    await view.findByText("Ask whether the quote still fits.");
    fireEvent.click(view.getByRole("button", { name: "Approve sharing" }));
    await waitFor(() =>
      expect([...posts]).toEqual([
        LEARNING.sharingDecision(REQUEST, "approve"),
      ]),
    );
    expect(posts.bodies.at(-1)).toEqual({
      requestedAt: "2026-11-05T09:00:00.000Z",
    });
    await waitFor(() =>
      expect(
        view.queryByRole("button", { name: /Quote follow up/ }),
      ).toBeNull(),
    );
  });

  const CHANGED =
    "This skill changed after you opened it. Open it again to see the new version.";

  test("an admin declines a sharing request", async () => {
    const posts = serveLearning();
    override((request) =>
      request.path === LEARNING.sharingDecision(REQUEST, "decline")
        ? served(learningContract.DeclineSkillSharingResponse, {
            skillName: "quote-follow-up",
            sharing: "declined",
          })
        : undefined,
    );
    const view = shared();
    fireEvent.click(
      await view.findByRole("button", { name: /Quote follow up/ }),
    );
    await view.findByText("Ask whether the quote still fits.");
    fireEvent.click(view.getByRole("button", { name: "Decline" }));
    await waitFor(() =>
      expect([...posts]).toEqual([
        LEARNING.sharingDecision(REQUEST, "decline"),
      ]),
    );
    expect(posts.bodies.at(-1)).toEqual({
      requestedAt: "2026-11-05T09:00:00.000Z",
    });
  });

  test("after a refused sharing decision, approving again sends the request's current version", async () => {
    let requestedAt = "2026-11-05T09:00:00.000Z";
    let decided = false;
    const sent: string[] = [];
    const posts = serveLearning();
    override((request) => {
      if (request.path === LEARNING.sharingRequests)
        return listPage(
          learningContract.ListSkillSharingRequestsResponse,
          "requests",
          decided ? [] : [sharingRequest(requestedAt)],
        );
      if (request.path === LEARNING.sharingDecision(REQUEST, "approve")) {
        const sentAt = String(request.body?.requestedAt);
        sent.push(sentAt);
        if (sentAt !== "2026-11-06T08:00:00.000Z") {
          requestedAt = "2026-11-06T08:00:00.000Z";
          return problem(409, CHANGED, "SHARING_REQUEST_CHANGED");
        }
        decided = true;
        return served(learningContract.ApproveSkillSharingResponse, {
          skillName: "quote-follow-up",
          sharing: "approved",
        });
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
    const posts = serveLearning();
    let release: (response: Response) => void = () => {};
    const base = global.fetch;
    global.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) =>
        requestOf(input, init).path === DANA.learnedSkill("quote-follow-up")
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
      served(learningContract.GetLearnedSkillResponse, {
        name: "quote-follow-up",
        description: "Follow up on a quiet quote.",
        files: [
          { path: "SKILL.md", text: "Ask whether the quote still fits.\n" },
        ],
      }),
    );
    await view.findByText("Ask whether the quote still fits.");
    await waitFor(() =>
      expect((approve as HTMLButtonElement).disabled).toBe(false),
    );
    expect([...posts]).toEqual([]);
  });

  test("a sharing decision stays off when the skill could not be read", async () => {
    const posts = serveLearning();
    override((request) =>
      request.path === DANA.learnedSkill("quote-follow-up")
        ? problem(503, UNAVAILABLE, "LEARNING_UNAVAILABLE")
        : undefined,
    );
    const view = shared();
    fireEvent.click(
      await view.findByRole("button", { name: /Quote follow up/ }),
    );
    await view.findByText(UNAVAILABLE);
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
    const posts = serveLearning();
    const view = shared();
    fireEvent.click(await view.findByRole("button", { name: /Refund triage/ }));
    await view.findByText("Read the order date from the conversation.");
    fireEvent.click(view.getByRole("button", { name: "Reject" }));
    await view.findByText("Rejected. It won't be published.");
    expect([...posts]).toEqual([`${LEARNING.proposal(PROPOSAL)}/reject`]);
  });

  // Seen live: Why read "Supported by final Insights: agui-structured-component-report.", which names the insights
  // Learned from already shows, by their slugs.
  test("Why shows a reason in words, and is left out where the reason only names insights", async () => {
    serveLearning();
    const view = shared();
    fireEvent.click(await view.findByRole("button", { name: /Refund triage/ }));
    await view.findByText("Read the order date from the conversation.");
    expect(view.getByText("Why")).not.toBeNull();
    expect(
      view.getByText(
        "Three support conversations checked the order date by hand.",
      ),
    ).not.toBeNull();
    cleanup();
    queryClient.clear();
    serveLearning();
    override((request) =>
      request.path === LEARNING.proposal(PROPOSAL)
        ? served(learningContract.GetLearningProposalResponse, {
            ...detail,
            reason:
              "Supported by final Insights: refund-triage, order-date-check.",
          })
        : undefined,
    );
    const raw = shared();
    fireEvent.click(await raw.findByRole("button", { name: /Refund triage/ }));
    await raw.findByText("Read the order date from the conversation.");
    expect(raw.queryByText("Why")).toBeNull();
    expect(raw.queryByText(/Supported by final Insights/)).toBeNull();
  });

  test("a failed approve of a proposed skill shows why and leaves the choice open", async () => {
    serveLearning();
    override((request) =>
      request.path === `${LEARNING.proposal(PROPOSAL)}/approve`
        ? problem(502, UNREACHABLE, "LEARNING_UNREACHABLE")
        : undefined,
    );
    const view = shared();
    fireEvent.click(await view.findByRole("button", { name: /Refund triage/ }));
    await view.findByText("Read the order date from the conversation.");
    fireEvent.click(view.getByRole("button", { name: "Approve and publish" }));
    await view.findByText(UNREACHABLE);
    expect(
      view.queryByRole("button", { name: "Approve and publish" }),
    ).not.toBeNull();
    expect(view.queryByRole("button", { name: "Reject" })).not.toBeNull();
  });

  test("an admin rejects a person's proposal", async () => {
    const posts = serveLearning();
    const view = shared();
    fireEvent.click(
      await view.findByRole("button", { name: /Quote follow-up/ }),
    );
    await view.findByText("Read the order date from the conversation.");
    fireEvent.click(view.getByRole("button", { name: "Reject" }));
    await view.findByText("Rejected. It won't be published.");
    expect([...posts]).toEqual([
      `${DANA.proposal(PERSON_PROPOSAL)}/reject?containerId=${PERSON_SPACE}`,
    ]);
  });

  test("a failed approve of a person's proposal shows why", async () => {
    serveLearning();
    override((request) =>
      request.path === `${DANA.proposal(PERSON_PROPOSAL)}/approve`
        ? problem(502, UNREACHABLE, "LEARNING_UNREACHABLE")
        : undefined,
    );
    const view = shared();
    fireEvent.click(
      await view.findByRole("button", { name: /Quote follow-up/ }),
    );
    await view.findByText("Read the order date from the conversation.");
    fireEvent.click(view.getByRole("button", { name: "Approve and publish" }));
    await view.findByText(UNREACHABLE);
    expect(
      view.queryByRole("button", { name: "Approve and publish" }),
    ).not.toBeNull();
  });

  test("when settings fail to load, each approval section says so instead of vanishing", async () => {
    serveLearning();
    override((request) =>
      request.path === LEARNING.settings
        ? problem(
            500,
            "Learning settings could not be accessed.",
            "INTERNAL_ERROR",
          )
        : request.path === LEARNING.sharingRequests
          ? listPage(
              learningContract.ListSkillSharingRequestsResponse,
              "requests",
              [],
            )
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
    serveLearning();
    override((request) =>
      request.path === LEARNING.peopleProposals
        ? listPage(
            learningContract.ListPersonalLearningProposalsResponse,
            "people",
            [
              {
                personId: "user-unreadable",
                name: "Sam Ortiz",
                containerId: "user-unreadable",
                proposals: null,
              },
            ],
          )
        : undefined,
    );
    const view = shared();
    await view.findByText("Couldn't read Sam Ortiz's skills.", {
      exact: false,
    });
    expect(view.queryByText("Nothing to review")).toBeNull();
  });

  test("Who approves cannot be closed while it saves, so the result stays in view", async () => {
    serveLearning();
    let release: (response: Response) => void = () => {};
    const base = global.fetch;
    global.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const request = requestOf(input, init);
        return request.path === LEARNING.settings && request.method === "PATCH"
          ? new Promise<Response>((resolve) => {
              release = resolve;
            })
          : base(input, init);
      },
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
    release(problem(500, "Couldn't save who approves.", "INTERNAL_ERROR"));
    await view.findByText("Couldn't save who approves.");
  });

  test("Refresh status also reads proposed skills, analysis runs and published skills again", async () => {
    const posts = serveLearning();
    const view = shared();
    await view.findByRole("button", { name: /Invoice lookup/ });
    const lists = [LEARNING.runs, LEARNING.proposals, LEARNING.skills];
    const count = (path: string) =>
      posts.gets.filter((get) => get === path).length;
    const before = lists.map(count);
    fireEvent.click(view.getByRole("button", { name: "Refresh status" }));
    await waitFor(() =>
      expect(lists.map(count)).toEqual(before.map((n) => n + 1)),
    );
  });

  test("a run that failed says so in plain words, and with no container says so like the sections beside it", async () => {
    serveLearning();
    override((request) =>
      request.path === LEARNING.runs && request.method === "GET"
        ? listPage(
            learningContract.ListOrganizationLearningRunsResponse,
            "runs",
            [
              runBody({
                id: "0198a012-a20f-77c0-9e33-8992f18e74c3",
                status: "failed",
                triggerSource: "automatic",
                failureCode: "LEARNING_MODEL_NOT_CONFIGURED",
                failure:
                  "Learning has no model to think with. Sign OpenBot in to a model, then choose Learn now.",
                createdAt: "2026-11-04T10:00:00.000Z",
              }),
              runBody({
                id: "0198a012-a20f-77c0-9e33-8992f18e74c4",
                status: "failed",
                triggerSource: "automatic",
                failureCode: "SOMETHING_NEW",
                failure:
                  "Learning stopped before it finished. Choose Learn now to try again.",
                createdAt: "2026-11-03T10:00:00.000Z",
              }),
            ],
          )
        : undefined,
    );
    const view = shared();
    await view.findByText("The backend has no model set up for Learning yet.");
    expect(view.getByText("The run failed.")).not.toBeNull();
    expect(view.queryByText("LEARNING_MODEL_NOT_CONFIGURED")).toBeNull();
    cleanup();
    queryClient.clear();
    serveLearning();
    // No space is assigned: the runs list is empty, and the section says why, as Proposed skills does.
    override((request) =>
      request.path === LEARNING.settings && request.method === "GET"
        ? configuration({ enabled: true, defaultTarget: null })
        : undefined,
    );
    const none = shared();
    await none.findByText("Analysis runs");
    await waitFor(() =>
      expect(none.getAllByText("No container").length).toBeGreaterThanOrEqual(
        2,
      ),
    );
    expect(none.queryByText("No analysis runs yet")).toBeNull();
  });

  test("runs are polled while one is queued or running, and not otherwise", () => {
    const run = (status: LearningRunSummary["status"]) =>
      ({ status }) as LearningRunSummary;
    expect(runPollInterval([run("succeeded"), run("queued")])).toBe(30_000);
    expect(runPollInterval([run("batching")])).toBe(30_000);
    expect(runPollInterval([run("succeeded"), run("failed")])).toBe(false);
    expect(runPollInterval([])).toBe(false);
    expect(runPollInterval(undefined)).toBe(false);
  });

  test("a failed sharing requests read shows its error instead of hiding the section", async () => {
    serveLearning();
    const base = global.fetch;
    global.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) =>
        // A server that broke and said nothing: the screen's own sentence is what reaches the person.
        requestOf(input, init).path === LEARNING.sharingRequests
          ? new Response("{}", { status: 500 })
          : base(input, init),
      { preconnect: originalFetch.preconnect },
    );
    const view = shared();
    await view.findByText("Sharing requests");
    await view.findByText("Couldn't load sharing requests. Try again.");
  });

  test("people's proposals are not listed once each person approves their own", async () => {
    const posts = serveLearning();
    override((request) =>
      request.path === LEARNING.settings && request.method === "GET"
        ? configuration(
            { ...settings, personalReview: "people" },
            { state: "saved" },
          )
        : undefined,
    );
    const view = shared();
    await view.findByRole("button", { name: /Refund triage/ });
    expect(view.queryByRole("button", { name: /Quote follow-up/ })).toBeNull();
    await view.findByText("Sharing requests");
    expect(posts.gets).not.toContain(LEARNING.peopleProposals);
  });

  test("Who approves opens a dialog and saves people", async () => {
    serveLearning();
    const patches: { path: string; body: unknown }[] = [];
    override((request) => {
      if (request.path !== LEARNING.settings || request.method !== "PATCH")
        return undefined;
      patches.push({ path: request.path, body: request.body });
      return served(
        learningContract.UpdateLearningSettingsResponse,
        learningConfigurationBody({
          settings: { ...settings, personalReview: "people" },
        }),
      );
    });
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
      expect(patches).toEqual([
        { path: LEARNING.settings, body: { personalReview: "people" } },
      ]),
    );
  });

  test("saving Participation leaves who approves alone", async () => {
    serveLearning();
    const patches: Record<string, unknown>[] = [];
    override((request) => {
      if (request.path !== LEARNING.settings) return undefined;
      if (request.method === "PATCH") {
        patches.push(request.body ?? {});
        return served(
          learningContract.UpdateLearningSettingsResponse,
          learningConfigurationBody({
            settings: { enabled: false, personalReview: "people" },
          }),
        );
      }
      return configuration(
        { ...settings, personalReview: "admins" },
        { state: "saved" },
      );
    });
    const view = shared();
    await userEvent.setup({ document }).click(
      await view.findByRole("checkbox", {
        name: /Turn on automatic learning/,
      }),
    );
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
      expect(patches).toContainEqual({ personalReview: "people" }),
    );
    fireEvent.click(
      view.getByRole("button", { name: "Save Learning settings" }),
    );
    await waitFor(() =>
      expect(patches.some((patch) => "enabled" in patch)).toBe(true),
    );
    const participation = patches.find((patch) => "enabled" in patch);
    expect(participation?.enabled).toBe(false);
    expect("personalReview" in (participation ?? {})).toBe(false);
  });

  test("Published skills lists the container's skills and opens one", async () => {
    serveLearning();
    const view = shared();
    await view.findByText("Published skills");
    fireEvent.click(
      await view.findByRole("button", { name: /Invoice lookup/ }),
    );
    await view.findByText("Search billing for the invoice number.");
  });

  test("Learn now starts Learning on the container shown", async () => {
    const posts = serveLearning();
    const view = shared();
    await view.findByRole("button", { name: /Refund triage/ });
    fireEvent.click(view.getByRole("button", { name: "Learn now" }));
    await view.findByText("Learning started.", { exact: false });
    expect([...posts]).toEqual([LEARNING.runs]);
  });

  test("lists analysis runs and drops the link out to them", async () => {
    const runsLink = "https://app.intelligence.example/o/acme/support/runs";
    const runs = [
      runBody({
        id: "0198a012-a20f-77c0-9e33-8992f18e74c2",
        status: "succeeded",
        triggerSource: "manual",
        proposalCount: 2,
        insightCount: 5,
        createdAt: "2026-11-05T10:00:00.000Z",
        startedAt: "2026-11-05T10:00:01.000Z",
        completedAt: "2026-11-05T10:03:00.000Z",
      }),
      runBody({
        id: "0198a012-a20f-77c0-9e33-8992f18e74c3",
        status: "failed",
        triggerSource: "automatic",
        failureCode: "LEARNING_MODEL_NOT_CONFIGURED",
        failure:
          "Learning has no model to think with. Sign OpenBot in to a model, then choose Learn now.",
        createdAt: "2026-11-04T10:00:00.000Z",
      }),
      // Seen live as "1 proposed, 1 insights".
      runBody({
        id: "0198a012-a20f-77c0-9e33-8992f18e74c5",
        status: "succeeded",
        triggerSource: "automatic",
        proposalCount: 1,
        insightCount: 1,
        createdAt: "2026-11-03T10:00:00.000Z",
      }),
    ];
    serveLearning({
      ...noDashboard,
      links: {
        learning: "https://app.intelligence.example/o/acme/support/learning",
        candidates: null,
        runs: runsLink,
      },
    });
    override((request) =>
      request.path === LEARNING.runs && request.method === "GET"
        ? listPage(
            learningContract.ListOrganizationLearningRunsResponse,
            "runs",
            runs,
          )
        : undefined,
    );
    const view = shared();
    await view.findByText("Analysis runs");
    await view.findByText("The backend has no model set up for Learning yet.");
    expect(view.queryByText("LEARNING_MODEL_NOT_CONFIGURED")).toBeNull();
    expect(view.getByText("Finished · Manual")).not.toBeNull();
    expect(view.getByText("Failed · Automatic")).not.toBeNull();
    expect(view.getByText("2 proposed, 5 insights")).not.toBeNull();
    expect(view.getByText("1 proposed, 1 insight")).not.toBeNull();
    await view.findByText("Manage Learning in the backend dashboard");
    const anchors = Array.from(view.container.querySelectorAll("a"));
    expect(anchors.some((a) => a.getAttribute("href") === runsLink)).toBe(
      false,
    );
  });

  test("a sign-in Learning can't use is said on the page, before anyone presses Learn now", async () => {
    const said =
      "Learning can't run on the model you signed in with. To use it, sign OpenBot in with an OpenAI or Anthropic API key, or a Claude or ChatGPT plan.";
    serveLearning({ ...noDashboard, modelProblem: said });
    const view = shared();
    expect((await view.findByText(said)).getAttribute("role")).toBe("alert");
    cleanup();
    queryClient.clear();
    serveLearning();
    const fine = shared();
    await fine.findByText("OpenBot (openbot)");
    expect(fine.queryByText(said)).toBeNull();
  });

  test("with no dashboard there is no link into one, and with one the links stay", async () => {
    serveLearning();
    const without = shared();
    await without.findByText("OpenBot (openbot)");
    expect(
      without.queryByText("Manage Learning in the backend dashboard"),
    ).toBeNull();
    expect(without.queryByText("Threads ready")).toBeNull();
    expect(without.getByText("Candidates to review")).not.toBeNull();
    cleanup();
    queryClient.clear();
    serveLearning({
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
  serve({ enabled: true, defaultTarget: null }, { state: "learning_off" });
  const view = page();
  await view.findByText("Learning is switched off in the backend", {
    exact: false,
  });
  expect(
    view.queryByText("Couldn't reach the backend", { exact: false }),
  ).toBeNull();
});

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  environmentManager,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { LearningReview } from "@/components/settings/learning-review";
import { LearningSharing } from "@/components/settings/learning-sharing";
import type {
  LearningEvidence,
  LearningProposal,
  LearningRun,
  LearningSpace,
} from "@/lib/api/generated/model";
import {
  type PersonalReview,
  personalLearningQueryOptions,
  personalReviewQueryOptions,
} from "@/lib/learning/queries";
import { queryClient } from "@/query-client";
import { DEPLOYMENT_PATH } from "./admin-settings-api";
import {
  learningContract,
  personLearning,
  personLearningBody,
  problem,
  proposalDetailBody,
  requestOf,
  served,
  testId,
} from "./learning-api";

/**
 * What Settings → Learning drew: the review and the learned skills. Both are sections of Settings →
 * Skills now, and these tests read them together as they did there.
 */
function LearningSettingsPage() {
  return (
    <>
      <LearningReview />
      <LearningSharing />
    </>
  );
}

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

const ME = personLearning();
/** What a POST asked for: the address with its query, as the client sent it. */
const startedIn = (container: string) => `${ME.runs}?containerId=${container}`;
const approvedIn = (key: string, container: string) =>
  `${ME.proposal(testId(key))}/approve?containerId=${container}`;

/** One insight of the proposal the dialog opens, with the evidence its own read answers. */
type TestInsight = {
  id: string;
  statement: string;
  impact: string;
  evidence: LearningEvidence[];
};

const originalFetch = global.fetch;
let review: PersonalReview;
let insights: TestInsight[] = [];
/** The person's recordings' titles, as the recording-titles read answers them. */
let recordingTitles: { id: string; title: string | null }[] = [];
let detailOperation: LearningProposal["operation"] = "add";
/** While set, reading the review answers 429, as the backend does when the shared project key is over its limit. */
let busy = false;
const posts: string[] = [];
const patches: { url: string; body: unknown }[] = [];

const proposal = (
  key: string,
  title: string,
  operation: LearningProposal["operation"],
  status: LearningProposal["status"] = "pending_review",
): LearningProposal => ({
  id: testId(key),
  runId: testId("run-0"),
  title,
  description: `${title} description`,
  reason: "Seen in your recordings.",
  operation,
  status,
  createdAt: "2026-11-01T00:00:00Z",
  reviewedAt: null,
  publishedSkillId: null,
});

const space = (overrides: Partial<LearningSpace>): LearningSpace => ({
  containerId: "user-1",
  kind: "recordings",
  label: "From your recordings",
  latestRun: null,
  proposals: [],
  ...overrides,
});

// A team has no automatic approval (autoApprove null); the personal edition has it on or off.
const body = (
  canReview: boolean,
  autoApprove: boolean | null = null,
): PersonalReview => ({
  canReview,
  autoApprove,
  approved: 0,
  spaces: [
    space({
      proposals: [
        proposal("p1", "refund-order", "add"),
        proposal("p2", "close-ticket", "update"),
        proposal("p3", "old-skill", "remove"),
        proposal("p4", "done-skill", "add", "approved"),
      ],
    }),
  ],
});

const reviewOf = (
  canReview: boolean,
  autoApprove: boolean | null,
  spaces: LearningSpace[],
): PersonalReview => ({ canReview, autoApprove, approved: 0, spaces });

beforeEach(() => {
  queryClient.clear();
  posts.length = 0;
  patches.length = 0;
  review = body(false);
  insights = [];
  recordingTitles = [];
  detailOperation = "add";
  busy = false;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      const request = requestOf(path, init);
      if (url === DEPLOYMENT_PATH)
        return Response.json({ edition: "personal" });
      if (request.method === "GET") {
        if (request.path === ME.review)
          return busy
            ? problem(
                429,
                "The backend is busy. Try again in a minute.",
                "RATE_LIMITED",
              )
            : served(learningContract.GetPersonLearningReviewResponse, review);
        if (request.path === ME.settings)
          return served(
            learningContract.GetPersonLearningSettingsResponse,
            personLearningBody(),
          );
        if (request.path === ME.recordingTitles) {
          const ids = (request.query.get("ids") ?? "").split(",");
          return served(learningContract.GetRecordingTitlesResponse, {
            recordings: recordingTitles.filter((recording) =>
              ids.includes(recording.id),
            ),
          });
        }
        const insight = insights.find(
          (one) => request.path === ME.evidence(one.id),
        );
        if (insight)
          return served(learningContract.GetPersonLearningEvidenceResponse, {
            evidence: insight.evidence,
          });
        if (request.path.startsWith(ME.proposal("")))
          return served(
            learningContract.GetPersonLearningProposalResponse,
            proposalDetailBody({
              id: decodeURIComponent(
                request.path.slice(ME.proposal("").length),
              ),
              title: "refund-order",
              operation: detailOperation,
              files: [{ path: "SKILL.md", content: "Look up the order." }],
              insights: insights.map(({ id, statement, impact }) => ({
                id,
                statement,
                impact,
              })),
            }),
          );
      }
      if (request.method === "PATCH" && request.path === ME.settings) {
        patches.push({ url: request.path, body: request.body });
        return served(learningContract.UpdatePersonLearningSettingsResponse, {
          mode: "closed",
          autoApprove: request.body?.autoApprove ?? null,
        });
      }
      if (request.method === "POST") {
        posts.push(url);
        if (request.path === ME.runs)
          return served(
            learningContract.StartPersonLearningRunResponse,
            run("run-9", "2026-11-03T00:00:00Z", "queued"),
            202,
          );
        const decided = /\/learning-proposals\/([^/]+)\/(approve|reject)$/.exec(
          request.path,
        );
        if (decided)
          return served(
            learningContract.ApprovePersonLearningProposalResponse,
            {
              proposalId: decodeURIComponent(decided[1] ?? ""),
              operation: detailOperation,
              status: decided[2] === "approve" ? "approved" : "rejected",
              publishedSkillId: null,
            },
          );
      }
      return problem(404, "Not found.", "NOT_FOUND");
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

function run(
  key: string,
  createdAt: string,
  status: LearningRun["status"] = "succeeded",
): LearningRun {
  return {
    id: testId(key),
    status,
    triggerSource: "manual",
    proposalCount: 1,
    insightCount: null,
    failureCode: null,
    failure: null,
    createdAt,
    startedAt: null,
    completedAt: null,
  };
}

/** A Learn now that the API refuses for one space, with the sentence a person reads. */
function refuseLearnNow(container: string) {
  const ok = global.fetch;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(path) === startedIn(container) && init?.method === "POST") {
        posts.push(String(path));
        return problem(502, "Nope", "LEARNING_UNREACHABLE");
      }
      return ok(path, init);
    },
    { preconnect: originalFetch.preconnect },
  );
}

test("lists the pending proposals with what each does", async () => {
  const view = draw();
  await view.findByText("Waiting for an admin");
  expect(await view.findByText("New skill")).toBeTruthy();
  expect(view.getByText("Update to Close ticket")).toBeTruthy();
  expect(view.getByText("Remove Old skill")).toBeTruthy();
  expect(view.queryByText("Done skill")).toBeNull();
});

test("with admins approving, a person's pending proposal opens read-only", async () => {
  const view = draw();
  fireEvent.click(await view.findByText("Refund order"));
  await view.findByText("Look up the order.");
  expect(view.queryByText("Approve and publish")).toBeNull();
  expect(view.getByText("Done")).toBeTruthy();
  expect(view.getByText(/An admin reviews these/)).toBeTruthy();
});

test("with people approving, a person approves from the dialog", async () => {
  review = body(true);
  const view = draw();
  fireEvent.click(await view.findByText("Refund order"));
  fireEvent.click(await view.findByText("Approve and publish"));
  await waitFor(() => expect(posts).toEqual([approvedIn("p1", "user-1")]));
  expect(
    await view.findByText(
      "Published. Your Bots use it from their next conversation.",
    ),
  ).toBeTruthy();
});

test("says so when proposals couldn't be read", async () => {
  review = reviewOf(true, false, [space({ proposals: null })]);
  const view = draw();
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toBe(
    "Couldn't read your proposed skills. Reload the page.",
  );
});

test("says some were unreadable when another source was read", async () => {
  review = reviewOf(true, false, [
    space({ proposals: null }),
    space({ containerId: "user-2", label: "More recordings", proposals: [] }),
  ]);
  const view = draw();
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain("Couldn't read some of your");
});

test("on a team, says what to expect when nothing is waiting", async () => {
  review = reviewOf(true, null, []);
  const view = draw();
  expect(await view.findByText("Nothing to review")).toBeTruthy();
  expect(
    await view.findByText(
      "New proposals show up here after Learning analyses your recordings.",
    ),
  ).toBeTruthy();
});

test("in the personal edition the empty state mentions conversations", async () => {
  review = reviewOf(true, false, []); // personal: autoApprove is a boolean
  const view = draw();
  expect(
    await view.findByText(
      "New proposals show up here after Learning analyses your recordings and conversations.",
    ),
  ).toBeTruthy();
});

test("with people approving, the latest run shows and Learn now starts one", async () => {
  review = body(true);
  const first = review.spaces[0];
  if (first)
    first.latestRun = {
      ...run("run-1", "2026-11-01T00:00:00Z"),
      proposalCount: 2,
    };
  const view = draw();
  expect(await view.findByText("Latest run finished.")).toBeTruthy();
  fireEvent.click(await view.findByRole("button", { name: "Learn now" }));
  await waitFor(() => expect(posts).toEqual([startedIn("user-1")]));
  const busy = await view.findByRole("button", {
    name: "Learning in progress…",
  });
  expect((busy as HTMLButtonElement).disabled).toBe(true);
  expect(view.queryByText(/Learning started/)).toBeNull();
});

test("a failed run says why, not only that it failed", async () => {
  review = body(true);
  const first = review.spaces[0];
  const why =
    "Learning couldn't reach OpenBot to use your model plan. Quit OpenBot and open it again, then choose Learn now.";
  if (first)
    first.latestRun = {
      ...run("run-1", "2026-11-01T00:00:00Z", "failed"),
      proposalCount: null,
      failureCode: "BatchInsightAgentFailed",
      failure: why,
    };
  const view = draw();
  expect(await view.findByText(`Latest run failed. ${why}`)).toBeTruthy();
});

test("turning automatic approval off shows proposals from recordings and from conversations to review", async () => {
  review = reviewOf(true, false, [
    space({ proposals: [proposal("p1", "refund-order", "add")] }),
    space({
      containerId: "user-1-chat",
      kind: "conversations",
      label: "From your conversations",
      latestRun: run("run-2", "2026-11-02T00:00:00Z"),
      proposals: [proposal("p5", "reply-politely", "add")],
    }),
  ]);
  const view = draw();
  expect(await view.findByText("From your recordings")).toBeTruthy();
  expect(view.getByText("From your conversations")).toBeTruthy();
  expect(view.getByText("Refund order")).toBeTruthy();
  expect(view.getByText("Reply politely")).toBeTruthy();
  expect(view.getByText("No run yet.")).toBeTruthy();
  expect(view.getByText("Latest run finished.")).toBeTruthy();
  const buttons = view.getAllByRole("button", { name: "Learn now" });
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[1] as HTMLElement);
  await waitFor(() => expect(posts).toEqual([startedIn("user-1-chat")]));
});

test("sources with the same label make one group with one Learn now", async () => {
  review = reviewOf(
    true,
    false,
    ["a", "b"].map((id) =>
      space({
        containerId: `bot-${id}`,
        kind: "conversations",
        label: "From your conversations",
        proposals: [proposal(`p-${id}`, `skill-${id}`, "add")],
      }),
    ),
  );
  const view = draw();
  expect(await view.findByText("Skill a")).toBeTruthy();
  expect(view.getAllByText("From your conversations")).toHaveLength(1);
  fireEvent.click(view.getByText("Skill b"));
  fireEvent.click(await view.findByText("Approve and publish"));
  await waitFor(() => expect(posts).toEqual([approvedIn("p-b", "bot-b")]));
  posts.length = 0;
  fireEvent.click(await view.findByText("Done"));
  fireEvent.click(await view.findByRole("button", { name: "Learn now" }));
  await waitFor(() =>
    expect(posts).toEqual([startedIn("bot-a"), startedIn("bot-b")]),
  );
});

test("Learn now starts every source in the group even when one fails", async () => {
  review = reviewOf(
    true,
    false,
    ["a", "b"].map((id) =>
      space({
        containerId: `bot-${id}`,
        kind: "conversations",
        label: "From your conversations",
      }),
    ),
  );
  refuseLearnNow("bot-a");
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "Learn now" }));
  await waitFor(() =>
    expect(posts).toEqual([startedIn("bot-a"), startedIn("bot-b")]),
  );
  expect((await view.findByRole("alert")).textContent).toBe("Nope");
});

test("with admins approving, there is no Learn now", async () => {
  const view = draw();
  await view.findByText("Waiting for an admin");
  expect(view.queryByRole("button", { name: "Learn now" })).toBeNull();
  expect(view.queryByText(/Latest run/)).toBeNull();
});

/** A recording the evidence cites, as the evidence read answers it: by id, with its events. */
const recording = (
  key: string,
  eventCount: number,
  events: string[],
): LearningEvidence => ({
  kind: "recording",
  trajectoryId: testId(key),
  trajectoryPresent: true,
  unavailable: null,
  eventCount,
  events: events.map((name, seq) => ({ seq, name, offsetMs: seq * 1000 })),
});

test("evidence names the recording by its title", async () => {
  const steps = ["Open the order", "Click Refund"];
  insights = [
    {
      id: testId("i1"),
      statement: "Refunds start from the order page.",
      impact: "Faster refunds.",
      evidence: [recording("r1", 2, steps), recording("r2", 2, steps)],
    },
  ];
  // The second recording has no title.
  recordingTitles = [{ id: testId("r1"), title: "Refund an order" }];
  const view = draw();
  fireEvent.click(await view.findByText("Refund order"));
  expect(await view.findByText("Refund an order")).toBeTruthy();
  expect(view.getByText("A recording")).toBeTruthy();
  expect(view.getAllByText("Open the order, Click Refund")).toHaveLength(2);
});

test("the personal edition shows Learning with automatic approval on and no sharing", async () => {
  const base = body(true);
  review = {
    ...base,
    autoApprove: true,
    spaces: base.spaces.map((one) => ({ ...one, proposals: [] })),
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
  await view.findByText("Your skills");
  expect(view.queryByText("Who else's Bots use your skills")).toBeNull();
  expect(view.getByRole("button", { name: "Learn now" })).toBeTruthy();
  expect(view.queryByText("Nothing to review")).toBeNull();
  fireEvent.click(approve);
  await waitFor(() =>
    expect(patches).toEqual([
      { url: ME.settings, body: { autoApprove: false } },
    ]),
  );
});

test("Waiting for your review shows only once a skill is waiting, not while Learning runs with automatic approval on", async () => {
  const base = body(true, true);
  const source = (
    proposals: LearningProposal[],
    status: "batching" | null,
  ): LearningSpace => ({
    ...base.spaces[0]!,
    latestRun: run("run-1", "2026-11-01T00:00:00Z", status ?? "succeeded"),
    proposals,
  });
  review = { ...base, spaces: [source([], "batching")] };
  const view = render(
    <QueryClientProvider client={queryClient}>
      <LearningSettingsPage />
    </QueryClientProvider>,
  );
  await view.findByRole("button", { name: "Learning in progress…" });
  await view.findByText("Your skills");
  expect(view.queryByText("Waiting for your review")).toBeNull();
  expect(view.queryByText(/Approve a skill to publish it/)).toBeNull();
  expect(view.getByRole("heading", { name: "New skills" })).toBeTruthy();

  // The run finished and its skill was approved automatically: still nothing waits.
  review = { ...base, spaces: [source([], null)] };
  await queryClient.invalidateQueries({ queryKey: ["learning", "review"] });
  await view.findByRole("button", { name: "Learn now" });
  expect(view.queryByText("Waiting for your review")).toBeNull();

  // One skill is waiting: now the heading says so.
  review = {
    ...base,
    spaces: [source([proposal("p1", "refund-order", "add")], null)],
  };
  await queryClient.invalidateQueries({ queryKey: ["learning", "review"] });
  expect(
    await view.findByRole("heading", { name: "Waiting for your review" }),
  ).toBeTruthy();
  expect(
    view.getByText("Approve a skill to publish it to your Bots."),
  ).toBeTruthy();
  expect(view.getByText("Refund order")).toBeTruthy();
  expect(view.queryByRole("heading", { name: "New skills" })).toBeNull();
});

test("with nothing waiting, the empty state shows under New skills, not under a Waiting heading", async () => {
  review = reviewOf(true, false, []);
  const view = draw();
  expect(await view.findByText("Nothing to review")).toBeTruthy();
  expect(view.queryByText("Waiting for your review")).toBeNull();
  expect(view.getByRole("heading", { name: "New skills" })).toBeTruthy();
  cleanup();
  queryClient.clear();

  // On a team where admins approve, the same rule holds for Waiting for an admin.
  review = reviewOf(false, null, []);
  const team = draw();
  expect(await team.findByText("Nothing to review")).toBeTruthy();
  expect(team.queryByText("Waiting for an admin")).toBeNull();
});

test("a source Learning is off for says so plainly, without the read failure alert", async () => {
  review = reviewOf(true, false, [
    space({ proposals: null, unavailable: "learning-off" }),
  ]);
  const view = draw();
  expect(
    await view.findByText(
      "Learning isn't available in the backend, so nothing is proposed here.",
    ),
  ).toBeTruthy();
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.queryByText("Nothing to review")).toBeNull();
});

test("when only some sources are unavailable, the empty state is hidden and the notice names them", async () => {
  review = reviewOf(true, false, [
    space({ proposals: null, unavailable: "learning-off" }),
    space({
      containerId: "user-2",
      kind: "conversations",
      label: "From your conversations",
      proposals: [],
    }),
  ]);
  const view = draw();
  expect(
    await view.findByText(
      "Learning isn't available for From your recordings, so nothing is proposed there.",
    ),
  ).toBeTruthy();
  expect(view.queryByText("Nothing to review")).toBeNull();
});

test("a Learn now failure in one group does not show in another", async () => {
  review = reviewOf(
    true,
    false,
    ["a", "b"].map((id) =>
      space({
        containerId: `src-${id}`,
        kind: "conversations",
        label: `Group ${id}`,
      }),
    ),
  );
  refuseLearnNow("src-a");
  const view = draw();
  const buttons = await view.findAllByRole("button", { name: "Learn now" });
  fireEvent.click(buttons[0] as HTMLElement);
  expect((await view.findByRole("alert")).textContent).toBe("Nope");
  fireEvent.click(view.getAllByRole("button", { name: "Learn now" })[1]!);
  await view.findByRole("button", { name: "Learning in progress…" });
  // Group b's start does not wipe or borrow group a's failure, and a's button comes back.
  expect(view.getByRole("alert").textContent).toBe("Nope");
  expect(view.getAllByRole("button", { name: "Learn now" })).toHaveLength(1);
});

test("Learn now stays disabled until the run it started has finished", async () => {
  review = body(true);
  const first = review.spaces[0];
  if (first) first.latestRun = run("run-1", "2026-11-01T00:00:00Z");
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "Learn now" }));
  await view.findByRole("button", { name: "Learning in progress…" });
  const next = review.spaces[0];
  if (next) next.latestRun = run("run-2", "2026-11-02T00:00:00Z", "batching");
  await queryClient.invalidateQueries({ queryKey: ["learning", "review"] });
  await view.findByText("Latest run analyzing.");
  expect(
    (
      view.getByRole("button", {
        name: "Learning in progress…",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  if (next) next.latestRun = run("run-2", "2026-11-02T00:00:00Z");
  await queryClient.invalidateQueries({ queryKey: ["learning", "review"] });
  await view.findByText("Latest run finished.");
  expect(
    (view.getByRole("button", { name: "Learn now" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

test("a run already going shows Learning in progress, disabled", async () => {
  review = body(true);
  const first = review.spaces[0];
  if (first) first.latestRun = run("run-1", "2026-11-01T00:00:00Z", "queued");
  const view = draw();
  const busy = await view.findByRole("button", {
    name: "Learning in progress…",
  });
  expect((busy as HTMLButtonElement).disabled).toBe(true);
});

test("a source that failed to read still alerts next to one that is unavailable", async () => {
  review = reviewOf(true, false, [
    space({
      containerId: "a",
      label: "Source a",
      proposals: null,
      unavailable: "learning-off",
    }),
    space({ containerId: "b", label: "Source b", proposals: null }),
  ]);
  const view = draw();
  expect((await view.findByRole("alert")).textContent).toBe(
    "Couldn't read your proposed skills. Reload the page.",
  );
});

// Every person's review reads through the one project key, and reading every ten seconds while a run went was enough to
// have the backend answer 429.
test("the review is read again every thirty seconds while a run is going, once a minute after a failed read, and not otherwise", () => {
  const options = personalReviewQueryOptions();
  const interval = (status: string | null, failed = false) => {
    const data = {
      canReview: true,
      autoApprove: false,
      approved: 0,
      spaces: [
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
    return refetchInterval({
      state: { data, error: failed ? new Error("busy") : null },
    });
  };
  expect(interval("batching")).toBe(30_000);
  expect(interval("queued")).toBe(30_000);
  expect(interval("batching", true)).toBe(60_000);
  expect(interval("succeeded")).toBe(false);
  expect(interval("failed")).toBe(false);
  expect(interval(null)).toBe(false);
});

// Seen on the live review: the backend answered 429 while a run was polled, and the page dropped what it had shown.
test("a busy backend keeps the last review on screen and says the backend is busy", async () => {
  review = body(true);
  const first = review.spaces[0];
  if (first) first.latestRun = run("run-1", "2026-11-01T00:00:00Z");
  const view = draw();
  await view.findByText("Latest run finished.");
  busy = true;
  await queryClient
    .refetchQueries({ queryKey: ["learning", "review"] })
    .catch(() => {});
  expect(
    await view.findByText(
      "The backend is busy, so this may be out of date. OpenBot checks again in a minute.",
    ),
  ).toBeTruthy();
  expect(view.getByText("Latest run finished.")).toBeTruthy();
  expect(view.getByText("Refund order")).toBeTruthy();
  expect(view.queryByText("No run yet.")).toBeNull();
  // Once the backend answers again, the notice goes.
  busy = false;
  await queryClient.refetchQueries({ queryKey: ["learning", "review"] });
  await waitFor(() =>
    expect(view.queryByText(/The backend is busy/)).toBeNull(),
  );
});

test("a review that comes back without the run a space had still shows that run", async () => {
  review = body(true);
  const first = review.spaces[0];
  if (first) first.latestRun = run("run-1", "2026-11-01T00:00:00Z");
  const view = draw();
  await view.findByText("Latest run finished.");
  // A read that came back short: the space's run is missing, though runs are never taken away.
  if (first) first.latestRun = null;
  await queryClient.refetchQueries({ queryKey: ["learning", "review"] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(view.getByText("Latest run finished.")).toBeTruthy();
  expect(view.queryByText("No run yet.")).toBeNull();
});

test("when a refetch finds fewer proposals waiting, Your skills is refreshed", async () => {
  review = body(true);
  const view = draw();
  await view.findByText("Refund order");
  const invalidated: unknown[] = [];
  const original = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filters: { queryKey?: unknown }) => {
    invalidated.push(filters?.queryKey);
    return original(filters as never);
  }) as typeof queryClient.invalidateQueries;
  try {
    review = {
      ...body(true),
      spaces: [
        {
          ...body(true).spaces[0]!,
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

test("skills approved while opening refresh Your skills on the first load", async () => {
  review = { ...body(true), approved: 1 };
  let skillsReads = 0;
  const inner = global.fetch;
  global.fetch = Object.assign(
    (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = requestOf(path, init);
      if (request.method === "GET" && request.path === ME.settings)
        skillsReads += 1;
      return inner(path, init);
    },
    { preconnect: originalFetch.preconnect },
  );
  // Your skills sits next to this section on the page, so its query is watched.
  const watcher = new QueryObserver(
    queryClient,
    personalLearningQueryOptions(),
  );
  const unsubscribe = watcher.subscribe(() => {});
  try {
    const view = draw();
    await view.findByText("Refund order");
    await waitFor(() => expect(skillsReads).toBeGreaterThanOrEqual(2));
  } finally {
    unsubscribe();
  }
});

test("a removal proposal says approve removal, then removed", async () => {
  review = body(true);
  detailOperation = "remove";
  const view = draw();
  fireEvent.click(await view.findByText("Old skill"));
  expect(view.queryByText("Approve and publish")).toBeNull();
  fireEvent.click(await view.findByText("Approve removal"));
  expect(
    await view.findByText(
      "Removed. Bots stop using it from their next conversation.",
    ),
  ).toBeTruthy();
  expect(view.queryByText(/Published/)).toBeNull();
});

test("a recording without named steps says 1 step, then 2 steps", async () => {
  insights = [
    {
      id: testId("i1"),
      statement: "Refunds start from the order page.",
      impact: "Faster refunds.",
      evidence: [recording("r1", 1, []), recording("r2", 2, [])],
    },
  ];
  recordingTitles = [
    { id: testId("r1"), title: "Recording r1" },
    { id: testId("r2"), title: "Recording r2" },
  ];
  review = body(false);
  const view = draw();
  fireEvent.click(await view.findByText("Refund order"));
  expect(await view.findByText("1 step")).toBeTruthy();
  expect(view.getByText("2 steps")).toBeTruthy();
});

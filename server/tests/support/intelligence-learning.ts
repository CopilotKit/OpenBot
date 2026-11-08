/**
 * Intelligence's project-key Learning routes, answering as Intelligence answers, over real HTTP.
 *
 * Every body here is the one Intelligence's own code writes, so the runtime client and OpenBot read
 * them exactly as they would read the real thing:
 *  - errors: `createErrorResponseBody` (apps/app-api/src/errors/http-error-response.ts), with the
 *    code, status, message, category and retryable flag from apps/app-api/src/errors/registry.ts;
 *  - containers, runs, candidates, reviews and evidence: apps/app-api/src/routes/runtime-learning-routes.ts
 *    and the stores behind it (learning-control-store.ts, learning-candidate-store.ts);
 *  - published Skills: learned-skill-registry.ts, which answers REVISION_NOT_FOUND for a container
 *    nothing has been published to yet, and CONTAINER_NOT_FOUND for one that is not there.
 *
 * The Inspector panel (`GET /api/inspector/learning`) answers as apps/app-api/src/routes/inspector-learning-routes.ts
 * does, including its `dashboardLinksOptional=true` opt-in:
 *  - by default, an Intelligence from before the opt-in with no dashboard: 404 with no body to every
 *    call, opted in or not;
 *  - `inspector: "no-dashboard"`: 404 to a plain call, the snapshot without dashboard links to a
 *    call that opts in;
 *  - `inspector: "dashboard"`: the snapshot with its links to either call, 400 to any other value;
 *  - `inspector: "dashboard-before-opt-in"`: an older Intelligence with a dashboard, whose strict
 *    query check answers 400 to the parameter it does not know, and the snapshot to a plain call.
 *
 * Four Intelligences: `current` (Learning on, a project key may create containers), `0.15.1`
 * (Learning on, no create route for a project key), `learning-off` (`learning.enabled: false`,
 * where none of the Learning routes is registered and Express's catch-all answers ROUTE_NOT_FOUND),
 * and `rollout-closed` (Learning on with `globalEnabled: false` and no rollout entry, where every
 * Learning route answers LEARNING_NOT_ENABLED: learning-availability-guard.ts).
 *
 * Any of them can be met still starting, as a first install of OpenBot's Helm bundle meets it
 * (`starting`): while the migrations Job runs every request fails on a table that is not there yet
 * (500 INTERNAL_SERVER_ERROR), and until the bootstrap Job stores the runtime key it is not found
 * (401 AUTH_UNAUTHENTICATED).
 */
import { createHash } from "node:crypto";

const ERRORS = {
  ROUTE_NOT_FOUND: [404, "Route not found.", "not_found"],
  CONTAINER_NOT_FOUND: [
    404,
    "The Learning container was not found in this project.",
    "not_found",
  ],
  REVISION_NOT_FOUND: [
    404,
    "The requested Learning registry revision was not found.",
    "not_found",
  ],
  LEARNING_CONTAINER_NOT_FOUND: [
    404,
    "The Learning Container was not found in this project.",
    "not_found",
  ],
  LEARNING_CANDIDATE_NOT_FOUND: [
    404,
    "The Learning Skill candidate was not found in this container.",
    "not_found",
  ],
  LEARNING_CANDIDATE_CONFLICT: [
    409,
    "The Learning Skill candidate can no longer make this transition.",
    "conflict",
  ],
  LEARNING_CONTAINER_ALREADY_EXISTS: [
    409,
    "A Learning Container with this stable ID already exists.",
    "conflict",
  ],
  LEARNING_NOT_ENABLED: [
    403,
    "Check that this organization has an active subscription: every current plan grants Learning, and this organization is not entitled to it.",
    "permission",
  ],
  // apps/app-api/src/errors/registry.ts: a run asked of an installation whose Learning agent has
  // no model (runtime-learning-routes.ts).
  LEARNING_MODEL_NOT_CONFIGURED: [
    409,
    "No Learning model is configured for this installation. Run `copilotkit local setup` to add one.",
    "conflict",
  ],
  INTERNAL_SERVER_ERROR: [500, "Unexpected server error.", "internal", true],
  AUTH_UNAUTHENTICATED: [401, "Authentication is required.", "auth"],
} as const;
export type IntelligenceErrorCode = keyof typeof ERRORS;

export function intelligenceError(code: IntelligenceErrorCode): Response {
  const entry: readonly [number, string, string, boolean?] = ERRORS[code];
  const [status, message, category, retryable = false] = entry;
  return Response.json(
    {
      error: { code, message, category, retryable },
      requestId: "request-test",
      traceId: "trace-test",
    },
    { status },
  );
}

const NOW = "2026-11-04T12:00:00.000Z";
export const PROJECT_ID = 7;
export const RUNTIME_KEY =
  "cpk-openbot_abcdefgh12345678_abcdefghijklmnopqrstuvwxyz012345";

export function container(id: string, name: string) {
  return {
    id,
    name,
    projectId: PROJECT_ID,
    promptContext: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export const SKILL_MD = `---
name: Refund triage
description: Sort refund requests by whether they are inside the 30-day window.
---

# Refund triage

1. Read the order date from the conversation.
2. Inside 30 days: approve and say so.
3. Outside: hand it to a person.
`;

/** A proposed Skill, as `listLearningSkillCandidates` returns one. */
export function candidate(
  id: string,
  status: "pending_review" | "approved" | "rejected" = "pending_review",
) {
  return {
    bundleSha256: sha256(`bundle-${id}`),
    createdAt: NOW,
    description:
      "Sort refund requests by whether they are inside the 30-day window.",
    id,
    operation: "add",
    publishedRegistryRevision: null as number | null,
    publishedSkillId: null as string | null,
    reason:
      "Three support conversations checked the order date by hand before answering.",
    registryBaseRevision: 0,
    reviewedAt: null as string | null,
    runId: "0198a012-a20f-77c0-9e33-8992f18e74a1",
    status,
    subjectSha256: sha256(`subject-${id}`),
    targetSkillId: null,
    targetSkillRevision: null,
    title: "Refund triage",
  };
}

export const INSIGHT_ID = "0198a012-a20f-77c0-9e33-8992f18e74a9";
/** The Skill an approval publishes, and the registry revision it publishes at. */
export const PUBLISHED_SKILL_ID = "0198a012-a20f-77c0-9e33-8992f18e74a2";
const PUBLISHED_REVISION = 2;

/**
 * The same, as `getLearningSkillCandidate` returns it: the bundle and the Insights behind it. `stored` is the
 * candidate as it stands now (reviewed or not), read from the same row the list reads.
 */
export function candidateDetail(
  id: string,
  files?: { path: string; content: string }[],
  stored: ReturnType<typeof candidate> = candidate(id),
) {
  return {
    ...stored,
    bundle: {
      schemaVersion: 1,
      files: files
        ? files.map((file) => ({ ...file, sha256: sha256(file.content) }))
        : [
            {
              path: "references/policy.md",
              content: "Refunds inside 30 days.",
              sha256: sha256("Refunds inside 30 days."),
            },
            { path: "SKILL.md", content: SKILL_MD, sha256: sha256(SKILL_MD) },
          ],
    },
    supportingInsights: [
      {
        alias: "I1",
        id: INSIGHT_ID,
        impact: "Answers refund questions without a hand check.",
        statement: "Agents look up the order date before every refund answer.",
      },
    ],
  };
}

/** An Insight's evidence, as `getLearningInsightEvidence` resolves it: a Thread and a Trajectory. */
export const EVIDENCE = [
  {
    cited: [
      {
        id: "message-1",
        content: "Can I get a refund on order 1182?",
        role: "user",
      },
      {
        id: "message-2",
        content: "That order is 12 days old, so yes.",
        role: "assistant",
      },
    ],
    messageCount: 2,
    threadId: "thread-1",
    threadName: "Refund for order 1182",
    threadPresent: true,
    unavailable: null,
  },
  {
    kind: "trajectory",
    trajectoryId: "0198a012-a20f-77c0-9e33-8992f18e74b0",
    trajectoryPresent: true,
    eventCount: 1,
    events: [
      {
        seq: 3,
        name: "click",
        offsetMs: 1200,
        value: { selector: "#order-date" },
        eventId: "event-3",
      },
    ],
    unavailable: null,
  },
];

export function run(status = "queued") {
  return {
    id: "0198a012-a20f-77c0-9e33-8992f18e74c1",
    learningContainerId: "openbot",
    projectId: PROJECT_ID,
    status,
    triggerSource: "manual",
    attemptCount: 0,
    candidateCount: null,
    completedAt: null,
    createdAt: NOW,
    failureCode: null,
    insightCount: null,
    kubernetesJobName: null,
    startedAt: null,
    updatedAt: NOW,
  };
}

/**
 * `GET /api/inspector/learning?runtimeContainerId=openbot` on an Intelligence with no dashboard, as its
 * real route answered it to a call with `dashboardLinksOptional=true`
 * (inspector-learning-routes.integration.spec.ts, Intelligence 5bcb27075): a
 * conversation waiting for a run, a published Skill, an Insight and a proposed Skill to review. No
 * `webAppOrigin` and no `links`.
 */
export const INSPECTOR_NO_DASHBOARD = {
  schemaVersion: 1,
  projectKey: "518ba89ee380617b2e1a7e0715f7d6c5",
  snapshotVersion:
    "8d9694e76b7274d4647e6bcbb96c6d7fd63dfa8d5c933e3c0a46b27623a1a90b",
  configuration: {
    state: "configured",
    container: { id: "openbot", name: "OpenBot" },
  },
  pendingThreadCount: 1,
  run: {
    hasActiveRun: false,
    hasEverSucceeded: true,
    latest: { completedAt: "2026-11-04T12:00:00.000Z", status: "succeeded" },
  },
  pendingCandidateCount: 1,
  skillsPage: {
    page: 1,
    pageSize: 3,
    total: 1,
    totalPages: 1,
    items: [
      {
        id: "01a1aa63-43ec-7624-8be5-812bd1115b9b",
        name: "verify-refund",
        description: "Verify refund inputs.",
        revision: 1,
        skillMd: "# Verify refund inputs",
        sourceInsight: {
          id: "01a1aa63-43eb-7c28-bdc1-d43597050f1c",
          statement: "Ask for the order first.",
          impact: "Fewer wrong answers.",
          totalThreadCount: 0,
          evidenceTruncated: false,
          evidence: [],
          totalTrajectoryCount: 0,
          trajectoryEvidence: [],
        },
      },
    ],
  },
  insightsPage: {
    page: 1,
    pageSize: 4,
    total: 1,
    totalPages: 1,
    items: [
      {
        id: "01a1aa63-43ec-74ae-ad98-80087cbfdab8",
        statement: "Answer in the language of the question.",
        impact: "Fewer wrong answers.",
        totalThreadCount: 0,
        evidenceTruncated: false,
        evidence: [],
        totalTrajectoryCount: 0,
        trajectoryEvidence: [],
      },
    ],
  },
};

/** The same read on an Intelligence with a dashboard: the route adds its origin and links. */
export const INSPECTOR_WITH_DASHBOARD = {
  ...INSPECTOR_NO_DASHBOARD,
  webAppOrigin: "https://dashboard.example.test",
  links: {
    learning:
      "https://dashboard.example.test/o/test-org-dca092de/test-project-dca092de/learning/openbot",
    candidates:
      "https://dashboard.example.test/o/test-org-dca092de/test-project-dca092de/learning/openbot/skills",
    runs: "https://dashboard.example.test/o/test-org-dca092de/test-project-dca092de/learning/openbot/analysis-results",
  },
};

export type FakeIntelligence = {
  url: string;
  requests: {
    method: string;
    path: string;
    auth: string | null;
    body: unknown;
  }[];
  containers: Map<string, ReturnType<typeof container>>;
  candidates: Map<string, ReturnType<typeof candidate>>;
  stop: () => void;
};

/**
 * Serve one of the four Intelligences on 127.0.0.1. `starting`: the first `migrating` requests meet
 * the migrations and the next `keyless` the wait for the bootstrap. `failCreates`: the first container
 * creations fail as a 500.
 */
export function fakeIntelligence(
  version: "current" | "0.15.1" | "learning-off" | "rollout-closed",
  options: {
    containers?: string[];
    candidates?: string[];
    starting?: { migrating?: number; keyless?: number };
    failCreates?: number;
    inspector?: "no-dashboard" | "dashboard" | "dashboard-before-opt-in";
    /** The installation's Learning agent has no model, so a run is refused. */
    noModel?: boolean;
    /** Files that replace a candidate's bundle, by candidate id. */
    bundles?: Record<string, { path: string; content: string }[]>;
  } = {},
): FakeIntelligence {
  const migrating = options.starting?.migrating ?? 0;
  const keyless = options.starting?.keyless ?? 0;
  let createsFailed = 0;
  const containers = new Map(
    (options.containers ?? []).map((id) => [id, container(id, id)]),
  );
  const candidates = new Map(
    (options.candidates ?? []).map((id) => [id, candidate(id)]),
  );
  const requests: FakeIntelligence["requests"] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      const text = await request.text();
      requests.push({
        method: request.method,
        path,
        auth: request.headers.get("authorization"),
        body: text ? JSON.parse(text) : null,
      });
      const answered = requests.length - 1;
      if (answered < migrating)
        return intelligenceError("INTERNAL_SERVER_ERROR");
      if (answered < migrating + keyless)
        return intelligenceError("AUTH_UNAUTHENTICATED");
      if (version === "learning-off")
        return intelligenceError("ROUTE_NOT_FOUND");
      if (request.headers.get("authorization") !== `Bearer ${RUNTIME_KEY}`)
        return Response.json(
          { error: { code: "AUTH_UNAUTHENTICATED" } },
          { status: 401 },
        );
      if (path === "/api/inspector/learning") {
        // The route sets these headers before it answers.
        const headers = {
          "cache-control": "no-store, private",
          pragma: "no-cache",
        };
        const optIn = url.searchParams.get("dashboardLinksOptional");
        const invalid = Response.json(
          { error: "Invalid Inspector Learning request." },
          { status: 400, headers },
        );
        if (
          !options.inspector ||
          (options.inspector === "no-dashboard" && optIn !== "true")
        )
          return new Response(null, { status: 404, headers });
        if (options.inspector === "no-dashboard")
          return Response.json(INSPECTOR_NO_DASHBOARD, { headers });
        if (
          optIn !== null &&
          (options.inspector === "dashboard-before-opt-in" || optIn !== "true")
        )
          return invalid;
        return Response.json(INSPECTOR_WITH_DASHBOARD, { headers });
      }
      if (version === "rollout-closed" && path.startsWith("/api/v1/learning/"))
        return intelligenceError("LEARNING_NOT_ENABLED");
      if (path === "/api/v1/learning/containers" && request.method === "POST") {
        if (version === "0.15.1") return intelligenceError("ROUTE_NOT_FOUND");
        if (createsFailed < (options.failCreates ?? 0)) {
          createsFailed++;
          return intelligenceError("INTERNAL_SERVER_ERROR");
        }
        const body = JSON.parse(text) as { id: string; name: string };
        const existing = containers.get(body.id);
        if (existing)
          return Response.json({ container: existing }, { status: 200 });
        const made = container(body.id, body.name);
        containers.set(body.id, made);
        return Response.json({ container: made }, { status: 201 });
      }
      const match =
        /^\/api\/v1\/learning\/containers\/([a-z0-9-]+)(?:\/(skills|runs|candidates|insights)(?:\/([0-9a-f-]+)(?:\/(approve|reject|evidence))?)?)?$/.exec(
          path,
        );
      if (!match) return intelligenceError("ROUTE_NOT_FOUND");
      const [, containerId = "", collection, itemId, action] = match;
      const found = containers.get(containerId);
      if (collection === "skills")
        return intelligenceError(
          found ? "REVISION_NOT_FOUND" : "CONTAINER_NOT_FOUND",
        );
      if (!found) return intelligenceError("LEARNING_CONTAINER_NOT_FOUND");
      if (!collection) return Response.json({ container: found });
      if (collection === "runs")
        return request.method === "POST"
          ? options.noModel
            ? intelligenceError("LEARNING_MODEL_NOT_CONFIGURED")
            : Response.json({ run: run() }, { status: 202 })
          : Response.json({ runs: [run("succeeded")] });
      if (collection === "insights")
        return itemId === INSIGHT_ID &&
          action === "evidence" &&
          request.method === "GET"
          ? Response.json({ evidence: EVIDENCE })
          : intelligenceError("ROUTE_NOT_FOUND");
      // Candidates have a list and a detail to GET, and approve and reject to POST; nothing else is routed.
      const reviewing = action === "approve" || action === "reject";
      if (
        action === "evidence" ||
        request.method !== (reviewing ? "POST" : "GET")
      )
        return intelligenceError("ROUTE_NOT_FOUND");
      if (!itemId)
        return Response.json({ candidates: [...candidates.values()] });
      const proposal = candidates.get(itemId);
      if (!proposal) return intelligenceError("LEARNING_CANDIDATE_NOT_FOUND");
      if (!action)
        return Response.json({
          candidate: candidateDetail(
            itemId,
            options.bundles?.[itemId],
            proposal,
          ),
        });
      if (proposal.status !== "pending_review")
        return intelligenceError("LEARNING_CANDIDATE_CONFLICT");
      const approved = action === "approve";
      const reviewed = {
        ...proposal,
        status: approved ? ("approved" as const) : ("rejected" as const),
        reviewedAt: NOW,
        publishedSkillId: approved ? PUBLISHED_SKILL_ID : null,
        publishedRegistryRevision: approved ? PUBLISHED_REVISION : null,
      };
      candidates.set(itemId, reviewed);
      return Response.json({
        review: {
          candidateId: itemId,
          operation: reviewed.operation,
          publishedRegistryRevision: reviewed.publishedRegistryRevision,
          publishedSkillId: reviewed.publishedSkillId,
          status: reviewed.status,
        },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    containers,
    candidates,
    stop: () => server.stop(true),
  };
}

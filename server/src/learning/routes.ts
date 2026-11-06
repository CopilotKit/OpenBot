import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import type {
  LearningAutoAssignState,
  LearningDeliveryStatus,
  LearningEvidence,
  LearningOverview,
  LearningProposal,
  LearningProposalDetail,
  LearningTarget,
} from "@openbot/shared/learning";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type AuditStore, recordAuditEvent } from "../audit";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { LearningAutoAssign } from "./auto-assign";
import type { InspectorLearning, InspectorLearningRequest } from "./inspector";
import { type LearningSettingsStore, parseLearningSettings } from "./settings";

/** The longest the settings page waits for an automatic check before answering without it. */
const AUTO_ASSIGN_WAIT_MS = 3_000;

/** The runtime key's own Learning routes: a project's containers, runs and proposed Skills. */
export type LearningManagement = Pick<
  CopilotKitIntelligence["experimental"]["learning"],
  | "getLearningContainer"
  | "listLearningRuns"
  | "startLearningRun"
  | "listLearningCandidates"
  | "getLearningCandidate"
  | "getLearningInsightEvidence"
  | "reviewLearningCandidate"
>;
export type LearningAdminDependencies = {
  store: LearningSettingsStore;
  autoAssign?: LearningAutoAssign;
  status?: (agentId: string) => Promise<LearningDeliveryStatus>;
  /** Intelligence's Inspector panel, which has every count (`createInspectorLearningReader`). */
  inspect?: (input: InspectorLearningRequest) => Promise<InspectorLearning>;
  /** Review and publish here, which an Intelligence with no dashboard of its own needs. */
  manage?: LearningManagement;
};

/** An Inspector link, when it is one a browser can open on the dashboard's own origin. */
function link(
  value: string | null | undefined,
  origin: string | null,
): string | null {
  if (!value || !origin) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === origin
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** The dashboard's origin, or null for an Intelligence with no dashboard. */
function dashboardOrigin(snapshot: InspectorLearning): string | null {
  if (!snapshot.webAppOrigin) return null;
  try {
    return new URL(snapshot.webAppOrigin).origin;
  } catch {
    return null;
  }
}

function overview(snapshot: InspectorLearning): LearningOverview {
  const origin = dashboardOrigin(snapshot);
  return {
    configuration: snapshot.configuration.state,
    ...(snapshot.configuration.state === "configured"
      ? { container: snapshot.configuration.container }
      : {}),
    pendingThreadCount: snapshot.pendingThreadCount,
    pendingCandidateCount: snapshot.pendingCandidateCount,
    publishedSkillCount: snapshot.skillsPage.total,
    insightCount: snapshot.insightsPage.total,
    hasActiveRun: snapshot.run.hasActiveRun,
    latestRunStatus: snapshot.run.latest?.status ?? null,
    links: {
      learning: link(snapshot.links?.learning, origin),
      candidates: link(snapshot.links?.candidates, origin),
      runs: link(snapshot.links?.runs, origin),
    },
  };
}

const NO_LINKS = { learning: null, candidates: null, runs: null };
const FINISHED_RUNS = new Set(["succeeded", "failed"]);

/**
 * The overview from the project key's own Learning routes, for an older Intelligence that serves no
 * Inspector panel when it has no dashboard. It cannot count waiting conversations, published Skills
 * or Insights, so those are null, and there is nothing to link to.
 */
async function managedOverview(
  manage: LearningManagement,
  target: LearningTarget | null,
): Promise<LearningOverview> {
  const empty = {
    pendingThreadCount: null,
    pendingCandidateCount: 0,
    publishedSkillCount: null,
    insightCount: null,
    hasActiveRun: false,
    latestRunStatus: null,
    links: NO_LINKS,
  };
  if (!target) return { configuration: "not_configured", ...empty };
  const containerId = target.containerId;
  let container: { id: string; name: string };
  try {
    const found = await manage.getLearningContainer({ containerId });
    container = { id: found.id, name: found.name };
  } catch (error) {
    if (requestFailure(error).code === "LEARNING_CONTAINER_NOT_FOUND")
      return { configuration: "invalid", ...empty };
    throw error;
  }
  const [candidates, runs] = await Promise.all([
    manage.listLearningCandidates({ containerId }),
    manage.listLearningRuns({ containerId }),
  ]);
  const latest = [...runs].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )[0];
  return {
    ...empty,
    configuration: "configured",
    container,
    pendingCandidateCount: candidates.filter(
      (candidate) => candidate.status === "pending_review",
    ).length,
    hasActiveRun: runs.some((run) => !FINISHED_RUNS.has(run.status)),
    latestRunStatus: latest?.status ?? null,
  };
}

/** The HTTP status and Intelligence error code a Learning request failed with. */
function requestFailure(error: unknown): { status?: number; code?: string } {
  if (error === null || typeof error !== "object") return {};
  const { status, code } = error as { status?: unknown; code?: unknown };
  return {
    ...(typeof status === "number" ? { status } : {}),
    ...(typeof code === "string" ? { code } : {}),
  };
}

/** What to tell an admin when Intelligence refused a Learning request, and with which status. */
function learningFailure(error: unknown): {
  status: ContentfulStatusCode;
  error: string;
} {
  const { status, code } = requestFailure(error);
  if (status === 404 && code === "ROUTE_NOT_FOUND")
    return {
      status: 409,
      error:
        "Learning is switched off in Intelligence. Turn it on there (learning.enabled in its Helm chart).",
    };
  if (code === "LEARNING_CONTAINER_NOT_FOUND")
    return {
      status: 404,
      error: "This Learning container doesn't exist in Intelligence yet.",
    };
  if (code === "LEARNING_CANDIDATE_NOT_FOUND")
    return {
      status: 404,
      error: "Intelligence no longer has this skill. Refresh the list.",
    };
  if (code === "LEARNING_CANDIDATE_CONFLICT")
    return {
      status: 409,
      error: "This skill was already reviewed. Refresh the list to see it.",
    };
  if (code === "LEARNING_NOT_ENABLED")
    return {
      status: 403,
      error: "This Intelligence licence doesn't include Learning.",
    };
  if (code === "LEARNING_MODEL_NOT_CONFIGURED")
    return {
      status: 409,
      error:
        "Intelligence has no Learning model yet. Give its Learning agent a model and key, then try again.",
    };
  if (status === 429 || code === "RATE_LIMIT_EXCEEDED")
    return {
      status: 429,
      error: "Intelligence is busy. Try again in a minute.",
    };
  return {
    status: 502,
    error: "Couldn't reach Intelligence Learning. Try again.",
  };
}

const CANDIDATE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The most Insights one proposal shows evidence for. */
const MAX_INSIGHTS = 10;
/** The longest cited message shown, in characters. */
const MAX_MESSAGE = 4_000;

type Candidate = Awaited<
  ReturnType<LearningManagement["listLearningCandidates"]>
>[number];
type CandidateDetail = Awaited<
  ReturnType<LearningManagement["getLearningCandidate"]>
>;
type Evidence = Awaited<
  ReturnType<LearningManagement["getLearningInsightEvidence"]>
>[number];

function proposal(candidate: Candidate): LearningProposal {
  return {
    id: candidate.id,
    title: candidate.title,
    description: candidate.description,
    reason: candidate.reason,
    operation: candidate.operation,
    status: candidate.status,
    createdAt: candidate.createdAt,
    reviewedAt: candidate.reviewedAt,
  };
}

function evidence(entry: Evidence): LearningEvidence {
  if ("kind" in entry && entry.kind === "trajectory")
    return {
      kind: "recording",
      id: entry.trajectoryId,
      available: entry.trajectoryPresent && entry.unavailable === null,
      eventCount: entry.eventCount,
      events: entry.events.map((event) => event.name),
    };
  const thread = entry as Extract<Evidence, { threadId: string }>;
  return {
    kind: "conversation",
    id: thread.threadId,
    title: thread.threadName,
    available: thread.threadPresent && thread.unavailable === null,
    messages: thread.cited.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content.slice(0, MAX_MESSAGE),
    })),
  };
}

function proposalDetail(
  candidate: CandidateDetail,
  insights: LearningProposalDetail["insights"],
): LearningProposalDetail {
  const files = [...candidate.bundle.files]
    .sort((a, b) =>
      a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : 0,
    )
    .map((file) => ({ path: file.path, content: file.content }));
  return { ...proposal(candidate), files, insights };
}

export function createLearningRoutes(
  dependencies: LearningAdminDependencies,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  trustedOrigins: readonly string[] = [],
  audit?: AuditStore,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser, async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  });
  routes.onError((error) => {
    console.error(
      JSON.stringify({ type: "learning-admin-error", errorType: error.name }),
    );
    return new Response(
      JSON.stringify({
        error:
          "Couldn't load learning settings. Try again, or ask an admin if it keeps happening.",
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  });
  routes.get("/settings", async (context) => {
    // Check first, so an administrator who just created the container sees it assigned on this
    // load. Bounded: a slow Intelligence answers on a later load, not by holding this one.
    let automatic: LearningAutoAssignState | undefined;
    if (dependencies.autoAssign) {
      const autoAssign = dependencies.autoAssign;
      let timer: ReturnType<typeof setTimeout> | undefined;
      automatic = await Promise.race([
        autoAssign.check(),
        new Promise<LearningAutoAssignState>((resolve) => {
          timer = setTimeout(
            () => resolve(autoAssign.state()),
            AUTO_ASSIGN_WAIT_MS,
          );
        }),
      ]).finally(() => clearTimeout(timer));
    }
    return context.json({
      settings: await dependencies.store.read(),
      ...(automatic ? { automatic } : {}),
    });
  });
  /** JSON excludes form CSRF; browser requests must also match an explicitly trusted origin. */
  const sameOriginJson = (context: Context<{ Variables: AppVariables }>) => {
    const origin = context.req.header("origin");
    const allowed = new Set([
      new URL(context.req.url).origin,
      ...trustedOrigins,
    ]);
    return (
      context.req.header("content-type")?.split(";")[0]?.trim() ===
        "application/json" &&
      (origin
        ? allowed.has(origin)
        : context.req.header("sec-fetch-site") !== "cross-site")
    );
  };
  /**
   * Create this project's container with the credential this deployment holds, then assign it.
   * Offered only when there is one (`automatic.canCreate`); without one the page shows what to run.
   */
  routes.post("/container", async (context) => {
    if (!sameOriginJson(context))
      return context.json(
        { error: "Use a same-origin JSON request to create the container." },
        403,
      );
    if (!dependencies.autoAssign)
      return context.json(
        { error: "Automatic Learning assignment is switched off." },
        409,
      );
    const automatic = await dependencies.autoAssign.createNow();
    if (audit)
      await recordAuditEvent(audit, {
        eventType: "configuration.changed",
        targetType: "learning",
        actorUserId: context.var.actor.id,
        payload: {
          change: "container_creation_requested",
          outcome: automatic.state,
        },
      });
    return context.json({ automatic });
  });
  routes.put(
    "/settings",
    bodyLimit({ maxSize: 128 * 1024 }),
    async (context) => {
      if (!sameOriginJson(context)) {
        return context.json(
          {
            error:
              "Use a same-origin JSON request to change Learning settings.",
          },
          403,
        );
      }
      const parsed = parseLearningSettings(
        await context.req.json().catch(() => null),
      );
      if (!parsed.ok) return context.json({ error: parsed.error }, 400);
      const settings = await dependencies.store.write(parsed.settings);
      if (audit)
        await recordAuditEvent(audit, {
          eventType: "configuration.changed",
          targetType: "learning",
          actorUserId: context.var.actor.id,
          payload: {
            enabled: settings.enabled,
            defaultContainerId: settings.defaultTarget?.containerId ?? null,
            botMappingCount: Object.keys(settings.agents).length,
          },
        });
      return context.json({ settings });
    },
  );
  /** The container a request is about: a Bot's own, or the deployment default. */
  const targetFor = async (
    context: Context<{ Variables: AppVariables }>,
  ): Promise<
    | { ok: true; agentId?: string; target: LearningTarget | null }
    | { ok: false }
  > => {
    const agentId = context.req.query("agentId");
    if (agentId && agentId.length > 128) return { ok: false };
    const settings = await dependencies.store.read();
    const target =
      agentId && Object.hasOwn(settings.agents, agentId)
        ? (settings.agents[agentId] ?? null)
        : settings.defaultTarget;
    return { ok: true, ...(agentId ? { agentId } : {}), target };
  };
  routes.get("/overview", async (context) => {
    if (!dependencies.inspect && !dependencies.manage)
      return context.json(
        { error: "Learning inspection is unavailable." },
        503,
      );
    const scope = await targetFor(context);
    if (!scope.ok) return context.json({ error: "Invalid Bot ID." }, 400);
    const { agentId, target } = scope;
    try {
      if (dependencies.inspect) {
        try {
          // The browser cannot inject a container or project credential into this request.
          const snapshot = await dependencies.inspect({
            ...(agentId ? { agentId } : {}),
            ...(target ? { runtimeContainerId: target.containerId } : {}),
          });
          return context.json({ overview: overview(snapshot) });
        } catch (error) {
          // No Inspector panel: an older Intelligence with no dashboard, or Learning off. The
          // project key's own routes answer the first and name the second.
          if (requestFailure(error).status !== 404 || !dependencies.manage)
            throw error;
        }
      }
      if (!dependencies.manage) throw new Error("No Learning management.");
      return context.json({
        overview: await managedOverview(dependencies.manage, target),
      });
    } catch (error) {
      const failure = learningFailure(error);
      return context.json(
        {
          error:
            failure.status === 502
              ? "Intelligence Learning is unavailable. Check the project permissions and endpoint, then retry."
              : failure.error,
        },
        failure.status,
      );
    }
  });
  /** The skills Intelligence proposed for the container, newest first, reviewed ones included. */
  routes.get("/proposals", async (context) => {
    const manage = dependencies.manage;
    if (!manage)
      return context.json(
        { error: "Reviewing skills here is unavailable." },
        503,
      );
    const scope = await targetFor(context);
    if (!scope.ok) return context.json({ error: "Invalid Bot ID." }, 400);
    if (!scope.target)
      return context.json({ containerId: null, proposals: [] });
    const containerId = scope.target.containerId;
    try {
      const candidates = await manage.listLearningCandidates({ containerId });
      return context.json({ containerId, proposals: candidates.map(proposal) });
    } catch (error) {
      const failure = learningFailure(error);
      return context.json({ error: failure.error }, failure.status);
    }
  });
  /** One proposal with every file it would publish and the evidence behind it. */
  routes.get("/proposals/:candidateId", async (context) => {
    const manage = dependencies.manage;
    if (!manage)
      return context.json(
        { error: "Reviewing skills here is unavailable." },
        503,
      );
    const candidateId = context.req.param("candidateId");
    if (!CANDIDATE_ID.test(candidateId))
      return context.json({ error: "Invalid skill ID." }, 400);
    const scope = await targetFor(context);
    if (!scope.ok) return context.json({ error: "Invalid Bot ID." }, 400);
    if (!scope.target)
      return context.json({ error: "No Learning container is assigned." }, 404);
    const containerId = scope.target.containerId;
    try {
      const candidate = await manage.getLearningCandidate({
        containerId,
        candidateId,
      });
      const insights = await Promise.all(
        candidate.supportingInsights
          .slice(0, MAX_INSIGHTS)
          .map(async (insight) => ({
            id: insight.id,
            statement: insight.statement,
            impact: insight.impact,
            evidence: await manage
              .getLearningInsightEvidence({
                containerId,
                insightId: insight.id,
              })
              .then((entries) => entries.map(evidence))
              .catch(() => null),
          })),
      );
      return context.json({ proposal: proposalDetail(candidate, insights) });
    } catch (error) {
      const failure = learningFailure(error);
      return context.json({ error: failure.error }, failure.status);
    }
  });
  /**
   * Approve (which publishes it to every Bot on the container) or reject a proposal. Intelligence
   * records the runtime key as the reviewer, so OpenBot's own audit records which admin it was.
   */
  for (const action of ["approve", "reject"] as const) {
    routes.post(`/proposals/:candidateId/${action}`, async (context) => {
      if (!sameOriginJson(context))
        return context.json(
          { error: "Use a same-origin JSON request to review a skill." },
          403,
        );
      const manage = dependencies.manage;
      if (!manage)
        return context.json(
          { error: "Reviewing skills here is unavailable." },
          503,
        );
      const candidateId = context.req.param("candidateId");
      if (!CANDIDATE_ID.test(candidateId))
        return context.json({ error: "Invalid skill ID." }, 400);
      const scope = await targetFor(context);
      if (!scope.ok) return context.json({ error: "Invalid Bot ID." }, 400);
      if (!scope.target)
        return context.json(
          { error: "No Learning container is assigned." },
          404,
        );
      const containerId = scope.target.containerId;
      const actor = context.var.actor;
      let title: string | undefined;
      try {
        title = (
          await manage.getLearningCandidate({ containerId, candidateId })
        ).title;
        const review = await manage.reviewLearningCandidate({
          containerId,
          candidateId,
          action,
        });
        if (audit)
          await recordAuditEvent(audit, {
            eventType: "configuration.changed",
            targetType: "learning_skill",
            targetId: candidateId,
            actorUserId: actor.id,
            payload: {
              change:
                action === "approve" ? "skill_approved" : "skill_rejected",
              containerId,
              title,
              operation: review.operation,
              publishedSkillId: review.publishedSkillId,
              by: actor.email,
            },
          });
        return context.json({
          proposal: { id: candidateId, status: review.status },
        });
      } catch (error) {
        const failure = learningFailure(error);
        if (audit)
          await recordAuditEvent(audit, {
            eventType: "configuration.changed",
            targetType: "learning_skill",
            targetId: candidateId,
            actorUserId: actor.id,
            payload: {
              change: "skill_review_failed",
              decision: action,
              containerId,
              ...(title ? { title } : {}),
              code: requestFailure(error).code ?? null,
              by: actor.email,
            },
          });
        return context.json({ error: failure.error }, failure.status);
      }
    });
  }
  /** Learn now: start a Learning run on the container over every finished conversation not yet used. */
  routes.post("/runs", async (context) => {
    if (!sameOriginJson(context))
      return context.json(
        { error: "Use a same-origin JSON request to start Learning." },
        403,
      );
    const manage = dependencies.manage;
    if (!manage)
      return context.json(
        { error: "Starting Learning here is unavailable." },
        503,
      );
    const scope = await targetFor(context);
    if (!scope.ok) return context.json({ error: "Invalid Bot ID." }, 400);
    if (!scope.target)
      return context.json({ error: "No Learning container is assigned." }, 404);
    const containerId = scope.target.containerId;
    try {
      const run = await manage.startLearningRun({ containerId });
      if (audit)
        await recordAuditEvent(audit, {
          eventType: "configuration.changed",
          targetType: "learning",
          actorUserId: context.var.actor.id,
          payload: {
            change: "learning_run_started",
            containerId,
            runId: run.id,
            by: context.var.actor.email,
          },
        });
      return context.json({ run: { id: run.id, status: run.status } });
    } catch (error) {
      const failure = learningFailure(error);
      return context.json({ error: failure.error }, failure.status);
    }
  });
  routes.get("/status/:agentId", async (context) => {
    if (!dependencies.status)
      return context.json(
        { error: "Skill delivery status is unavailable." },
        503,
      );
    try {
      return context.json({
        status: await dependencies.status(context.req.param("agentId")),
      });
    } catch {
      return context.json(
        { error: "Skill delivery status could not be read. Try again." },
        502,
      );
    }
  });
  return routes;
}

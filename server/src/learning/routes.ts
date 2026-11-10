import {
  isLearnedSkillName,
  isLearningPersonalReview,
  type LearnedSkillContent,
  type LearningAutoAssignState,
  type LearningDeliveryStatus,
  type LearningOverview,
  type LearningTarget,
  type PeopleProposals,
  type SharingRequest,
} from "@openbot/shared/learning";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AuditStore, recordAuditEvent } from "../audit";
import { type AppVariables, requireAdmin } from "../auth/guards";
import { recordApprovalBefore, type SkillApprovalStore } from "./approvals";
import type { LearningAutoAssign } from "./auto-assign";
import type { InspectorLearning, InspectorLearningRequest } from "./inspector";
import {
  CANDIDATE_ID,
  type LearningManagement,
  type LearningModelUnavailable,
  learningFailure,
  noLearningModel,
  readProposal,
  readProposals,
  requestFailure,
  reviewProposal,
  runSummary,
} from "./review";
import { type LearningSettingsStore, parseLearningSettings } from "./settings";

export type { LearningManagement, LearningModelUnavailable };
export { learningModelUnavailable } from "./review";

/** The longest the settings page waits for an automatic check before answering without it. */
const AUTO_ASSIGN_WAIT_MS = 3_000;

export type LearningAdminDependencies = {
  store: LearningSettingsStore;
  autoAssign?: LearningAutoAssign;
  status?: (agentId: string) => Promise<LearningDeliveryStatus>;
  /** Intelligence's Inspector panel, which has every count (`createInspectorLearningReader`). */
  inspect?: (input: InspectorLearningRequest) => Promise<InspectorLearning>;
  /** Review and publish here, which an Intelligence with no dashboard of its own needs. */
  manage?: LearningManagement;
  /**
   * Why OpenBot Desktop could not give its local Intelligence's Learning agent a model, from
   * `OPENBOT_LEARNING_MODEL_UNAVAILABLE`. See `learningModelUnavailable`.
   */
  modelUnavailable?: LearningModelUnavailable;
  /** What admins decided about skills people learned, kept by OpenBot. */
  approvals?: SkillApprovalStore;
  /** The people whose recordings are learned from, each with their own Learning space. */
  people?: () => Promise<
    { userId: string; name: string; containerId: string }[]
  >;
  /** Called when a decision changes which skills are open, so the open-skill index reads again. */
  invalidate?: () => void;
  /** The titles of a person's recordings, by recording id. */
  recordingTitles?: (
    userId: string,
    ids: string[],
  ) => Promise<Map<string, string | null>>;
  /** One Skill a person published, with its files; null when they have none by that name. */
  personSkill?: (
    userId: string,
    name: string,
  ) => Promise<LearnedSkillContent | null>;
  /** The Skills published to a container, with their files. */
  skills?: (
    containerId: string,
  ) => Promise<
    { skills: LearnedSkillContent[] } | { unavailable: "off" | "unavailable" }
  >;
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

/** The `updated_at` stamp the approval store writes: a full timestamp with a zone, as Postgres prints it. */
const STAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

function isStamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = STAMP.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match
    .slice(1)
    .map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59)
    return false;
  return day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Maps `items` with at most `limit` calls running at once, keeping the order. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index] as T);
      }
    }),
  );
  return results;
}

export function createLearningRoutes(
  dependencies: LearningAdminDependencies,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  trustedOrigins: readonly string[] = [],
  audit?: AuditStore,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  /**
   * Records an audit event for something that already happened. A failed write is logged and never changes the
   * answer: the review or decision it describes is done, and its error is what the admin should see.
   */
  const recordSettled = async (
    event: Parameters<typeof recordAuditEvent>[1],
  ) => {
    if (!audit) return;
    try {
      await recordAuditEvent(audit, event);
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "learning-audit-failed",
          eventType: event.eventType,
          errorType: error instanceof Error ? error.name : "unknown",
        }),
      );
    }
  };
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
      const stored = await dependencies.store.read();
      const next = { ...parsed.settings };
      const personalReview =
        parsed.settings.personalReview ?? stored.personalReview;
      const autoApprove = parsed.settings.autoApprove ?? stored.autoApprove;
      if (personalReview !== undefined) next.personalReview = personalReview;
      if (autoApprove !== undefined) next.autoApprove = autoApprove;
      const settings = await dependencies.store.write(next);
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
  routes.put(
    "/personal-review",
    bodyLimit({ maxSize: 4 * 1024 }),
    async (context) => {
      if (!sameOriginJson(context)) {
        return context.json(
          {
            error:
              "Use a same-origin JSON request to change who approves skills.",
          },
          403,
        );
      }
      const body = (await context.req.json().catch(() => null)) as {
        personalReview?: unknown;
      } | null;
      const personalReview = body?.personalReview;
      if (!isLearningPersonalReview(personalReview))
        return context.json(
          { error: "Choose admins or people to approve skills." },
          400,
        );
      const current = await dependencies.store.read();
      const settings = await dependencies.store.write({
        ...current,
        personalReview,
      });
      if (audit)
        await recordAuditEvent(audit, {
          eventType: "configuration.changed",
          targetType: "learning",
          actorUserId: context.var.actor.id,
          payload: {
            change: "personal_review",
            from: current.personalReview ?? "admins",
            to: personalReview,
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
    // Said before anyone presses Learn now: automatic Learning runs on the same model.
    const modelProblem = dependencies.modelUnavailable
      ? { modelProblem: noLearningModel(dependencies.modelUnavailable) }
      : {};
    try {
      if (dependencies.inspect) {
        try {
          // The browser cannot inject a container or project credential into this request.
          const snapshot = await dependencies.inspect({
            ...(agentId ? { agentId } : {}),
            ...(target ? { runtimeContainerId: target.containerId } : {}),
          });
          return context.json({
            overview: { ...overview(snapshot), ...modelProblem },
          });
        } catch (error) {
          // No Inspector panel: an older Intelligence with no dashboard, or Learning off. The
          // project key's own routes answer the first and name the second.
          if (requestFailure(error).status !== 404 || !dependencies.manage)
            throw error;
        }
      }
      if (!dependencies.manage) throw new Error("No Learning management.");
      return context.json({
        overview: {
          ...(await managedOverview(dependencies.manage, target)),
          ...modelProblem,
        },
      });
    } catch (error) {
      const failure = learningFailure(error, dependencies.modelUnavailable);
      return context.json(
        {
          error:
            failure.status === 502
              ? "Learning in the backend is unavailable. Check the project permissions and endpoint, then retry."
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
      return context.json({
        containerId,
        proposals: await readProposals(manage, containerId),
      });
    } catch (error) {
      const failure = learningFailure(error, dependencies.modelUnavailable);
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
      return context.json({
        proposal: await readProposal(manage, containerId, candidateId),
      });
    } catch (error) {
      const failure = learningFailure(error, dependencies.modelUnavailable);
      return context.json({ error: failure.error }, failure.status);
    }
  });
  /** Each person's pending proposals, or null for a person whose space can't be read. */
  routes.get("/people/proposals", async (context) => {
    const { manage, people } = dependencies;
    if (!manage || !people)
      return context.json(
        { error: "Reviewing skills from people is unavailable." },
        503,
      );
    const listed = await people();
    const result: PeopleProposals = {
      people: await mapLimited(listed, 4, async (person) => ({
        userId: person.userId,
        name: person.name,
        proposals: await readProposals(manage, person.containerId)
          .then((all) => all.filter((p) => p.status === "pending_review"))
          .catch((error: unknown) => {
            // A person who never recorded has no space yet: nothing is pending, and nothing is wrong.
            const { status, code } = requestFailure(error);
            if (code !== "LEARNING_CONTAINER_NOT_FOUND")
              console.error(
                JSON.stringify({
                  type: "learning-people-proposals-failed",
                  userId: person.userId,
                  errorType: error instanceof Error ? error.name : "unknown",
                  ...(status !== undefined ? { status } : {}),
                  ...(code !== undefined ? { code } : {}),
                }),
              );
            return null;
          }),
      })),
    };
    return context.json(result);
  });
  /** One proposal learned from a person's recordings, with their titles. */
  routes.get("/people/:userId/proposals/:candidateId", async (context) => {
    const { manage, people, recordingTitles } = dependencies;
    if (!manage || !people)
      return context.json(
        { error: "Reviewing skills from people is unavailable." },
        503,
      );
    const candidateId = context.req.param("candidateId");
    if (!CANDIDATE_ID.test(candidateId))
      return context.json({ error: "Invalid skill ID." }, 400);
    const userId = context.req.param("userId");
    const person = (await people()).find((entry) => entry.userId === userId);
    if (!person)
      return context.json({ error: "This person doesn't exist." }, 404);
    try {
      return context.json({
        proposal: await readProposal(
          manage,
          person.containerId,
          candidateId,
          recordingTitles ? (ids) => recordingTitles(userId, ids) : undefined,
        ),
      });
    } catch (error) {
      const failure = learningFailure(error, dependencies.modelUnavailable);
      return context.json({ error: failure.error }, failure.status);
    }
  });
  /** One Skill a person published, with its files. */
  routes.get("/people/:userId/skills/:name", async (context) => {
    const { people, personSkill } = dependencies;
    if (!people || !personSkill)
      return context.json(
        { error: "Reading skills from people is unavailable." },
        503,
      );
    const name = context.req.param("name");
    if (!isLearnedSkillName(name))
      return context.json({ error: "Invalid skill name." }, 400);
    const userId = context.req.param("userId");
    if (!(await people()).some((entry) => entry.userId === userId))
      return context.json({ error: "This person doesn't exist." }, 404);
    const skill = await personSkill(userId, name).catch(() => undefined);
    if (skill === undefined)
      return context.json(
        {
          error:
            "Couldn't read this person's Skills from the backend just now. Try again.",
        },
        503,
      );
    if (!skill)
      return context.json({ error: "This skill doesn't exist." }, 404);
    return context.json({ skill });
  });
  routes.get("/sharing-requests", async (context) => {
    const { approvals, people } = dependencies;
    if (!approvals || !people)
      return context.json(
        { error: "Reviewing sharing requests is unavailable." },
        503,
      );
    const names = new Map(
      (await people()).map((entry) => [entry.userId, entry.name]),
    );
    const requests: SharingRequest[] = (await approvals.requests()).map(
      (entry) => ({
        userId: entry.userId,
        name: names.get(entry.userId) ?? entry.userId,
        skillName: entry.skillName,
        requestedAt: entry.updatedAt,
      }),
    );
    return context.json({ requests });
  });
  /** Answer a person's request to open a skill they approved to every Bot. */
  for (const action of ["approve", "decline"] as const) {
    routes.post(
      `/sharing-requests/:userId/:skillName/${action}`,
      bodyLimit({
        maxSize: 4 * 1024,
        onError: (context) =>
          context.json({ error: "That request is too large." }, 413),
      }),
      async (context) => {
        if (!sameOriginJson(context))
          return context.json(
            { error: "Use a same-origin JSON request to decide sharing." },
            403,
          );
        const { approvals, people } = dependencies;
        if (!approvals || !people)
          return context.json(
            { error: "Reviewing sharing requests is unavailable." },
            503,
          );
        const skillName = context.req.param("skillName");
        if (!isLearnedSkillName(skillName))
          return context.json({ error: "Invalid skill name." }, 400);
        const userId = context.req.param("userId");
        if (!(await people()).some((entry) => entry.userId === userId))
          return context.json({ error: "This person doesn't exist." }, 404);
        const decision = action === "approve" ? "approved" : "declined";
        const body = (await context.req.json().catch(() => null)) as {
          requestedAt?: unknown;
        } | null;
        const requestedAt = body?.requestedAt;
        if (!isStamp(requestedAt))
          return context.json(
            { error: "Open the request again, then decide." },
            400,
          );
        if (
          !(await approvals.decideSharing(
            userId,
            skillName,
            decision,
            requestedAt,
          ))
        ) {
          // A stale `requestedAt` also fails; tell the two apart so the admin knows to open the skill again.
          if (
            (await approvals.requests()).some(
              (entry) =>
                entry.userId === userId && entry.skillName === skillName,
            )
          )
            return context.json(
              {
                error:
                  "This skill changed after you opened it. Open it again to see the new version.",
              },
              409,
            );
          return context.json(
            { error: "This sharing request doesn't exist." },
            404,
          );
        }
        dependencies.invalidate?.();
        await recordSettled({
          eventType: "learning.sharing_decided",
          targetType: "learned_skill",
          targetId: skillName,
          actorUserId: context.var.actor.id,
          payload: { skill: skillName, userId, decision },
        });
        return context.json({ sharing: decision });
      },
    );
  }
  /**
   * Approve or reject a proposal learned from a person's recordings. On approve, OpenBot records the skill as
   * admin-approved before Intelligence is asked, and takes that record back if Intelligence refuses.
   */
  for (const action of ["approve", "reject"] as const) {
    routes.post(
      `/people/:userId/proposals/:candidateId/${action}`,
      async (context) => {
        if (!sameOriginJson(context))
          return context.json(
            { error: "Use a same-origin JSON request to review a skill." },
            403,
          );
        const { manage, people, approvals } = dependencies;
        if (!manage || !people)
          return context.json(
            { error: "Reviewing skills from people is unavailable." },
            503,
          );
        const candidateId = context.req.param("candidateId");
        if (!CANDIDATE_ID.test(candidateId))
          return context.json({ error: "Invalid skill ID." }, 400);
        const userId = context.req.param("userId");
        const person = (await people()).find(
          (entry) => entry.userId === userId,
        );
        if (!person)
          return context.json({ error: "This person doesn't exist." }, 404);
        const containerId = person.containerId;
        const actor = context.var.actor;
        try {
          const recordApproval =
            action === "approve" && approvals
              ? recordApprovalBefore(approvals, userId, "admin")
              : undefined;
          let review: Awaited<ReturnType<typeof reviewProposal>>;
          try {
            review = await reviewProposal({
              manage,
              containerId,
              candidateId,
              action,
              ...(recordApproval
                ? {
                    before: async (
                      ...args: Parameters<typeof recordApproval>
                    ) => {
                      try {
                        return await recordApproval(...args);
                      } finally {
                        dependencies.invalidate?.();
                      }
                    },
                  }
                : {}),
            });
          } finally {
            dependencies.invalidate?.();
          }
          await recordSettled({
            eventType: "configuration.changed",
            targetType: "learning_skill",
            targetId: candidateId,
            actorUserId: actor.id,
            payload: {
              change:
                action === "approve" ? "skill_approved" : "skill_rejected",
              userId,
              containerId,
              title: review.title,
              operation: review.operation,
              by: actor.email,
            },
          });
          return context.json({
            proposal: { id: candidateId, status: review.status },
          });
        } catch (error) {
          await recordSettled({
            eventType: "configuration.changed",
            targetType: "learning_skill",
            targetId: candidateId,
            actorUserId: actor.id,
            payload: {
              change: "skill_review_failed",
              decision: action,
              userId,
              containerId,
              code: requestFailure(error).code ?? null,
              by: actor.email,
            },
          });
          const failure = learningFailure(error, dependencies.modelUnavailable);
          return context.json({ error: failure.error }, failure.status);
        }
      },
    );
  }
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
        await recordSettled({
          eventType: "configuration.changed",
          targetType: "learning_skill",
          targetId: candidateId,
          actorUserId: actor.id,
          payload: {
            change: action === "approve" ? "skill_approved" : "skill_rejected",
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
        const failure = learningFailure(error, dependencies.modelUnavailable);
        await recordSettled({
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
  /** The container's analysis runs, in the order Intelligence lists them. */
  routes.get("/runs", async (context) => {
    const manage = dependencies.manage;
    if (!manage)
      return context.json(
        { error: "Reviewing Learning here is unavailable." },
        503,
      );
    const scope = await targetFor(context);
    if (!scope.ok) return context.json({ error: "Invalid Bot ID." }, 400);
    if (!scope.target) return context.json({ containerId: null, runs: [] });
    const containerId = scope.target.containerId;
    try {
      const runs = await manage.listLearningRuns({ containerId });
      return context.json({
        containerId,
        runs: runs.map((run) => runSummary(run)),
      });
    } catch (error) {
      const failure = learningFailure(error, dependencies.modelUnavailable);
      return context.json({ error: failure.error }, failure.status);
    }
  });
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
      const failure = learningFailure(error, dependencies.modelUnavailable);
      return context.json({ error: failure.error }, failure.status);
    }
  });
  const skillsUnavailable = (kind: "off" | "unavailable") =>
    kind === "off"
      ? "Automatic learning is turned off. Turn it on to see published skills."
      : "Couldn't load published Skills from the backend. Try again.";
  /** The Skills published to the container, by name and description. */
  routes.get("/skills", async (context) => {
    const skills = dependencies.skills;
    if (!skills)
      return context.json(
        { error: "Reading published skills here is unavailable." },
        503,
      );
    const scope = await targetFor(context);
    if (!scope.ok) return context.json({ error: "Invalid Bot ID." }, 400);
    if (!scope.target) return context.json({ containerId: null, skills: [] });
    const containerId = scope.target.containerId;
    const result = await skills(containerId);
    if ("unavailable" in result)
      return context.json(
        { error: skillsUnavailable(result.unavailable) },
        503,
      );
    return context.json({
      containerId,
      skills: result.skills.map(({ name, description }) => ({
        name,
        description,
      })),
    });
  });
  /** One published Skill with its files. */
  routes.get("/skills/:name", async (context) => {
    const skills = dependencies.skills;
    if (!skills)
      return context.json(
        { error: "Reading published skills here is unavailable." },
        503,
      );
    const name = context.req.param("name");
    if (!isLearnedSkillName(name))
      return context.json({ error: "Invalid skill name." }, 400);
    const scope = await targetFor(context);
    if (!scope.ok) return context.json({ error: "Invalid Bot ID." }, 400);
    if (!scope.target)
      return context.json({ error: "No Learning container is assigned." }, 404);
    const result = await skills(scope.target.containerId);
    if ("unavailable" in result)
      return context.json(
        { error: skillsUnavailable(result.unavailable) },
        503,
      );
    const skill = result.skills.find((entry) => entry.name === name);
    if (!skill)
      return context.json({ error: "This skill doesn't exist." }, 404);
    return context.json({ skill });
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

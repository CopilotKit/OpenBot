import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type {
  LearningDeliveryStatus,
  LearningOverview,
} from "../../../shared/learning";
import { type AuditStore, recordAuditEvent } from "../audit";
import { type AppVariables, requireAdmin } from "../auth/guards";
import { type LearningSettingsStore, parseLearningSettings } from "./settings";

type InspectorSnapshot = Awaited<
  ReturnType<CopilotKitIntelligence["getInspectorLearning"]>
>;
export type LearningAdminDependencies = {
  store: LearningSettingsStore;
  status?: (agentId: string) => Promise<LearningDeliveryStatus>;
  inspect?: (input: {
    agentId?: string;
    runtimeContainerId?: string;
  }) => Promise<InspectorSnapshot>;
};

function overview(snapshot: InspectorSnapshot): LearningOverview {
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
    links: snapshot.links,
  };
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
          "Learning settings could not be accessed. Try again or contact your administrator.",
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  });
  routes.get("/settings", async (context) =>
    context.json({ settings: await dependencies.store.read() }),
  );
  routes.put(
    "/settings",
    bodyLimit({ maxSize: 128 * 1024 }),
    async (context) => {
      // JSON excludes form CSRF; browser requests must also match an explicitly trusted origin.
      const origin = context.req.header("origin");
      const allowed = new Set([
        new URL(context.req.url).origin,
        ...trustedOrigins,
      ]);
      if (
        context.req.header("content-type")?.split(";")[0]?.trim() !==
          "application/json" ||
        (origin
          ? !allowed.has(origin)
          : context.req.header("sec-fetch-site") === "cross-site")
      ) {
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
  routes.get("/overview", async (context) => {
    if (!dependencies.inspect)
      return context.json(
        { error: "Learning inspection is unavailable." },
        503,
      );
    const settings = await dependencies.store.read();
    const agentId = context.req.query("agentId");
    if (agentId && agentId.length > 128)
      return context.json({ error: "Invalid Bot ID." }, 400);
    const target =
      agentId && Object.hasOwn(settings.agents, agentId)
        ? settings.agents[agentId]
        : settings.defaultTarget;
    try {
      // The browser cannot inject a container or project credential into this request.
      const snapshot = await dependencies.inspect({
        ...(agentId ? { agentId } : {}),
        ...(target ? { runtimeContainerId: target.containerId } : {}),
      });
      return context.json({ overview: overview(snapshot) });
    } catch {
      return context.json(
        {
          error:
            "Intelligence Learning is unavailable. Check the project permissions and endpoint, then retry.",
        },
        502,
      );
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

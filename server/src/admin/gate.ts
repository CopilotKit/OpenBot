/**
 * The HTTP half of the capability switches, and the model allowlist.
 *
 * Mounted once in app.ts as `app.use("/api/*", createEnterpriseGate(requireUser))`. A request that
 * matches none of the routes below passes straight through without a session lookup. One that
 * matches is authenticated by the same `requireUser` the route itself uses, checked, and refused with
 * a 403 carrying a sentence the person can act on. The route then runs its own guard as before.
 *
 * Fail closed: a capability that cannot be read refuses (503). Where the enterprise controls were
 * never installed (a unit test, a script) the gate passes everything, which is the product as it was.
 */
import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import { agents } from "../db/schema";
import { type Capability, capabilityRefusal } from "./capabilities";
import { enterpriseControls } from "./controls";

type Ctx = Context<{ Variables: AppVariables }>;

type Rule = {
  method: string | string[];
  path: RegExp;
  /** The capabilities this request needs, possibly depending on its body. */
  needs: (context: Ctx) => Promise<Capability[]>;
};

async function body(context: Ctx): Promise<Record<string, unknown>> {
  try {
    const parsed = await context.req.raw.clone().json();
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const RUN = /^\/api\/copilotkit\/agent\/([^/]+)\/(run|connect)$/;

export const GATED_ROUTES: Rule[] = [
  { method: "POST", path: RUN, needs: async () => ["useBots"] },
  {
    method: ["POST", "PATCH"],
    path: /^\/api\/agents(\/[^/]+)?$/,
    needs: async (context) =>
      String((await body(context)).visibility ?? "").trim() === "public"
        ? ["useBots", "teamBots"]
        : ["useBots"],
  },
  {
    method: "POST",
    path: /^\/api\/agents\/[^/]+\/duplicate$/,
    needs: async () => ["useBots"],
  },
  {
    method: "POST",
    path: /^\/api\/host-access\/grants$/,
    needs: async () => ["localComputer"],
  },
  {
    method: "POST",
    path: /^\/api\/delivery\/(slack|teams)(\/.*)?$/,
    needs: async () => ["slackTeams"],
  },
  {
    method: ["POST", "PUT", "PATCH"],
    path: /^\/api\/approvals\/(preferences|rules)(\/.*)?$/,
    needs: async () => ["customRules"],
  },
  {
    method: "POST",
    path: /^\/api\/approvals\/[^/]+\/decision$/,
    needs: async (context) =>
      (await body(context)).decision === "allow_always" ? ["customRules"] : [],
  },
  {
    method: ["POST", "PUT", "PATCH"],
    path: /^\/api\/passwords(\/.*)?$/,
    needs: async () => ["passwordManager"],
  },
  {
    method: "POST",
    path: /^\/api\/computers\/[^/]+\/(control|human)\/(secret|sign-in)$/,
    needs: async () => ["passwordManager"],
  },
  {
    method: ["POST", "PUT", "PATCH"],
    path: /^\/api\/templates(\/.*)?\/(share|publish)$/,
    needs: async () => ["publicTemplateSharing"],
  },
];

function matches(rule: Rule, method: string, path: string) {
  const methods = Array.isArray(rule.method) ? rule.method : [rule.method];
  return methods.includes(method) && rule.path.test(path);
}

/** The serving model a run's stream names, if it names one: `"model":"..."` in any event. */
const MODEL_IN_STREAM = /"model"\s*:\s*"([^"]{1,200})"/;

export function createEnterpriseGate(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    const controls = enterpriseControls();
    const path = new URL(context.req.url).pathname;
    const method = context.req.method;
    const rule = controls
      ? GATED_ROUTES.find((candidate) => matches(candidate, method, path))
      : undefined;
    if (!controls || !rule) return next();

    let refused: Response | undefined;
    const authenticated = await requireUser(context, async () => {
      let needed: Capability[];
      try {
        needed = await rule.needs(context);
        for (const capability of needed) {
          if (
            !(await controls.capabilityFor(context.var.actor.id, capability))
          ) {
            refused = context.json(
              { error: capabilityRefusal(capability), capability },
              403,
            );
            return;
          }
        }
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "capability-check-failed",
            path,
            error: String(error),
          }),
        );
        refused = context.json(
          {
            error:
              "This deployment's enterprise controls could not be checked, so nothing was done.",
          },
          503,
        );
      }
    });
    // requireUser answered on its own: not signed in, or no role.
    if (authenticated instanceof Response) return authenticated;
    if (refused) return refused;

    const run = RUN.exec(path);
    if (run?.[2] === "run" && run[1])
      return governRun(context, next, decodeURIComponent(run[1]));
    return next();
  };
}

/**
 * The model allowlist, and one usage row per run with the model that served it.
 *
 * A built-in Bot runs on the deployment's configured model, so it is known before the run and a model
 * off the list refuses the run outright. A remote Bot chooses its own model; the stream is read as it
 * passes and the first model it names is recorded (`observed`), or `unknown` when it names none.
 */
async function governRun(
  context: Ctx,
  next: () => Promise<void>,
  agentId: string,
): Promise<Response | undefined> {
  const controls = enterpriseControls();
  if (!controls) {
    await next();
    return undefined;
  }
  const request = await body(context);
  const threadId =
    typeof request.threadId === "string" ? request.threadId : null;
  const runId = typeof request.runId === "string" ? request.runId : null;
  const actor = context.var.actor;

  let builtIn = false;
  try {
    const [row] = await controls.deps.database
      .select({ type: agents.type })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    builtIn = row?.type === "built_in";
  } catch {
    builtIn = false;
  }
  const allowlist = controls.snapshot()?.settings.modelAllowlist;
  const isAllowed = (model: string) =>
    !allowlist?.enabled || allowlist.models.includes(model);
  const configured = builtIn ? controls.deps.builtInModel : undefined;

  const record = (
    model: string,
    source: "configured" | "observed" | "unknown",
    allowed: boolean,
  ) =>
    controls.store
      .recordModelUsage({
        userId: actor.id,
        agentId,
        threadId,
        runId,
        model,
        source,
        allowed,
      })
      .catch((error) =>
        console.error(
          JSON.stringify({
            type: "model-usage-write-failed",
            error: String(error),
          }),
        ),
      );

  if (configured && !isAllowed(configured)) {
    await record(configured, "configured", false);
    await recordAuditEvent(controls.deps.auditStore, {
      eventType: "model.refused",
      targetType: "agent",
      targetId: agentId,
      actorUserId: actor.id,
      payload: { model: configured, source: "configured" },
    }).catch(() => undefined);
    return context.json(
      {
        error: `This Bot runs on ${configured}, which is not on this deployment's model allowlist. An administrator can add it.`,
      },
      403,
    );
  }

  await next();

  const response = context.res;
  if (!response.body || configured) {
    if (configured) await record(configured, "configured", true);
    return undefined;
  }

  // A remote Bot: read the model its stream names, without holding the stream back.
  const decoder = new TextDecoder();
  let seen = "";
  let found: string | undefined;
  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!found) {
        seen = (seen + decoder.decode(chunk, { stream: true })).slice(-8_192);
        found = MODEL_IN_STREAM.exec(seen)?.[1];
      }
      controller.enqueue(chunk);
    },
    flush() {
      const model = found ?? `remote:${agentId}`;
      const allowed = found ? isAllowed(found) : !allowlist?.enabled;
      void record(model, found ? "observed" : "unknown", allowed);
      if (!allowed) {
        void recordAuditEvent(controls.deps.auditStore, {
          eventType: "model.refused",
          targetType: "agent",
          targetId: agentId,
          actorUserId: actor.id,
          payload: {
            model,
            source: found ? "observed" : "unknown",
            note: "A remote Bot chooses its own model; this run was recorded against the allowlist after it streamed.",
          },
        }).catch(() => undefined);
      }
    },
  });
  context.res = new Response(response.body.pipeThrough(tap), response);
  return undefined;
}

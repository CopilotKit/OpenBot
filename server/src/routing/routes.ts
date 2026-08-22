import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { AgentProfileStore } from "../agents/profile-store";
import type { IntentRouter, RoutingCandidate } from "./classify";

const DEV_ACTOR_EMAIL = "dev@openbot.local";

/**
 * Who to record the routing against, or nobody.
 *
 * The single-user development actor is not a real person and has no row to point at, so it is left
 * off rather than written as a user id that resolves to nothing.
 */
function actorId(
  actor:
    | {
        id?: string;
        email?: string;
      }
    | null
    | undefined,
): string | undefined {
  return actor?.id && actor.email !== DEV_ACTOR_EMAIL ? actor.id : undefined;
}

/**
 * Decide which coworker a message is for, before a channel is pinned to one.
 *
 * The roster is read for the person asking, so this can only ever land on a coworker they are
 * already allowed to reach. The decision is recorded like every other one in the product: a
 * `channel.routed` row names where it went and why, and carries the candidate ids but never the
 * message itself, which the audit payload redaction would drop anyway.
 *
 * A person who named a coworker with `@` has already decided, so nothing is inferred and no model
 * is called. It is still recorded, with `viaMention` true and the person as the reason. Without
 * that the trail answered "why did this go to Risk Analyst" for routed conversations and said
 * nothing at all for chosen ones, which reads exactly like a row that failed to write.
 */
export function createRoutingRoutes(
  store: AgentProfileStore,
  router: IntentRouter,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  auditStore?: AuditStore,
  /**
   * Which systems a coworker can reach, for the router to weigh alongside what it is for.
   *
   * Optional, and absent leaves routing exactly as it was: a deployment with no connectors has
   * nothing to add here, and one that cannot answer the question should not have routing fail over
   * it. Asked per request rather than held, because a grant added a minute ago has to count.
   */
  reachableSystems?: (agentId: string) => Promise<readonly string[]>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /*
   * The one place a `channel.routed` row is written, for both ways a message finds a coworker.
   *
   * Two call sites writing the same event is two payloads that drift, and a trail whose rows mean
   * slightly different things depending on which branch produced them cannot be read at all.
   */
  async function record(
    actorUserId: string | undefined,
    chosen: string,
    reason: string,
    fallback: boolean,
    viaMention: boolean,
    candidates: readonly string[],
  ): Promise<void> {
    if (!auditStore) return;
    await recordAuditEvent(auditStore, {
      eventType: "channel.routed",
      targetType: "agent",
      targetId: chosen,
      ...(actorUserId ? { actorUserId } : {}),
      payload: { chosen, reason, fallback, viaMention, candidates },
    });
  }

  routes.post("/", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      text?: unknown;
      agentId?: unknown;
    } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return context.json({ error: "A message is required." }, 400);
    const named =
      typeof body?.agentId === "string" && body.agentId.trim()
        ? body.agentId.trim()
        : null;

    const actor = context.var.actor;
    const roster = await store.list(actor, false);
    // The same default the composer shows: the first public coworker, else the first at all.
    const preferred =
      roster.find((a) => a.visibility === "public") ?? roster[0];
    if (!preferred) {
      return context.json({ error: "No coworker is available." }, 409);
    }

    /*
     * A named coworker is an instruction, not a question, so it is honoured as given.
     *
     * Checked against the same roster the router picks from, so `@` cannot reach further than
     * routing can: a name that is not on it is refused rather than quietly turned into somebody
     * else, because silently redirecting a message the person addressed by hand is the worst
     * available answer.
     */
    if (named) {
      const chosen = roster.find((a) => a.id === named);
      if (!chosen) {
        return context.json(
          { error: "That coworker is not on your roster." },
          404,
        );
      }
      const reason = "you chose them yourself";
      await record(actorId(actor), chosen.id, reason, false, true, [chosen.id]);
      return context.json({
        agentId: chosen.id,
        name: chosen.name,
        reason,
        fallback: false,
        viaMention: true,
      });
    }
    const candidates: RoutingCandidate[] = await Promise.all(
      roster.map(async (a) => ({
        id: a.id,
        name: a.name,
        roleDescription: a.roleDescription,
        /*
         * Never allowed to break routing. A connector store that is slow or unhappy must not turn
         * "who is this for" into an error, so a failure here is the same as holding nothing: the
         * router falls back to matching on purpose alone, which is what it did before.
         */
        ...(reachableSystems
          ? {
              reaches: await reachableSystems(a.id).catch(
                () => [] as readonly string[],
              ),
            }
          : {}),
      })),
    );

    const decision = await router.route(text, candidates, preferred.id);

    await record(
      actorId(actor),
      decision.agentId,
      decision.reason,
      decision.fallback,
      false,
      candidates.map((c) => c.id),
    );

    return context.json({
      agentId: decision.agentId,
      name: decision.name,
      reason: decision.reason,
      fallback: decision.fallback,
      viaMention: false,
    });
  });

  return routes;
}

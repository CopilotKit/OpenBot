/**
 * Describing a network allowlist in English, and replaying one over the page visits on the trail.
 * Mounted at `/api/admin/enterprise/network`, in front of the enterprise routes that save it
 * (`PUT /network` in ./routes.ts), which is where the admin's Save goes, with the sentence.
 *
 * - `POST /translate`: `{ text }` in, `{ mode, rules, summary, reachable, explanation, check,
 *   warning }` out (./network-translate.ts). Every request that reaches the model is on the trail
 *   (`network_policy.translated`).
 * - `POST /replay`: `{ scopeKind, scopeId, mode, rules, locked, limit? }` in, `{ report }` out
 *   (./network-replay.ts). Writes nothing.
 *
 * Admin only, like the policy itself.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { type AuditReader, type AuditStore, recordAuditEvent } from "../audit";
import { type AppVariables, requireAdmin } from "../auth/guards";
import { parseEgressRules } from "../computer/policy-network";
import {
  PolicyTranslationError,
  TEXT_LIMIT,
} from "../computer/policy-translate";
import { type ModelCompleter, ModelNotConfiguredError } from "../routing/model";
import { enterpriseControls } from "./controls";
import {
  replayNetworkPolicy,
  VISIT_EVENT_TYPES,
  VISIT_TARGET_TYPE,
  visitingBots,
} from "./network-replay";
import { translateAllowlist } from "./network-translate";

/** Page visits replayed by default, and at most. */
const REPLAY_LIMIT = 500;
const REPLAY_MAX = 2_000;

const replayInput = z.strictObject({
  scopeKind: z.enum(["organization", "group"]),
  scopeId: z.string().trim().max(200).default(""),
  mode: z.enum(["allow_all", "defaults_plus_allowlist", "allowlist_only"]),
  rules: z.array(z.unknown()).max(5_000),
  locked: z.boolean().default(false),
  limit: z.number().int().min(1).max(REPLAY_MAX).optional(),
});

export function createNetworkAllowlistRoutes(options: {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  /** The deployment's own model, via `createModelCompleter`. Absent, `/translate` says one is needed. */
  complete?: ModelCompleter;
  auditStore?: AuditStore;
  auditReader?: AuditReader;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const adminOnly: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  };

  routes.post("/translate", options.requireUser, adminOnly, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      text?: unknown;
    } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text)
      return context.json(
        { error: "Describe where Bots may connect in a sentence first." },
        400,
      );
    if (text.length > TEXT_LIMIT)
      return context.json(
        { error: `Keep the description under ${TEXT_LIMIT} characters.` },
        400,
      );

    const actor = context.var.actor;
    const record = (payload: Record<string, unknown>) =>
      options.auditStore
        ? recordAuditEvent(options.auditStore, {
            eventType: "network_policy.translated",
            targetType: "network_policy",
            actorUserId: actor.id,
            payload: { actor: actor.email, text, ...payload },
          })
        : Promise.resolve();

    try {
      if (!options.complete) throw new ModelNotConfiguredError();
      const translation = await translateAllowlist({
        text,
        complete: options.complete,
        signal: context.req.raw.signal,
      });
      await record({
        outcome: translation.check.ok ? "written" : "did_not_parse",
        mode: translation.mode,
        rules: translation.rules,
        summary: translation.summary,
        reachable: translation.reachable,
        explanation: translation.explanation,
        warning: translation.warning,
        parsed: translation.check.ok,
        ...(translation.check.ok ? {} : { error: translation.check.error }),
        attempts: translation.attempts,
      });
      const { attempts: _attempts, ...answer } = translation;
      return context.json(answer);
    } catch (error) {
      if (error instanceof ModelNotConfiguredError) {
        await record({ outcome: "no_model" });
        return context.json(
          {
            error:
              "OpenBot needs a model key to write a list from a description. Add one on the Credentials page, or type the list yourself.",
          },
          503,
        );
      }
      if (error instanceof PolicyTranslationError) {
        await record({ outcome: "model_failed", error: error.message });
        return context.json({ error: error.message }, 502);
      }
      throw error;
    }
  });

  routes.post("/replay", options.requireUser, adminOnly, async (context) => {
    const parsed = replayInput.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      return context.json(
        {
          error:
            parsed.error.issues[0]?.path[0] === "limit"
              ? `limit must be a whole number between 1 and ${REPLAY_MAX}.`
              : "Send the policy as { scopeKind, scopeId, mode, rules, locked }.",
        },
        400,
      );
    // The parser the save and the computer use: a list the save would refuse is not replayed.
    const rules = parseEgressRules(parsed.data.rules);
    if (!rules.ok) return context.json({ error: rules.error }, 400);
    const candidate = {
      ...parsed.data,
      scopeId:
        parsed.data.scopeKind === "organization" ? "" : parsed.data.scopeId,
      rules: rules.rules,
    };
    if (candidate.scopeKind === "group" && !candidate.scopeId)
      return context.json({ error: "Name the group." }, 400);

    const controls = enterpriseControls();
    if (!controls)
      return context.json(
        { error: "Admin settings aren't available on this server." },
        503,
      );
    if (!options.auditReader)
      return context.json(
        {
          error:
            "This OpenBot records no readable trail, so there is no history to test against.",
        },
        501,
      );

    // Page visits only, newest first: the gateway's rows for `computer_navigate`.
    const { events } = await options.auditReader.list({
      limit: parsed.data.limit ?? REPLAY_LIMIT,
      eventType: VISIT_EVENT_TYPES.join(","),
      targetType: VISIT_TARGET_TYPE,
      intent: "navigate",
    });
    // One after another: see the note in controls.ts about concurrent statements on one connection.
    const rows = await controls.store.networkPolicies();
    const owners = new Map<
      string,
      NonNullable<Awaited<ReturnType<typeof controls.networkMemberFor>>>
    >();
    for (const bot of visitingBots(events)) {
      const owner = await controls.networkMemberFor(bot);
      if (owner) owners.set(bot, owner);
    }
    return context.json({
      report: replayNetworkPolicy({ candidate, rows, events, owners }),
    });
  });

  return routes;
}

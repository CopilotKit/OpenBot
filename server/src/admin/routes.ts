/**
 * `/api/admin/enterprise`: the screen behind Admin > Enterprise controls.
 *
 * Every write is administrator-only, validated, saved with a NOTIFY (see settings-store.ts) and put
 * on the audit trail with who made it. `GET /me` is the one read any signed-in person may make: the
 * capabilities that apply to them, so the app can hide what they may not use.
 */
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { recordAuditEvent } from "../audit";
import { type AppVariables, requireAdmin } from "../auth/guards";
import { scimStatus } from "../auth/scim";
import {
  hasIdentityProvider,
  revokeSessionsWithoutSso,
} from "../auth/sso-required";
import {
  DEFAULT_EGRESS_DESTINATIONS,
  parseEgressRules,
} from "../computer/policy-network";
import { mcpServers } from "../db/schema";
import { parsePageLimit } from "../paging";
import { otelConfigured } from "../telemetry/otel";
import {
  CAPABILITIES,
  CAPABILITY_LABELS,
  DEFAULT_CAPABILITIES,
  isCapability,
} from "./capabilities";
import { ACTION_RECORD_RETENTION_DAYS, enterpriseControls } from "./controls";
import type { EnterpriseSettings } from "./settings-store";

/**
 * Strict readers for the two paged enterprise GETs, matching the shared `parsePageLimit`
 * rule every other paged list follows: a run of digits is clamped into range, anything
 * else is a 400 naming the parameter rather than a silently coerced page.
 *
 * `GET /models/usage?days=` used `Number(raw) || 30`, so `?days=abc`, `?days=12abc`
 * and `?days=` all quietly returned the 30-day view, and `?days=3.9` averaged a
 * fractional window. `GET /actions?limit=` did the same with the 100-row default.
 * Exported pure so the 400 paths are unit-tested without standing up the controls.
 */
export const ENTERPRISE_DAYS_ERROR =
  'Query parameter "days" must be a positive integer.';

export function parseEnterpriseDays(
  raw: string | null,
): { ok: true; days: number } | { ok: false; error: string } {
  if (raw === null || raw.trim() === "") return { ok: true, days: 30 };
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed))
    return { ok: false, error: ENTERPRISE_DAYS_ERROR };
  return {
    ok: true,
    days: Math.min(Math.max(Number.parseInt(trimmed, 10), 1), 365),
  };
}

export function parseEnterpriseActionsLimit(
  raw: string | null,
): { ok: true; limit: number } | { ok: false; error: string } {
  const parsed = parsePageLimit(raw, 500);
  if (!parsed.ok) return parsed;
  return { ok: true, limit: parsed.limit ?? 100 };
}

const capabilityInput = z.strictObject({
  scopeKind: z.enum(["organization", "role", "group"]),
  scopeId: z.string().trim().max(200).default(""),
  capability: z.string(),
  allowed: z.boolean().nullable(),
});

const networkInput = z.strictObject({
  scopeKind: z.enum(["organization", "group"]),
  scopeId: z.string().trim().max(200).default(""),
  mode: z.enum(["allow_all", "defaults_plus_allowlist", "allowlist_only"]),
  rules: z.array(z.unknown()).max(5_000),
  locked: z.boolean().default(false),
});

const MODEL = z.string().trim().min(1).max(200);
const SERVER = z.string().trim().min(1).max(200);

const settingInputs: {
  [K in keyof EnterpriseSettings]: z.ZodType<EnterpriseSettings[K]>;
} = {
  ssoRequired: z.boolean(),
  actionRecording: z.boolean(),
  inactiveComputerDays: z.number().int().min(0).max(3650),
  modelAllowlist: z.strictObject({
    enabled: z.boolean(),
    models: z.array(MODEL).max(500),
  }),
  mcpAllowlist: z.strictObject({
    enabled: z.boolean(),
    servers: z.array(SERVER).max(500),
  }),
};

export function createEnterpriseAdminRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);

  const unavailable = (context: Context) =>
    context.json(
      { error: "Enterprise controls are not running on this server." },
      503,
    );

  routes.get("/me", async (context) => {
    const controls = enterpriseControls();
    if (!controls) {
      return context.json({
        capabilities: DEFAULT_CAPABILITIES,
        enforced: false,
      });
    }
    return context.json({
      capabilities: await controls.capabilitiesFor(context.var.actor.id),
      enforced: true,
    });
  });

  routes.use("*", async (context, next) => {
    if (new URL(context.req.url).pathname.endsWith("/me")) return next();
    const denied = requireAdmin(context);
    if (denied) return denied;
    return next();
  });

  routes.get("/", async (context) => {
    const controls = enterpriseControls();
    if (!controls) return unavailable(context);
    // Sequential: see the note in controls.ts about concurrent statements on one connection.
    const rows = await controls.store.capabilityRows();
    const settings = await controls.store.settings();
    const groups = await controls.store.groups();
    const network = await controls.store.networkPolicies();
    const servers = await controls.deps.database
      .select({
        id: mcpServers.id,
        title: mcpServers.title,
        url: mcpServers.url,
      })
      .from(mcpServers);
    return context.json({
      capabilities: CAPABILITIES.map((capability) => ({
        capability,
        ...CAPABILITY_LABELS[capability],
        default: DEFAULT_CAPABILITIES[capability],
        organization:
          rows.find(
            (row) =>
              row.scopeKind === "organization" && row.capability === capability,
          )?.allowed ?? null,
        roles: Object.fromEntries(
          rows
            .filter(
              (row) =>
                row.scopeKind === "role" && row.capability === capability,
            )
            .map((row) => [row.scopeId, row.allowed]),
        ),
        groups: Object.fromEntries(
          rows
            .filter(
              (row) =>
                row.scopeKind === "group" && row.capability === capability,
            )
            .map((row) => [row.scopeId, row.allowed]),
        ),
      })),
      settings,
      groups,
      network,
      defaultDestinations: DEFAULT_EGRESS_DESTINATIONS,
      mcpServers: servers,
      builtInModel: controls.deps.builtInModel ?? null,
      scim: scimStatus(controls.deps.env ?? process.env),
      otel: { configured: otelConfigured(controls.deps.env ?? process.env) },
      actionRecordRetentionDays: ACTION_RECORD_RETENTION_DAYS,
    });
  });

  routes.put("/capabilities", async (context) => {
    const controls = enterpriseControls();
    if (!controls) return unavailable(context);
    const parsed = capabilityInput.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success || !isCapability(parsed.data.capability)) {
      return context.json(
        { error: "Name a capability, a scope and true, false or null." },
        400,
      );
    }
    const input = parsed.data;
    if (input.scopeKind === "organization") input.scopeId = "";
    if (
      input.scopeKind === "role" &&
      !["admin", "user"].includes(input.scopeId)
    ) {
      return context.json({ error: 'A role is "admin" or "user".' }, 400);
    }
    if (input.scopeKind === "group" && !input.scopeId) {
      return context.json({ error: "Name the group." }, 400);
    }
    await controls.store.setCapability(input, context.var.actor.email);
    await controls.refresh();
    await recordAuditEvent(controls.deps.auditStore, {
      eventType: "capability.changed",
      targetType: "capability",
      targetId: input.capability,
      actorUserId: context.var.actor.id,
      payload: { ...input, by: context.var.actor.email },
    });
    return context.json({ saved: input });
  });

  routes.put("/settings/:key", async (context) => {
    const controls = enterpriseControls();
    if (!controls) return unavailable(context);
    const key = context.req.param("key") as keyof EnterpriseSettings;
    const schema = settingInputs[key];
    if (!schema) return context.json({ error: "Unknown setting." }, 400);
    const raw = (await context.req.json().catch(() => null)) as {
      value?: unknown;
    } | null;
    const parsed = schema.safeParse(raw?.value);
    if (!parsed.success) {
      return context.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid value." },
        400,
      );
    }
    // Requiring SSO with nothing to sign in through leaves only the break-glass addresses able to.
    if (
      key === "ssoRequired" &&
      parsed.data === true &&
      !(await hasIdentityProvider(controls.deps.database))
    )
      return context.json(
        {
          error:
            "Register an identity provider before requiring SSO, or nobody but the break-glass administrators can sign in.",
        },
        409,
      );
    const before = (await controls.store.settings())[key];
    await controls.store.setSetting(
      key,
      parsed.data as never,
      context.var.actor.email,
    );
    await controls.refresh();
    await recordAuditEvent(controls.deps.auditStore, {
      eventType: "enterprise.setting_changed",
      targetType: "enterprise_setting",
      targetId: key,
      actorUserId: context.var.actor.id,
      payload: {
        setting: key,
        before,
        after: parsed.data,
        by: context.var.actor.email,
      },
    });
    // Sign-in is checked only when a session is made, so turning SSO-required on must end the
    // sessions made before it, or everyone already signed in another way stays in. Every time it is
    // saved on, not only on the change: a failed attempt is then put right by saving again.
    if (key === "ssoRequired" && parsed.data === true) {
      const ended = await revokeSessionsWithoutSso(
        controls.deps.database,
        controls.deps.initialAdminEmails ?? [],
        context.var.actor.id,
      );
      await recordAuditEvent(controls.deps.auditStore, {
        eventType: "auth.sessions_revoked",
        targetType: "enterprise_setting",
        targetId: key,
        actorUserId: context.var.actor.id,
        payload: { reason: "sso_required", ended },
      });
    }
    return context.json({ key, value: parsed.data });
  });

  routes.put("/network", async (context) => {
    const controls = enterpriseControls();
    if (!controls) return unavailable(context);
    const parsed = networkInput.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid policy." },
        400,
      );
    }
    const rules = parseEgressRules(parsed.data.rules);
    if (!rules.ok) return context.json({ error: rules.error }, 400);
    const input = {
      ...parsed.data,
      scopeId:
        parsed.data.scopeKind === "organization" ? "" : parsed.data.scopeId,
      rules: rules.rules,
    };
    if (input.scopeKind === "group" && !input.scopeId) {
      return context.json({ error: "Name the group." }, 400);
    }
    await controls.store.setNetworkPolicy(input, context.var.actor.email);
    await controls.refresh();
    void controls.pushNetworkPolicies();
    await recordAuditEvent(controls.deps.auditStore, {
      eventType: "network_policy.changed",
      targetType: "network_policy",
      targetId:
        input.scopeKind === "group" ? `group:${input.scopeId}` : "organization",
      actorUserId: context.var.actor.id,
      payload: {
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        mode: input.mode,
        locked: input.locked,
        ruleCount: input.rules.length,
        rules: input.rules,
        by: context.var.actor.email,
      },
    });
    return context.json({ saved: input });
  });

  routes.delete("/network/:scopeKind", async (context) => {
    const controls = enterpriseControls();
    if (!controls) return unavailable(context);
    const scopeKind = context.req.param("scopeKind");
    if (scopeKind !== "organization" && scopeKind !== "group") {
      return context.json({ error: "organization or group." }, 400);
    }
    const scopeId =
      scopeKind === "group" ? (context.req.query("group") ?? "") : "";
    const removed = await controls.store.removeNetworkPolicy(
      scopeKind,
      scopeId,
    );
    await controls.refresh();
    void controls.pushNetworkPolicies();
    await recordAuditEvent(controls.deps.auditStore, {
      eventType: "network_policy.removed",
      targetType: "network_policy",
      targetId: scopeKind === "group" ? `group:${scopeId}` : "organization",
      actorUserId: context.var.actor.id,
      payload: { scopeKind, scopeId, removed, by: context.var.actor.email },
    });
    return context.json({ removed });
  });

  routes.get("/models/usage", async (context) => {
    const controls = enterpriseControls();
    if (!controls) return unavailable(context);
    const parsedDays = parseEnterpriseDays(context.req.query("days") ?? null);
    if (!parsedDays.ok) {
      return context.json({ error: parsedDays.error }, 400);
    }
    const days = parsedDays.days;
    const summary = await controls.store.modelUsageSummary(days);
    const recent = await controls.store.recentModelUsage(50);
    const emails = await controls.store.usersById([
      ...new Set(recent.flatMap((row) => (row.userId ? [row.userId] : []))),
    ]);
    return context.json({
      days,
      summary,
      recent: recent.map((row) => ({
        ...row,
        email: row.userId ? (emails.get(row.userId) ?? null) : null,
      })),
    });
  });

  routes.get("/actions", async (context) => {
    const controls = enterpriseControls();
    if (!controls) return unavailable(context);
    const parsedLimit = parseEnterpriseActionsLimit(
      context.req.query("limit") ?? null,
    );
    if (!parsedLimit.ok) {
      return context.json({ error: parsedLimit.error }, 400);
    }
    return context.json({
      actions: await controls.store.actions(parsedLimit.limit),
    });
  });

  routes.post("/people/:userId/terminate-computers", async (context) => {
    const controls = enterpriseControls();
    if (!controls) return unavailable(context);
    const result = await controls.terminateMemberComputers(
      context.req.param("userId"),
      {
        id: context.var.actor.id,
        email: context.var.actor.email,
      },
    );
    return context.json(result);
  });

  routes.post("/computers/terminate-inactive", async (context) => {
    const controls = enterpriseControls();
    if (!controls) return unavailable(context);
    const result = await controls.terminateInactiveComputers();
    return context.json(
      result ?? {
        stopped: [],
        skipped: "another server is sweeping, or the sweep is off",
      },
    );
  });

  return routes;
}

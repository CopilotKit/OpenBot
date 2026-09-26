/**
 * The phone-companion routes: pair, check in, watch.
 *
 * Mounted under /api/plugins/companion, beside the plugin surface it lives off.
 *
 * Who may call what:
 * - `pair` is an administrator's, because it opens a Bot's screen to a phone.
 * - `checkin` is deliberately open: the phone has no session and the code IS the credential. A
 *   wrong or spent code answers the same refusal, so the endpoint cannot be used to discover
 *   which codes exist.
 * - `status` is any signed-in person who may act as the Bot, same as every other Bot read.
 * - `activity` is the phone's: it names the phoneId it paired with, and a mismatching id is a 404
 *   rather than a 403, so a probe cannot learn that a Bot is paired at all.
 *
 * Nothing here writes on the phone's behalf. The activity payload surfaces the Bot's pending
 * approvals and points at the existing approval conversation; deciding still happens there.
 */

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { BotAccessCheck } from "../agents/profile-policy";
import type { AuditReader } from "../audit";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import type { CompanionStore } from "./store";

/** How far back the activity card reaches, when the phone does not say. */
const DEFAULT_ACTIVITY_WINDOW_MS = 2 * 60 * 60 * 1000;

/** The hard ceiling, so a phone cannot ask for the whole trail. */
const MAX_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How many rows of each kind the card carries. It is a card, not a transcript. */
const CARD_LIMIT = 20;

/**
 * A phone-sized line for one audit event: what, where, and whether it was allowed.
 *
 * Only fields the card draws. The audit payload is already redacted on the way in, but a phone
 * reading over someone's shoulder wants even less than the Admin page shows.
 */
function cardLine(event: {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}) {
  return {
    at: event.createdAt,
    kind: event.eventType,
    // `action` on computer events, `tool` on tool calls: the thing that was done or asked for.
    what: String(event.payload.action ?? event.payload.tool ?? event.eventType),
    page: typeof event.payload.page === "string" ? event.payload.page : undefined,
    ok: event.eventType.endsWith("refused")
      ? false
      : event.eventType.endsWith("failed")
        ? false
        : true,
  };
}

export function createCompanionRoutes(
  store: CompanionStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  canUseBot: BotAccessCheck,
  /** The trail the card is drawn from. Absent leaves pairing working and the card empty. */
  auditReader?: AuditReader,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /** Mint a code for one Bot. Administrator's: this is the door a phone walks through. */
  routes.post("/pair", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const body = (await context.req.json().catch(() => null)) as {
      agentId?: string;
    } | null;
    const agentId = body?.agentId?.trim();
    if (!agentId) {
      return context.json({ error: "An agentId is required." }, 400);
    }
    if (!(await canUseBot(context.var.actor, agentId))) {
      // The same answer as a Bot that does not exist, so this cannot be used to enumerate them.
      return context.json({ error: "There is no such Bot." }, 404);
    }

    const code = await store.mint(agentId);
    // The TTL travels with the code so the screen showing it can count down honestly.
    return context.json({ code, agentId, ttlSeconds: 600 });
  });

  /**
   * The phone's one open endpoint: spend a code, become the Bot's companion.
   *
   * The code spends exactly once. After that the phone's heartbeat is the activity
   * read, which bumps lastSeen; presenting a spent code here is a refusal.
   */
  routes.post("/checkin", async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      code?: string;
      phoneId?: string;
    } | null;
    if (!body?.code || !body?.phoneId?.trim()) {
      return context.json(
        { error: "A code and a phoneId are both required." },
        400,
      );
    }
    const phoneId = body.phoneId.trim();

    const outcome = await store.exchange(body.code, phoneId);
    if (!outcome.ok) {
      // The three refusals a phone can act on, without saying which codes exist.
      const message =
        outcome.refusal === "expired"
          ? "That code has expired. Ask for a new one."
          : outcome.refusal === "malformed"
            ? "That code is not a pairing code."
            : "That code is not valid. Ask for a new one.";
      return context.json({ error: message }, 403);
    }

    return context.json({ paired: true, agentId: outcome.agentId });
  });

  /** Whether a phone is paired to this Bot, and when it last said so. */
  routes.get("/status/:agentId", requireUser, async (context) => {
    const agentId = context.req.param("agentId");
    if (!(await canUseBot(context.var.actor, agentId))) {
      return context.json({ error: "There is no such Bot." }, 404);
    }
    const binding = await store.binding(agentId);
    return context.json({
      paired: binding !== undefined,
      phoneId: binding?.phoneId,
      pairedAt: binding?.pairedAt ?? null,
      lastSeenAt: binding?.lastSeenAt ?? null,
    });
  });

  /**
   * The card: what this Bot has been doing, phone-sized and read-only.
   *
   * The caller proves it is the paired phone with `phoneId` (query or header); anything else is a
   * 404, because "which Bots have companions" is not a fact this endpoint gives away. A successful
   * read bumps lastSeen, so a phone polling the card needs no separate heartbeat.
   */
  routes.get("/activity/:agentId", async (context) => {
    const agentId = context.req.param("agentId");
    const phoneId = (
      context.req.header("x-companion-phone") ??
      context.req.query("phoneId") ??
      ""
    ).trim();

    const binding = await store.binding(agentId);
    // Same 404 for unpaired, wrong phone and unknown Bot alike.
    if (!binding || binding.phoneId !== phoneId) {
      return context.json({ error: "There is no such Bot." }, 404);
    }
    await store.touch(agentId, phoneId);

    if (!auditReader) {
      return context.json({
        agentId,
        since: null,
        lastAction: null,
        currentPage: null,
        recentActions: [],
        pendingApprovals: [],
      });
    }

    const sinceParam = Number(context.req.query("since"));
    const defaultFrom = Date.now() - DEFAULT_ACTIVITY_WINDOW_MS;
    // Clamped to the ceiling, so a phone cannot ask for the whole trail.
    const from = new Date(
      Number.isFinite(sinceParam) && sinceParam > 0
        ? Math.max(sinceParam, Date.now() - MAX_ACTIVITY_WINDOW_MS)
        : defaultFrom,
    ).toISOString();

    // What the Bot did on its computer. Targeted by Bot, so nothing else's rows come back.
    const computer = await auditReader.list({
      targetType: "computer",
      targetId: agentId,
      from,
      limit: CARD_LIMIT,
    });

    // Tool calls and the approvals they asked for. These are keyed by tool rather than Bot, so the
    // Bot is filtered here in code — the card only ever carries this Bot's calls.
    const tools = await auditReader.list({
      eventType:
        "mcp.call_succeeded,mcp.call_failed,mcp.call_rejected,approval.escalated",
      from,
      limit: 200,
    });
    const own = tools.events.filter(
      (event) => event.payload.bot === agentId,
    );

    // The page the Bot is on: the newest computer event that named one.
    const currentPage = [
      ...computer.events,
      ...own.filter((event) => typeof event.payload.page === "string"),
    ]
      .filter((event) => typeof event.payload.page === "string")
      .sort(
        (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
      )[0];

    // Approvals waiting on a person. An escalation with nothing after it that succeeded is still
    // waiting; the conversation that settles it does not write a row, so recency is the signal.
    const pendingApprovals = own
      .filter((event) => event.eventType === "approval.escalated")
      .slice(0, CARD_LIMIT)
      .map((event) => ({
        at: event.createdAt,
        // The call the Bot wanted to make and why it stopped.
        tool: String(event.payload.tool ?? event.payload.server ?? "a tool"),
        ref: typeof event.payload.ref === "string" ? event.payload.ref : null,
        reason:
          typeof event.payload.reason === "string"
            ? event.payload.reason
            : "This Bot's approval level requires a person to agree first.",
      }));

    const recent = [
      ...computer.events.map(cardLine),
      ...own
        .filter((event) => event.eventType !== "approval.escalated")
        .map(cardLine),
    ]
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, CARD_LIMIT);

    return context.json({
      agentId,
      since: from,
      lastAction: recent[0] ?? null,
      currentPage: currentPage
        ? { page: currentPage.payload.page, at: currentPage.createdAt }
        : null,
      recentActions: recent,
      pendingApprovals,
    });
  });

  return routes;
}

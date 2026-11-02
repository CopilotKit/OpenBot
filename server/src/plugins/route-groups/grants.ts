import { PERSON_INITIATOR } from "../../audit";
import type { AppVariables } from "../../auth/guards";
import { approveOwnersSharedUse, ownerGrantRefusal } from "../owner-grants";
import {
  asSharedUseApproval,
  exposureOf,
  type SharedUseApproval,
} from "../shared-use";
import {
  CatalogueEntryUnknownError,
  isDeploymentFault,
  type PluginKind,
  PluginRefusedError,
} from "../store";
import type { PluginRouteContext } from "./context";

/**
 * What a grant of one MCP tool must record beside it: the approval for who may use a Shared app's
 * one account through this Bot.
 *
 * Without an approval the gate refuses every call the grant just allowed, so a grant with none sent
 * approves the Bot's exposure as it stands now — unless an approval is already recorded, which is
 * an administrator's earlier decision and not this grant's to widen (one an owner's grant set is not
 * that, and is replaced). "Is Shared" is the app's
 * answer (its answering row), never the granted row's own column. Null `approval` is nothing to
 * record; `unreadable` is an approval sent that this deployment cannot read, which the caller
 * refuses.
 *
 * A FUNCTION RATHER THAN LINES IN THE ROUTE because approving an access request grants through the
 * same rule, and a Shared app granted from the request inbox must land with the same approval it
 * would have had from the grant switch.
 */
export async function sharedGrantApproval(
  { store, shared }: Pick<PluginRouteContext, "store" | "shared">,
  ref: string,
  agentId: string,
  sent: unknown,
): Promise<
  { appId: string; approval: SharedUseApproval | null } | "unreadable"
> {
  if (!shared) return { appId: "", approval: null };
  const [serverId] = ref.split("/");
  const appId = await shared.use.appIdOf(serverId ?? "");
  if ((await store.serverAddress(appId))?.accountMode !== "shared")
    return { appId, approval: null };
  if (sent !== undefined) {
    const approval = asSharedUseApproval(sent);
    return approval ? { appId, approval } : "unreadable";
  }
  /*
   * An audience an owner's grant set is not an administrator's decision, so an administrator
   * granting over it approves the Bot's exposure now, which makes the audience theirs.
   */
  if ((await shared.use.approvalSource(agentId, appId)) === "admin")
    return { appId, approval: null };
  return {
    appId,
    approval: exposureOf(await shared.use.botFacts(agentId)),
  };
}

/** Granting and revoking a server, skill or Bot, and a Bot's tool calls back. */
export function mountGrantRoutes({
  routes,
  store,
  requireUser,
  canUseBot,
  shared,
  composio,
  actorEmail,
  skillActor,
}: PluginRouteContext) {
  /**
   * Grant and revoke, for both kinds, through one pair of endpoints.
   *
   * The store keeps one grant table because the question is the same either way; the API says the
   * same thing, so a reader is never left wondering whether skills are governed differently.
   */

  /**
   * The kinds of grant this API will act on.
   *
   * CHECKED AT RUNTIME, not only in the types. `kind` arrives in a JSON body, so a type annotation
   * on it is a comment: before this, anything at all could be written into the grant table through
   * the ordinary endpoint, and one kind that was never meant to be settable this way already could.
   */
  const GRANT_KINDS = new Set<PluginKind>(["mcp", "skill", "bot"]);
  const asGrantKind = (value: unknown): PluginKind | null =>
    typeof value === "string" && GRANT_KINDS.has(value as PluginKind)
      ? (value as PluginKind)
      : null;

  /**
   * May this Bot's owner, who is not an administrator, give it this one action of an app?
   *
   * The Bot is asked about first, so somebody who does not own it learns nothing about the app from
   * the answer. The ref has to name a row that is the app, not merely a word an app answers to.
   */
  async function ownerMcpRefusal(
    context: { var: AppVariables },
    ref: string,
    agentId: string,
  ): Promise<string | null> {
    const actorId = context.var.actor.id;
    if (
      !(await store.agentIsRegistered(agentId)) ||
      (await store.agentOwner(agentId)) !== actorId
    )
      return "Only an admin can choose which Bots use a tool.";
    const [serverId] = ref.split("/");
    const inspected = serverId
      ? await store.inspectApp({
          app: serverId,
          agentId,
          userId: actorId,
          composioConfigured: Boolean(composio),
        })
      : null;
    if (!inspected?.rowIds.includes(serverId ?? ""))
      return `${serverId} hasn't been added yet. Only an admin can add it.`;
    const refusal = await ownerGrantRefusal(store, actorId, agentId, inspected);
    if (refusal) return refusal;
    /*
     * AN ACTION THE APP ADVERTISES NOW, NOT ANY WORD AFTER THE SLASH. An administrator may grant a
     * tool a server has stopped listing, to restore it (see `enablementRefusal`). An owner may not:
     * a ref naming nothing would sit there until the vendor shipped an action by that name, and the
     * Bot would then hold it with nobody having chosen it — and a bare server ref would mark the app
     * given without giving it a single action.
     */
    if (
      !(await store.appTools(serverId ?? "")).some((tool) => tool.ref === ref)
    )
      return `${inspected.access.displayName} doesn't have that action.`;
    return null;
  }

  /**
   * May this person put this on that Bot?
   *
   * MCP is an administrator's, except one of the owner's own apps on their own Bot (see
   * {@link ownerMcpRefusal}): it reaches another company's system with a stored credential.
   * A skill is an instruction, so somebody may put their own skill on a Bot they own, and neither
   * half alone is enough. Both are checked here rather than in the store, because this is the only
   * place that knows who is asking.
   */
  async function enablementRefusal(
    context: { var: AppVariables },
    kind: PluginKind,
    ref: string,
    agentId: string,
    /**
     * Which way this is going, because they are not symmetric.
     *
     * TAKING SOMETHING AWAY IS ALWAYS ALLOWED. The checks below decide whether a grant should exist,
     * and applying them to a revoke turns every one of them into a trap: a `bot` grant made before
     * the grantee moved to its own endpoint — or before this check existed — could never be removed,
     * because the reason it is wrong is the same reason the revoke was refused. An administrator
     * looking at a dead row in the UI would have had no way to delete it.
     */
    intent: "grant" | "revoke",
  ): Promise<string | null> {
    const actor = skillActor(context);

    if (kind === "mcp") {
      if (!actor.isAdmin) {
        /*
         * A BOT'S OWNER MAY GIVE IT ONE OF THEIR OWN APPS, and nothing else changes for anybody who
         * is not an administrator. The owner rule — their Bot, an app an administrator switched on
         * and opened to owners, the `ownerApps` capability — is {@link ownerGrantRefusal}'s, the
         * same one the card's one press asks. The grant this allows is written `granted_as = owner`
         * by the route below, which is what keeps it on the asker's own account.
         *
         * TAKING AWAY IS NOT RELAXED HERE. An owner takes back what they gave through
         * `DELETE /for/:agentId/apps/:app/give`, which removes only the owner's own grants; this
         * route's revoke would remove an administrator's as readily, so it stays theirs.
         */
        if (intent === "revoke")
          return "Only an admin can choose which Bots use a tool.";
        return ownerMcpRefusal(context, ref, agentId);
      }
      // Taking something away is always allowed: see the note on `intent`. It matters more here
      // than anywhere else, because the rows this check exists to prevent are the same shape as the
      // rows #572's migration had to delete, and an administrator has to be able to remove one by
      // hand rather than wait for a migration.
      if (intent === "revoke") return null;

      /*
       * A grant that could never do anything is refused rather than stored, which is the rule the
       * `bot` branch below already states and this one did not follow.
       *
       * Nothing checked that the app existed. `store.grant` is a bare upsert, so a ref naming an
       * app this deployment has not added was stored and then invisible: the surface that reports a
       * grant nothing advertises is built per server row, and there was no row. #572 fixed the way
       * these rows were MADE — a removal used to leave its grants behind — and added the migration
       * that deleted the ones already there. This is the other door into the same room. Add the app
       * afterwards and the id is the same, the action names are the same, and every one of those
       * grants resolves, with nobody having granted anything and no row in the trail saying so.
       *
       * THE SERVER HALF ONLY. A grant naming a tool the server has stopped advertising is a
       * supported state, held and not offered, because what a vendor lists today is not what
       * somebody decided yesterday — checking the tool here would refuse a re-grant of exactly the
       * tool an administrator is trying to restore. A grant naming no app at all is not that state.
       */
      const [serverId] = ref.split("/");
      if (!(await store.serverExists(serverId ?? ""))) {
        return `${serverId} hasn't been added yet. Add it first, then give its tools to a Bot.`;
      }
      /*
       * The Bot has to exist as well, which the `bot` branch below already says in the same words.
       * `plugin_grants.agent_id` is a foreign key, so a grant naming a Bot nobody has reached the
       * insert and failed there, and a person's mistyped Bot id answered 500 with no body where
       * every other refusal on this route is a 403 with a sentence.
       */
      if (!(await store.agentIsRegistered(agentId)))
        return "There is no such Bot.";
      return null;
    }

    if (kind === "bot") {
      /*
       * THE ROLE IS CHECKED BEFORE ANYTHING IS LOOKED UP, and that ordering is the point.
       *
       * One Bot reaching another lets it spend that Bot's model calls, wake its computer and reach
       * whatever it may reach, so it is an administrator's decision rather than something somebody
       * attaches to a coworker they own. But this route only requires a signed-in user, so every
       * refusal below is readable by anybody: checking whether the Bot exists, and whether it runs
       * here, before this line handed out three distinguishable answers and turned a 403 into an
       * oracle for other people's private Bots. `handoff.ts` in this same feature collapses exactly
       * this, deliberately, and this had it backwards.
       */
      if (!actor.isAdmin) {
        return "Only an admin can choose which Bots hand work to another Bot.";
      }
      // Taking something away is always allowed: see the note on `intent`.
      if (intent === "revoke") return null;

      /*
       * A grant that could never do anything is refused rather than stored, from both ends.
       *
       * The GRANTEE must exist. Remote Bots execute through the same signed callback and handoff
       * desk as built-in Bots, so where their model loop runs does not change the grant.
       *
       * The TARGET only has to exist. Being handed work is not the same as being able to hand it on,
       * so a target at its own endpoint is perfectly ordinary — but `ref` is bare text with no
       * foreign key, so a typo stored happily and every hop then refused as not-granted.
       */
      /*
       * A Bot cannot be granted itself. The desk refuses a self-hop outright — "a Bot cannot hand
       * work to itself" — so the row is dead the moment it is written, and reads as configured.
       */
      if (ref === agentId) {
        return "A Bot cannot be granted itself to hand work to.";
      }
      if (!(await store.agentIsRegistered(agentId)))
        return "There is no such Bot.";
      if (!(await store.agentIsRegistered(ref))) {
        return `There is no Bot called ${ref} to hand work to.`;
      }
      return null;
    }

    if (actor.isAdmin) {
      // Taking something away is always allowed: see the note on `intent`.
      if (intent === "revoke") return null;
      /*
       * A grant naming no skill is refused for an administrator too, as the `mcp` branch refuses a
       * grant naming no app. `store.grant` is a bare upsert and a Bot's skills are read by slug
       * alone, so the row sat there granting nothing until somebody wrote a skill under that name,
       * and then that skill was on this Bot with nobody having put it there. On a Bot the
       * deployment shares, that is one person's instructions answering everybody:
       * `skill-uninstall-grants.integration.test.ts` guards the same room from the uninstall side.
       */
      if ((await store.skillOwner(ref)) === undefined) {
        return `There is no skill called ${ref}.`;
      }
      // And the Bot, for the reason the `mcp` branch gives: an administrator's grant naming one
      // nobody has failed on the foreign key. Everybody else is asked below, through `agentOwner`.
      if (!(await store.agentIsRegistered(agentId)))
        return "There is no such Bot.";
      return null;
    }

    const owner = await store.skillOwner(ref);
    if (owner === undefined) return `There is no skill called ${ref}.`;
    if (owner !== actor.id) {
      return owner === null
        ? `${ref} belongs to everyone. Only an admin can choose which Bots use it.`
        : `${ref} is somebody else's skill.`;
    }

    const botOwner = await store.agentOwner(agentId);
    if (botOwner === undefined) return "There is no such Bot.";
    if (botOwner !== actor.id) {
      // Including the shared Bots this deployment publishes, which have no owner at all: a skill
      // one person wrote would otherwise change how a Bot answers everybody.
      return "You can only put your own skills on Bots you own.";
    }
    return null;
  }

  routes.post("/grants", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      kind?: unknown;
      ref?: string;
      agentId?: string;
      approval?: unknown;
    } | null;
    const kind = asGrantKind(body?.kind);
    /*
     * The body is JSON, so the annotation is a wish: `{"ref":123,"agentId":[]}` passes a
     * truthiness check and then reaches the store, where Drizzle compares a text column against
     * a number and the request answers 500. A ref and a Bot id are non-empty strings here.
     */
    if (
      !kind ||
      typeof body?.ref !== "string" ||
      !body.ref.trim() ||
      typeof body.agentId !== "string" ||
      !body.agentId.trim()
    ) {
      return context.json(
        { error: "A kind, a ref and a Bot are required." },
        400,
      );
    }
    /*
     * Trimmed before it is checked and before it is stored, the way the DELETE twin below already
     * does. Without this a padded ref refuses with the padding quoted back (`" app" is not an app`),
     * and a grant that did pass would be stored under a ref no revoke could match.
     */
    const grantRef = body.ref.trim();
    const grantAgentId = body.agentId.trim();
    const refusal = await enablementRefusal(
      context,
      kind,
      grantRef,
      grantAgentId,
      "grant",
    );
    if (refusal) return context.json({ error: refusal }, 403);

    /*
     * A SHARED APP'S ACTION IS GRANTED WITH WHO MAY USE IT, in the one request. See
     * {@link sharedGrantApproval} for what is recorded when none is sent.
     */
    /*
     * An owner's grant sends no approval of its own. Where the app is Shared and an administrator
     * lets owners decide, the grant sets the audience itself, below; see `approveOwnersSharedUse`.
     */
    const asOwner = kind === "mcp" && !skillActor(context).isAdmin;
    const decided =
      kind === "mcp" && !asOwner
        ? await sharedGrantApproval(
            { store, shared },
            grantRef,
            grantAgentId,
            body?.approval,
          )
        : null;
    if (decided === "unreadable") {
      return context.json(
        { error: "That approval is not one this deployment can read." },
        400,
      );
    }
    await store.grant(
      kind,
      grantRef,
      grantAgentId,
      actorEmail(context),
      asOwner ? "owner" : "admin",
    );
    if (decided?.approval && shared) {
      await shared.use.setApproval({
        botId: grantAgentId,
        serverId: decided.appId,
        approval: decided.approval,
        by: context.var.actor.id,
      });
    }
    if (asOwner && shared)
      await approveOwnersSharedUse(store, shared.use, {
        botId: grantAgentId,
        serverId: grantRef.split("/")[0] ?? "",
        ownerId: context.var.actor.id,
      });
    return context.json({ ok: true });
  });

  routes.delete("/grants", requireUser, async (context) => {
    const kind = asGrantKind(context.req.query("kind"));
    const ref = context.req.query("ref");
    const agentId = context.req.query("agentId");
    /*
     * Query params are always strings, so truthiness is not enough: `"   "` is truthy and used
     * to pass this check, delete zero rows by exact match, still write a `plugin_revoked` audit
     * row naming whitespace, and answer `ok:true`. The POST twin already requires non-empty
     * strings; this requires the same and acts on the trimmed values.
     */
    if (
      !kind ||
      typeof ref !== "string" ||
      !ref.trim() ||
      typeof agentId !== "string" ||
      !agentId.trim()
    ) {
      return context.json(
        { error: "A kind, a ref and a Bot are required." },
        400,
      );
    }
    const trimmedRef = ref.trim();
    const trimmedAgentId = agentId.trim();
    const refusal = await enablementRefusal(
      context,
      kind,
      trimmedRef,
      trimmedAgentId,
      "revoke",
    );
    if (refusal) return context.json({ error: refusal }, 403);

    await store.revoke(kind, trimmedRef, trimmedAgentId, actorEmail(context));
    return context.json({ ok: true });
  });

  /** What one Bot holds. The runtime reads this to decide what to offer a model. */
  routes.get("/for/:agentId", requireUser, async (context) => {
    const agentId = context.req.param("agentId");
    // A grant list is a fact about the Bot it belongs to. Left open it says which tools somebody
    // else's private coworker has been given.
    if (!(await canUseBot(context.var.actor, agentId))) {
      return context.json({ error: "There is no such Bot." }, 404);
    }
    return context.json(await store.listForAgent(agentId));
  });

  /**
   * Call a tool, as a Bot.
   *
   * The grant, the policy and the audit row all happen inside the store, so this endpoint cannot
   * accidentally satisfy one of them and skip another. A refusal comes back as 403 with the reason
   * the model and the person are both shown, which is the same sentence written to the trail.
   *
   * NOTHING IN THIS REPOSITORY CALLS IT. It is what the browser used to post to when a Bot's tool
   * loop ran client-side; that loop moved to the server, and the client helper for this went with it.
   * Kept rather than removed, because #37 hardened it with `canUseBot` after that move — so removing
   * it belongs in a change that says so, not in a merge resolution.
   */
  routes.post("/call", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      ref?: string;
      args?: Record<string, unknown>;
      agentId?: string;
    } | null;
    // Same shape lie as `/grants` above: JSON numbers, objects and arrays are truthy, so they
    // must be refused here rather than inside `canUseBot` or the tool call.
    if (
      typeof body?.ref !== "string" ||
      !body.ref.trim() ||
      typeof body.agentId !== "string" ||
      !body.agentId.trim()
    ) {
      return context.json({ error: "A tool and a Bot are required." }, 400);
    }
    // `args` reaches `Object.entries` inside the store, where a string fans out into indexed
    // entries, a number becomes no entries, and an array passes as an object — all escaping as
    // a vendor 502 instead of a 400 for a malformed call.
    if (
      body.args !== undefined &&
      (typeof body.args !== "object" ||
        body.args === null ||
        Array.isArray(body.args) ||
        Object.getPrototypeOf(body.args) !== Object.prototype)
    ) {
      return context.json({ error: "Tool arguments must be an object." }, 400);
    }

    // Asked before the grant is looked up, and before anything reaches a vendor. The grant says this
    // Bot may use the tool; it says nothing about whether this person may act as this Bot, and the
    // call goes out on the deployment's own credential either way.
    if (!(await canUseBot(context.var.actor, body.agentId))) {
      return context.json({ error: "There is no such Bot." }, 404);
    }

    try {
      const result = await store.callTool({
        ref: body.ref,
        args: body.args ?? {},
        botId: body.agentId,
        /*
         * The user id, not the address.
         *
         * `callTool` keys a per-person connection on `users.id`, so an address here finds nothing and
         * every call through this route would be answered "you have not connected your account" —
         * about a connector the person has connected. It never surfaced because a Bot's own tool loop
         * runs on the server and does not come through here.
         *
         * The other uses of `actorEmail` in this file are `by:` on configuration changes, where an
         * address is the useful thing to record. This one is an identity being resolved, not a name
         * being written down, and the two are not interchangeable.
         */
        actorId: context.var.actor.id,
        // A signed-in person calling the tool themselves: say so, because a shared account refuses a
        // call that does not say what started it.
        initiator: PERSON_INITIATOR,
      });
      return context.json(result);
    } catch (error) {
      if (error instanceof PluginRefusedError) {
        return context.json({ error: error.message, rule: error.rule }, 403);
      }
      if (error instanceof CatalogueEntryUnknownError) {
        return context.json({ error: error.message }, 404);
      }
      /*
       * Ours, and so neither the vendor's fault nor this caller's business.
       *
       * CRITERION. A fault on the `isDeploymentFault` shelf is not reported through the branch
       * below, and its sentence does not leave this process by this route.
       *
       * REASON. Two things would be wrong at once. `failed: true` and 502 say somebody else's
       * software did not answer, which is a false statement about a call that never went out —
       * and this route is `requireUser`, not `requireAdmin`, so the sentence naming our columns
       * and the correction to make would be readable by anybody with a session. The operator who
       * can act on it reads it on the refresh route above, which is admin-gated; here the honest
       * answer is that the deployment cannot make this call as it stands.
       */
      if (isDeploymentFault(error)) {
        return context.json(
          {
            error:
              "That tool isn't set up correctly. Ask an admin to check the server it belongs to.",
          },
          500,
        );
      }
      // A server that failed is not a refusal, and saying so matters: one means the deployment
      // decided against it, the other means somebody else's software did not answer.
      return context.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "The server did not answer.",
          failed: true,
        },
        502,
      );
    }
  });
}

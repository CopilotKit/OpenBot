import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { BotAccessCheck } from "../agents/profile-policy";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import { CATALOGUE, catalogueEntry } from "./catalogue";
import {
  authorizationUrlFor,
  challengeFor,
  connectedAccountsUrlFor,
  createVerifier,
  readConnectState,
  redeemAuthorizationCode,
  redirectUriFor,
  sealConnectState,
} from "./oauth";
import {
  CatalogueEntryUnknownError,
  CustomServerRefusedError,
  type OAuthClient,
  type PluginKind,
  PluginRefusedError,
  type PluginStore,
} from "./store";

/**
 * Whether the person a consent was started for still has access to this deployment.
 *
 * A seam rather than an import, because these routes have no business knowing what a person is or
 * where the deny list lives — and because the answer has to come from the deployment as it is when
 * the callback lands, not from what was true when the flow started.
 *
 * False for somebody who was removed while they were away at the vendor's consent screen, and false
 * for a user id that names nobody at all. Both are the same refusal: there is no live person for
 * this grant to belong to.
 */
export type ConnectingPersonCheck = (userId: string) => Promise<boolean>;

/**
 * The Plugins surface: what this deployment has added, and which Bots may use it.
 *
 * What a Bot can reach is an administrator's; what it is told is not. Adding an MCP server stores a
 * credential and opens a path into another company's system, and enabling one on a Bot is the same
 * decision one step later, so both are an administrator's. A skill only ever asks for tools the Bot
 * already holds, and every one of those calls is still decided, policy-checked and audited, so
 * anybody may write one for themselves and put it on a Bot they own.
 *
 * Reading is open to any signed-in person either way: what a Bot can reach is not a secret from the
 * person talking to it.
 *
 * The call endpoint asks again. The list of tools a run was offered is a snapshot taken when the run
 * started, so a grant revoked a second later is still in the model's hands. Deciding at call time is
 * what makes revocation immediate rather than nearly immediate, and it is where a refusal becomes a
 * row somebody can read.
 */
export function createPluginRoutes(
  store: PluginStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /**
   * Whether the caller may act as the Bot they named. Required rather than optional, so a deployment
   * cannot end up calling somebody else's tools by leaving an argument off.
   */
  canUseBot: BotAccessCheck,
  /**
   * What the connect flow needs that the store does not hold: the key its state is sealed with, the
   * address a vendor sends people back to, and who still has access when they come back.
   *
   * Optional, so a deployment with no public URL configured simply cannot start a connect flow and
   * says so, rather than building a redirect URI out of a request header and failing at the vendor.
   *
   * Last, and after every required parameter, because that is the only position an optional argument
   * can hold. Both of these arrived on separate branches as "one more parameter", which is how a
   * positional list becomes a trap: every argument from here on is optional, so a misplaced one
   * typechecks and simply does nothing.
   */
  connect?: {
    encryptionKey: string;
    /**
     * Whether the person a state names may still connect an account here.
     *
     * Required rather than optional, unlike everything else that arrived on this object as "one more
     * parameter". The callback is sessionless on purpose, so this is the ONLY thing asking whether
     * the identity in the state is still one this deployment recognises — and a deployment that
     * forgot to pass it would complete a consent for somebody who was removed ten minutes ago and
     * write a live refresh token nothing will ever revoke.
     */
    personHasAccess: ConnectingPersonCheck;
    /**
     * Whether this deployment holds a shared secret a Bot may present when calling a tool back.
     *
     * A boolean about configuration, never the secret. Without it, a Bot can only call back if it
     * holds a credential issued to it alone, and a Bot with neither is refused before the call ever
     * reaches the grant, the boundary or the trail. The Bots screen needs this to stop promising a
     * grant the deployment cannot honour.
     */
    botsMayCallBack?: boolean;
    publicUrl: string | undefined;
    /**
     * Where the app is, which is not where this API is.
     *
     * The callback lands here and has to send the person back to a page. A relative redirect would
     * put them on this server's origin, which locally is a Vite-less port that serves no pages at
     * all — so the flow would complete correctly and end on a 404.
     */
    appUrl: string | undefined;
  },
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  const actorEmail = (context: { var: AppVariables }) =>
    context.var.actor?.email ?? "unknown";

  const skillActor = (context: { var: AppVariables }) => ({
    id: context.var.actor.id,
    isAdmin: context.var.actor.role === "admin",
  });

  /**
   * May this person write, edit or delete this skill?
   *
   * An administrator may touch anything. Everybody else may touch their own and nothing else, which
   * includes not editing a deployment skill an administrator wrote for everyone.
   */
  async function skillRefusal(
    context: { var: AppVariables },
    slug: string,
  ): Promise<string | null> {
    const actor = skillActor(context);
    if (actor.isAdmin) return null;
    const owner = await store.skillOwner(slug);
    if (owner === undefined) return null; // A new skill. Ownership is decided on the way in.
    if (owner === null) {
      return `${slug} belongs to this deployment. An administrator looks after it.`;
    }
    return owner === actor.id ? null : `${slug} is somebody else's skill.`;
  }

  /** Everything the Plugins page draws: the catalogue, what is added, and the skills. */
  routes.get("/", requireUser, async (context) =>
    context.json({
      catalogue: CATALOGUE.map((entry) => ({
        key: entry.key,
        title: entry.title,
        vendor: entry.vendor,
        summary: entry.summary,
        docsUrl: entry.docsUrl,
        /*
         * The kind, not the whole thing. The page needs to know what to ask an administrator for;
         * it has no use for the vendor's OAuth addresses, and a URL this deployment sends an
         * authorization code to is not improved by also existing in every browser that opens the
         * Plugins page.
         */
        auth: entry.auth.kind,
        perInstance: entry.host === null,
      })),
      /*
       * Whether a Bot with no credential of its own can still call a tool back.
       *
       * The grant switch decides whether a tool is offered to a model; this decides whether any
       * call it makes can be authenticated at all. They are different questions and the screen used
       * to answer only the first, so a grant could read "May call this tool" on a deployment where
       * every call was refused before it reached the boundary.
       */
      botsMayCallBack: connect?.botsMayCallBack === true,
      servers: await store.listServers(),
      // Scoped: the deployment's skills plus this person's own. An administrator sees them all.
      skills: await store.listSkills(skillActor(context)),
      /*
       * What an administrator has to register with the vendor, character for character.
       *
       * Served rather than assembled in the browser, so what is displayed is exactly what the
       * callback will present. A mismatch here fails at the vendor with a message that does not name
       * us, which is a bad afternoon for whoever is setting it up.
       *
       * Null means this deployment has no public URL, so it cannot complete a consent flow at all.
       */
      redirectUri: connect?.publicUrl
        ? redirectUriFor(connect.publicUrl)
        : null,
    }),
  );

  /** Add a curated server. The URL comes from the catalogue, never from the request. */
  routes.post("/servers", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const body = (await context.req.json().catch(() => null)) as {
      key?: string;
      instanceHost?: string;
      credentialId?: string;
    } | null;
    if (!body?.key) {
      return context.json({ error: "A catalogue key is required." }, 400);
    }

    try {
      const server = await store.addServer({
        key: body.key,
        instanceHost: body.instanceHost,
        credentialId: body.credentialId,
        by: actorEmail(context),
      });
      return context.json({ server });
    } catch (error) {
      // A refused credential is the administrator's mistake to correct, so it comes back as a
      // refusal with its reason rather than as a 500 the way an unmapped throw would.
      if (
        error instanceof CatalogueEntryUnknownError ||
        error instanceof CustomServerRefusedError
      ) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  /**
   * Add a server by URL.
   *
   * Its own endpoint rather than a flag on the one above, so that "an administrator pointed this
   * deployment at an address of their own" is a distinct act in the code, in the audit trail and in
   * anything that reads either.
   */
  routes.post("/servers/custom", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const body = (await context.req.json().catch(() => null)) as {
      id?: string;
      title?: string;
      url?: string;
      credentialId?: string;
    } | null;
    if (!body?.id || !body.title || !body.url) {
      return context.json(
        { error: "A name, a title and a URL are required." },
        400,
      );
    }

    try {
      const server = await store.addCustomServer({
        id: body.id,
        title: body.title,
        url: body.url,
        credentialId: body.credentialId,
        by: actorEmail(context),
      });
      return context.json({ server });
    } catch (error) {
      if (
        error instanceof CustomServerRefusedError ||
        error instanceof CatalogueEntryUnknownError
      ) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  /**
   * Register this deployment's OAuth client for a server reached as the person asking.
   *
   * Its own endpoint rather than a field on `POST /servers`, because it is a separate act with a
   * separate lifetime: a client is rotated without the server being re-added, and re-adding a server
   * should not require re-typing a client. An administrator's, like everything else that decides what
   * a Bot can reach.
   */
  routes.post("/servers/:id/oauth-client", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const body = (await context.req.json().catch(() => null)) as {
      clientId?: string;
      clientSecret?: string;
    } | null;
    if (!body?.clientId?.trim() || !body.clientSecret?.trim()) {
      return context.json(
        { error: "A client id and a client secret are both required." },
        400,
      );
    }

    try {
      await store.registerOAuthClient({
        serverId: context.req.param("id"),
        client: {
          clientId: body.clientId.trim(),
          clientSecret: body.clientSecret.trim(),
        },
        by: actorEmail(context),
      });
      return context.json({ ok: true });
    } catch (error) {
      if (
        error instanceof CatalogueEntryUnknownError ||
        error instanceof CustomServerRefusedError
      ) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  routes.delete("/servers/:id", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    await store.removeServer(context.req.param("id"), actorEmail(context));
    return context.json({ ok: true });
  });

  /** Ask a server what it offers now. Reported rather than thrown, so the page can say what broke. */
  routes.post("/servers/:id/refresh", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    try {
      const result = await store.refreshTools(
        context.req.param("id"),
        context.var.actor.id,
      );
      const servers = await store.listServers();
      return context.json({
        tools: result.tools,
        server: servers.find((server) => server.id === context.req.param("id")),
      });
    } catch (error) {
      if (error instanceof CatalogueEntryUnknownError) {
        return context.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  /**
   * Where a person's own connections are, and how to start a new one.
   *
   * Not admin-only, and that is the point: an administrator registers the connector once, and then
   * everybody connects their own account. Somebody can only ever see or start their own.
   */
  routes.get("/connections", requireUser, async (context) => {
    const connections = await store.connectionsFor(context.var.actor.id);
    return context.json({
      connections,
      // Shown to an administrator so they can register the client at the vendor with the exact value
      // this deployment will send. Null means the deployment has no public URL and cannot connect.
      redirectUri: connect?.publicUrl
        ? redirectUriFor(connect.publicUrl)
        : null,
    });
  });

  /**
   * Begin connecting one person's own account.
   *
   * Answers with a URL rather than redirecting, so the browser decides when to leave the page. The
   * state is minted here, from the session, and the person's identity never comes off the callback.
   */
  routes.post("/servers/:id/connect", requireUser, async (context) => {
    const serverId = context.req.param("id");
    if (!connect?.publicUrl) {
      return context.json(
        {
          error:
            "This deployment has no public URL configured, so it cannot complete a consent flow. Set OPENBOT_PUBLIC_URL.",
        },
        503,
      );
    }

    const entry = catalogueEntry(serverId);
    if (entry?.auth.kind !== "user-oauth") {
      return context.json(
        { error: `${serverId} is not connected as an individual person.` },
        400,
      );
    }

    /*
     * A dynamic entry introduces the deployment itself on first use; a manual one still waits
     * for an administrator. Registration lives here, on the one handler that already refuses
     * without OPENBOT_PUBLIC_URL — the redirect URI it registers is guaranteed to exist.
     */
    /*
     * A vendor in the catalogue that nobody has added to this deployment reaches here, gets past
     * every check above — the entry is real — and then asks the store for a client it cannot have,
     * because there is no server row to hold one. `ensureOAuthClient` says so by throwing, and
     * unhandled that was a 500 on the one path where a person is trying to connect their account.
     *
     * The same 409 as a vendor whose client an administrator has not pasted in yet, because it is
     * the same situation: the person pressing Connect has no step to take, and an administrator has
     * one. The sentence names the step rather than the exception.
     */
    let client: OAuthClient | null;
    try {
      client =
        (await store.oauthClientFor(serverId)) ??
        (entry.auth.clientRegistration === "dynamic"
          ? await store.ensureOAuthClient(serverId, actorEmail(context))
          : null);
    } catch (error) {
      if (error instanceof CatalogueEntryUnknownError) {
        return context.json(
          {
            error: `${entry.title} has not been added to this deployment yet. An administrator has to add it first.`,
          },
          409,
        );
      }
      throw error;
    }
    if (!client) {
      if (entry.auth.clientRegistration === "dynamic") {
        return context.json(
          {
            error: `${entry.title} would not register this deployment, or could not be reached. Try again, and check the vendor's status if it persists.`,
          },
          502,
        );
      }
      return context.json(
        {
          error: `${entry.title} has no OAuth client registered yet. An administrator has to add one first.`,
        },
        409,
      );
    }

    /*
     * Where to come back to, as one of two names rather than a URL the caller chose.
     *
     * Read from the query and narrowed immediately, so an unrecognised value is the default rather
     * than something carried into a sealed state. See {@link ConnectOrigin}: a destination that could
     * name another origin is an open redirect with a consent screen in front of it.
     */
    const returnTo =
      context.req.query("returnTo") === "admin" ? "admin" : "settings";

    const verifier = createVerifier();
    return context.json({
      authorizationUrl: authorizationUrlFor({
        auth: entry.auth,
        clientId: client.clientId,
        redirectUri: redirectUriFor(connect.publicUrl),
        state: await sealConnectState(
          { userId: context.var.actor.id, serverId, verifier, returnTo },
          connect.encryptionKey,
        ),
        codeChallenge: challengeFor(verifier),
      }),
    });
  });

  /**
   * Where the vendor sends somebody back.
   *
   * Deliberately not behind `requireUser`. The person arrives on a redirect from another company's
   * server, and whose connection this is comes from the sealed state rather than from whatever
   * session the browser happens to be carrying — which is what stops a callback delivered to the
   * wrong browser from attaching one person's Google account to another person's row.
   *
   * Having no session is what makes the access check below necessary. Every other route asks the
   * question by being behind a guard; this one has to ask it out loud.
   *
   * Every failure ends the same way: back at Settings with a word about what happened, and nothing
   * written. There is no useful distinction here for the person between a forged state and an expired
   * one, and spelling out which is which tells anybody probing this endpoint how far they got.
   */
  routes.get("/oauth/callback", async (context) => {
    const failed = connectedAccountsUrlFor(connect?.appUrl, {
      failed: true,
    });
    if (!connect?.publicUrl) return context.redirect(failed);

    const code = context.req.query("code");
    const state = await readConnectState(
      context.req.query("state") ?? "",
      connect.encryptionKey,
    );
    if (!code || !state) return context.redirect(failed);

    /*
     * Is the person in the state still somebody here?
     *
     * Asked here, before the code is redeemed and before anything is written, because a state is
     * good for ten minutes and access can end inside them. Removing somebody deny-lists their
     * address, deletes their sessions and retires the credentials they had already granted — and
     * none of that reaches a consent already in flight at the vendor. Without this, that consent
     * comes back and writes a fresh, live refresh token belonging to somebody who no longer has
     * access, which nothing downstream will ever revoke because nothing knows it was created.
     *
     * The same anonymous failure as an unreadable state. Whether an address is deny-listed is not a
     * fact this endpoint owes an unauthenticated caller.
     */
    if (!(await connect.personHasAccess(state.userId))) {
      return context.redirect(failed);
    }

    const entry = catalogueEntry(state.serverId);
    if (entry?.auth.kind !== "user-oauth") return context.redirect(failed);

    const client = await store.oauthClientFor(state.serverId);
    if (!client) return context.redirect(failed);

    const grant = await redeemAuthorizationCode({
      tokenUrl: entry.auth.tokenUrl,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      code,
      redirectUri: redirectUriFor(connect.publicUrl),
      verifier: state.verifier,
    });
    if (!grant) return context.redirect(failed);

    /*
     * The last thing that can fail, answered the same way as everything before it.
     *
     * A vault that will not take the grant is this deployment's problem, not the person's, and they
     * have already done their part at the vendor. Unhandled, this threw past the handler and gave
     * them the bare 500 that every other failure on this route was written to avoid, on the one
     * path where they had most reason to think it had worked.
     *
     * Told, because unlike the refusals above this one is nobody's fault but ours, and the person's
     * sentence deliberately says nothing about which failure it was. The refresh token is not
     * logged: it is the one thing here worth stealing, and the row it belonged to was never written.
     */
    try {
      await store.recordConnection({
        serverId: state.serverId,
        userId: state.userId,
        refreshToken: grant.refreshToken,
        scope: grant.scope,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "oauth-connection-not-recorded",
          serverId: state.serverId,
          note: "A person consented and the grant could not be stored. They were sent back to Settings with a failure and will have to connect again.",
          error: String(error),
        }),
      );
      return context.redirect(failed);
    }

    return context.redirect(
      connectedAccountsUrlFor(
        connect.appUrl,
        { serverId: state.serverId },
        // From the sealed state, so the destination is one this deployment chose, not the browser.
        state.returnTo,
      ),
    );
  });

  /**
   * Write a skill.
   *
   * Not admin-only. A skill is an instruction, not a capability: it can only ask a
   * Bot to use tools that Bot was already granted, and every one of those calls is still decided,
   * policy-checked and audited. Adding an MCP server is the opposite, and stays an administrator's.
   *
   * A person's skill is their own. `global` writes one for the whole deployment, which an
   * administrator may do and nobody else.
   */
  routes.post("/skills", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      slug?: string;
      title?: string;
      summary?: string;
      instructions?: string;
      global?: boolean;
      tools?: unknown;
    } | null;
    if (!body?.slug || !body.title || !body.instructions) {
      return context.json(
        { error: "A slug, a title and instructions are required." },
        400,
      );
    }
    if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(body.slug)) {
      return context.json(
        { error: "A slug is lower-case letters, numbers and hyphens." },
        400,
      );
    }

    const actor = skillActor(context);
    if (body.global && !actor.isAdmin) {
      return context.json(
        { error: "Only an administrator writes a skill for the deployment." },
        403,
      );
    }

    // Editing an existing slug, which is what a repeated save is, needs the right to edit that
    // skill. Without this, saving over somebody else's name would silently take it.
    const refusal = await skillRefusal(context, body.slug);
    if (refusal) return context.json({ error: refusal }, 403);

    /*
     * Absent leaves the declarations alone, so a caller that predates this field does not silently
     * clear one. An array, including an empty one, says what the skill needs now.
     */
    if (body.tools !== undefined && !Array.isArray(body.tools)) {
      return context.json(
        { error: "Tools are a list of serverId/toolName references." },
        400,
      );
    }
    const tools = Array.isArray(body.tools)
      ? body.tools.filter((ref): ref is string => typeof ref === "string")
      : undefined;

    try {
      await store.installSkill({
        slug: body.slug,
        title: body.title,
        summary: body.summary ?? "",
        instructions: body.instructions,
        ownerUserId: body.global ? null : actor.id,
        ...(tools === undefined ? {} : { tools }),
        by: actorEmail(context),
      });
    } catch (error) {
      // A ref naming no tool this deployment has seen. Answered rather than thrown, because it is
      // something the person writing the skill can fix and the message says what to fix.
      if (error instanceof PluginRefusedError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
    return context.json({ skills: await store.listSkills(actor) });
  });

  routes.delete("/skills/:slug", requireUser, async (context) => {
    const slug = context.req.param("slug");
    const refusal = await skillRefusal(context, slug);
    if (refusal) return context.json({ error: refusal }, 403);

    await store.uninstallSkill(slug, actorEmail(context));
    return context.json({ ok: true });
  });

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
   * May this person put this on that Bot?
   *
   * MCP is an administrator's, always: it reaches another company's system with a stored credential.
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
      return actor.isAdmin
        ? null
        : "An administrator decides which Bots may reach a tool.";
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
        return "An administrator decides which Bots may hand work to another Bot.";
      }
      // Taking something away is always allowed: see the note on `intent`.
      if (intent === "revoke") return null;

      /*
       * A grant that could never do anything is refused rather than stored, from both ends.
       *
       * The GRANTEE has to run here, because handing work on is a tool this deployment executes: a
       * Bot at an endpoint runs its own loop and is handed descriptions of what it may call back
       * for, and there is no callback path that would execute a hop.
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
      const runsHere = await store.agentRunsHere(agentId);
      if (runsHere === undefined) return "There is no such Bot.";
      if (!runsHere) {
        return `${agentId} runs at its own endpoint, so this deployment cannot offer it a tool for handing work on. Only a Bot that runs here can be given one.`;
      }
      if (!(await store.agentIsRegistered(ref))) {
        return `There is no Bot called ${ref} to hand work to.`;
      }
      return null;
    }

    if (actor.isAdmin) return null;

    const owner = await store.skillOwner(ref);
    if (owner === undefined) return `There is no skill called ${ref}.`;
    if (owner !== actor.id) {
      return owner === null
        ? `${ref} belongs to this deployment. An administrator decides which Bots use it.`
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
    } | null;
    const kind = asGrantKind(body?.kind);
    if (!kind || !body?.ref || !body.agentId) {
      return context.json(
        { error: "A kind, a ref and a Bot are required." },
        400,
      );
    }
    const refusal = await enablementRefusal(
      context,
      kind,
      body.ref,
      body.agentId,
      "grant",
    );
    if (refusal) return context.json({ error: refusal }, 403);

    await store.grant(kind, body.ref, body.agentId, actorEmail(context));
    return context.json({ ok: true });
  });

  routes.delete("/grants", requireUser, async (context) => {
    const kind = asGrantKind(context.req.query("kind"));
    const ref = context.req.query("ref");
    const agentId = context.req.query("agentId");
    if (!kind || !ref || !agentId) {
      return context.json(
        { error: "A kind, a ref and a Bot are required." },
        400,
      );
    }
    const refusal = await enablementRefusal(
      context,
      kind,
      ref,
      agentId,
      "revoke",
    );
    if (refusal) return context.json({ error: refusal }, 403);

    await store.revoke(kind, ref, agentId, actorEmail(context));
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
    if (!body?.ref || !body.agentId) {
      return context.json({ error: "A tool and a Bot are required." }, 400);
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
      });
      return context.json(result);
    } catch (error) {
      if (error instanceof PluginRefusedError) {
        return context.json({ error: error.message, rule: error.rule }, 403);
      }
      if (error instanceof CatalogueEntryUnknownError) {
        return context.json({ error: error.message }, 404);
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

  return routes;
}

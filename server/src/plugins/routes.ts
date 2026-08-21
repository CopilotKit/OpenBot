import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import { CATALOGUE, catalogueEntry } from "./catalogue";
import {
  authorizationUrlFor,
  challengeFor,
  createVerifier,
  readConnectState,
  redeemAuthorizationCode,
  redirectUriFor,
  connectedAccountsUrlFor,
  signConnectState,
} from "./oauth";
import {
  CatalogueEntryUnknownError,
  CustomServerRefusedError,
  PluginRefusedError,
  type PluginStore,
} from "./store";

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
   * What the connect flow needs that the store does not hold: the key its state is signed with, and
   * the address a vendor sends people back to.
   *
   * Optional, so a deployment with no public URL configured simply cannot start a connect flow and
   * says so, rather than building a redirect URI out of a request header and failing at the vendor.
   */
  connect?: {
    encryptionKey: string;
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
      if (error instanceof CatalogueEntryUnknownError) {
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

    const client = await store.oauthClientFor(serverId);
    if (!client) {
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
     * than something carried into a signed state. See {@link ConnectOrigin}: a destination that could
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
        state: signConnectState(
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
   * server, and whose connection this is comes from the signed state rather than from whatever
   * session the browser happens to be carrying — which is what stops a callback delivered to the
   * wrong browser from attaching one person's Google account to another person's row.
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
    const state = readConnectState(
      context.req.query("state") ?? "",
      connect.encryptionKey,
    );
    if (!code || !state) return context.redirect(failed);

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

    await store.recordConnection({
      serverId: state.serverId,
      userId: state.userId,
      refreshToken: grant.refreshToken,
      scope: grant.scope,
    });

    return context.redirect(
      connectedAccountsUrlFor(
        connect.appUrl,
        { serverId: state.serverId },
        // From the signed state, so the destination is one this deployment chose, not the browser.
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

    await store.installSkill({
      slug: body.slug,
      title: body.title,
      summary: body.summary ?? "",
      instructions: body.instructions,
      ownerUserId: body.global ? null : actor.id,
      by: actorEmail(context),
    });
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
   * May this person put this on that Bot?
   *
   * MCP is an administrator's, always: it reaches another company's system with a stored credential.
   * A skill is an instruction, so somebody may put their own skill on a Bot they own, and neither
   * half alone is enough. Both are checked here rather than in the store, because this is the only
   * place that knows who is asking.
   */
  async function enablementRefusal(
    context: { var: AppVariables },
    kind: "mcp" | "skill",
    ref: string,
    agentId: string,
  ): Promise<string | null> {
    const actor = skillActor(context);
    if (actor.isAdmin) return null;
    if (kind === "mcp") {
      return "An administrator decides which Bots may reach a tool.";
    }

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
      kind?: "mcp" | "skill";
      ref?: string;
      agentId?: string;
    } | null;
    if (!body?.kind || !body.ref || !body.agentId) {
      return context.json(
        { error: "A kind, a ref and a Bot are required." },
        400,
      );
    }
    const refusal = await enablementRefusal(
      context,
      body.kind,
      body.ref,
      body.agentId,
    );
    if (refusal) return context.json({ error: refusal }, 403);

    await store.grant(body.kind, body.ref, body.agentId, actorEmail(context));
    return context.json({ ok: true });
  });

  routes.delete("/grants", requireUser, async (context) => {
    const kind = context.req.query("kind");
    const ref = context.req.query("ref");
    const agentId = context.req.query("agentId");
    if ((kind !== "mcp" && kind !== "skill") || !ref || !agentId) {
      return context.json(
        { error: "A kind, a ref and a Bot are required." },
        400,
      );
    }
    const refusal = await enablementRefusal(context, kind, ref, agentId);
    if (refusal) return context.json({ error: refusal }, 403);

    await store.revoke(kind, ref, agentId, actorEmail(context));
    return context.json({ ok: true });
  });

  /** What one Bot holds. The runtime reads this to decide what to offer a model. */
  routes.get("/for/:agentId", requireUser, async (context) =>
    context.json(await store.listForAgent(context.req.param("agentId"))),
  );

  /**
   * Call a tool, as a Bot.
   *
   * The grant, the policy and the audit row all happen inside the store, so this endpoint cannot
   * accidentally satisfy one of them and skip another. A refusal comes back as 403 with the reason
   * the model and the person are both shown, which is the same sentence written to the trail.
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

    try {
      const result = await store.callTool({
        ref: body.ref,
        args: body.args ?? {},
        botId: body.agentId,
        actorId: actorEmail(context),
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

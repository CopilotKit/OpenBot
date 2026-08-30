/**
 * The HTTP surface for templates: authoring a draft, reading a stranger's file, and installing it.
 *
 * THIS FILE DECIDES ALMOST NOTHING. The parser refuses a document, the packer refuses a coworker it
 * cannot express, the resolver reports what this deployment can satisfy and the installer writes the
 * one transaction. What is left here is the part that is genuinely the API's: who may ask, what an
 * error becomes on the wire, and which refusals reach the trail. Everything else is delegated, and
 * deliberately so — a route that re-implemented one of those rules would be a second copy of it that
 * drifts.
 *
 * ONE RULE THIS FILE DOES OWN, and it is the whole feature's: satisfying a capability goes through
 * the grant stores that already refuse. The grant route below acts on the LEDGER and hands the
 * decision to `pluginStore.grant` or `componentStore.grant`; it never re-reads the document, so the
 * artifact a person consented to cannot change what is being approved a week later, and there is no
 * second grant path with a second set of checks.
 *
 * WHICH MEANS THIS FILE HOLDS THE ONLY `grant("mcp", …)` UNDER `server/src/templates/`, and anybody
 * writing the grep test that guards the import path has to know that. The property is about the
 * IMPORT: `install.ts` has no code path that writes an MCP grant, not a conditional one and not one
 * behind a flag, because `store.grant` performs no existence check and an optimistic row for an
 * absent connector would be invisible on every screen and would go live the day somebody added that
 * connector, with nobody deciding. The call on line ~610 is the opposite of that in every respect:
 * it is behind `requireAdmin`, it acts on a ledger row a person already consented to, it names a
 * tool that exists, and it is exactly the act the grant screen performs. Scope the grep to the
 * import path rather than to the directory, or it will forbid the thing the feature is for.
 */
import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  type BotTemplate,
  botTemplateDigest,
  parseBotTemplate,
  serializeBotTemplate,
  TemplateRefusedError,
} from "../../../shared/bot-template";
import { authFromConfiguration } from "../agents/auth-header";
import type { BotAccessCheck } from "../agents/profile-policy";
import type { AgentActor, AgentProfile } from "../agents/profile-types";
import {
  type AuditEventType,
  type AuditStore,
  recordAuditEvent,
} from "../audit";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { ComponentStore } from "../components/store";
import { agents } from "../db/schema";
import type { PluginStore } from "../plugins/store";
import {
  type TemplateActor,
  TemplateDigestMovedError,
  TemplateEndpointRefusedError,
  TemplateEndpointRequiredError,
  TemplateImportNotFoundError,
  type TemplateInstaller,
  TemplateRetractionRefusedError,
  TemplateSlugDecisionError,
  TemplateSlugUnavailableError,
  TemplateVaultUnavailableError,
} from "./install";
import { packBotTemplate, refuseSecrets, SecretInTemplateError } from "./pack";
import { resolveBotTemplate, type SlugResolution } from "./resolve";
import {
  type TemplateDraft,
  type TemplateImportSource,
  TemplateNotFoundError,
  type TemplateReadExecutor,
  type TemplateRequestKind,
  TemplateSlugTakenError,
  type TemplateStore,
} from "./store";

/**
 * The local development actor, which is not a row in `users`.
 *
 * The audit table has a foreign key to that table, so writing this id would fail the constraint and
 * lose the row entirely. Who it was is in the payload either way — the convention
 * `agents/routes.ts:123-129` already follows, restated here rather than imported because importing
 * it would make this module depend on the agents API for a constant.
 */
const DEV_ACTOR_EMAIL = "dev@openbot.local";

/**
 * Why a document was turned away, in the machine-readable half.
 *
 * The parser's own `TemplateRefusal` codes travel through unchanged; the rest are added here because
 * they name refusals that happen AFTER a document parsed cleanly. That distinction is the reason
 * `template.import_refused` carries a `digest` at all: a file refused by the parser never got as far
 * as being hashed, and one refused for an address this deployment will not dial did.
 */
type RefusalCode =
  | "secret_shape"
  | "digest_moved"
  | "endpoint_required"
  | "endpoint_refused"
  | "vault_unavailable"
  | "slug_decision"
  | "slug_unavailable";

/** What a template surface needs that it cannot build for itself. */
export type TemplateRoutesDeps = {
  templateStore: TemplateStore;
  installer: TemplateInstaller;
  auditStore: AuditStore;
  /**
   * A read handle for the resolver, which is a pure function over the deployment's own tables.
   *
   * The install path resolves again on its own transaction; this one is the preview, which writes
   * nothing and may read on the pool.
   */
  executor: TemplateReadExecutor;
  /**
   * Whether this deployment has a Bot in the box.
   *
   * A boolean rather than the URL, because the only question the plan asks is whether a coworker
   * with `runtime: managed` has anywhere to run. The address itself is the installer's business.
   */
  managedAgent: boolean;
  /**
   * The existing MCP grant path, and the only one this file will use.
   *
   * `Pick<…, "grant">` rather than the whole store, so this module cannot grow a second way to
   * write a permission by reaching for a method that happens to be in scope. Absent on a deployment
   * with no plugin store, which is a deployment where an MCP ask cannot be satisfied at all — said
   * plainly rather than recorded as decided.
   */
  grants?: Pick<PluginStore, "grant">;
  /** The existing component path, on the same terms and for the same reason. */
  components?: Pick<ComponentStore, "grant">;
};

/**
 * Packing one coworker into a draft, as one act with its trail.
 *
 * A seam rather than a route, because the export lives in `createAgentRoutes` — it is a thing done
 * to a Bot, beside Duplicate, and giving it its own mount would put the same authorization question
 * in two files. `createAgentRoutes` asks whether this person may manage this Bot and then calls
 * this; everything below the question is here, where the rest of the template code is.
 */
export type TemplateExport = {
  /**
   * Pack, store the draft, and record `template.exported`.
   *
   * Throws `TemplateRefusedError` when the coworker cannot be expressed in the format,
   * `SecretInTemplateError` when its prose carries something shaped like a credential, and
   * `TemplateSlugTakenError` when this person already has a draft by that name.
   */
  exportAgent(
    actor: TemplateActor,
    profile: AgentProfile,
  ): Promise<ExportedTemplate>;
};

export type ExportedTemplate = {
  templateId: string;
  /** The file itself, so the author can read what left the building before anything else does. */
  yaml: string;
  digest: string;
  /** What was left behind, in sentences. The interesting half of an export. */
  stripped: string[];
};

export type TemplateExportDeps = {
  executor: TemplateReadExecutor;
  templateStore: TemplateStore;
  auditStore: AuditStore;
  /**
   * What this Bot holds, read to derive the ASK and never to make one.
   *
   * `listForAgent` rather than the grant rows, deliberately: it answers with the skills in full —
   * slug, title, summary, instructions and declarations — which is exactly what travels, and it
   * reads the MCP grants against the live tool list. The cost of that second half is worth naming: a
   * grant for a tool the vendor has stopped advertising does not become a request, so a template
   * packed while a connector was misbehaving asks for less than the Bot was given. Under-asking is
   * the safe direction, and the author edits the draft anyway.
   */
  plugins?: Pick<PluginStore, "listForAgent">;
  components?: Pick<ComponentStore, "listForAgent">;
  /**
   * This deployment's own AG-UI address, when it has a Bot in the box.
   *
   * The packer needs it to tell `managed` from `remote`: `create` writes the deployment's own
   * address into `configuration.endpoint` for a coworker that runs here, so having an endpoint is
   * not what distinguishes the two.
   */
  managedAgentAgUiUrl?: URL;
};

export function createTemplateExport(deps: TemplateExportDeps): TemplateExport {
  return {
    async exportAgent(actor, profile) {
      /*
       * The configuration row, read straight rather than through the profile store.
       *
       * `AgentProfile` deliberately does not carry it: it holds the endpoint and the vault pointer,
       * and neither is something every screen that lists coworkers should be handed. The packer
       * needs both — to decide the runtime and to name the auth header — and neither travels.
       */
      const [row] = await deps.executor
        .select({ configuration: agents.configuration })
        .from(agents)
        .where(eq(agents.id, profile.id))
        .limit(1);
      const configuration = isRecord(row?.configuration)
        ? row.configuration
        : {};

      const granted = deps.plugins
        ? await deps.plugins.listForAgent(profile.id)
        : { tools: [], skills: [] };
      const components = deps.components
        ? (await deps.components.listForAgent(profile.id)).map(
            (component) => component.name,
          )
        : [];
      const auth = authFromConfiguration(configuration);

      const packed = packBotTemplate({
        profile,
        configuration,
        skills: granted.skills.map((skill) => ({
          slug: skill.slug,
          title: skill.title,
          summary: skill.summary,
          instructions: skill.instructions,
          tools: skill.tools,
        })),
        grants: granted.tools.map((tool) => ({ ref: tool.ref })),
        components,
        // The header NAME, which `auth-header.ts` already keeps unencrypted because it is not a
        // secret. The value lives in the vault and is not readable from here at all.
        ...(auth ? { authHeaderName: auth.header } : {}),
        ...(deps.managedAgentAgUiUrl
          ? { managedEndpoint: deps.managedAgentAgUiUrl.toString() }
          : {}),
      });

      const draft = await deps.templateStore.createDraft(actor, {
        agentId: profile.id,
        document: packed.template,
      });
      const yaml = serializeBotTemplate(packed.template);
      const digest = await botTemplateDigest(packed.template);

      /*
       * NEVER THE PROSE. `stripped` is a list of sentences this repository wrote about fields, the
       * skills are slugs and the requests are connector ids and component names — none of which is
       * anybody's text. The role description and the skill instructions are the substance of a
       * template and they are not in the trail; a reader who wants them reads the document.
       *
       * `redactAuditPayload` would not have saved us here. It is a key-NAME filter and knows nothing
       * about a field called `summary`, so the rule is kept at the point the payload is built.
       */
      await recordTemplateEvent(deps.auditStore, actor, {
        eventType: "template.exported",
        targetType: "agent",
        targetId: profile.id,
        payload: {
          templateSlug: packed.template.template.slug,
          digest,
          stripped: packed.stripped,
          skills: packed.template.skills.map((skill) => skill.slug),
          requests: {
            connectors: packed.template.requests.connectors.map(
              (connector) => connector.id,
            ),
            components: packed.template.requests.components.map(
              (component) => component.name,
            ),
          },
        },
      });

      return { templateId: draft.id, yaml, digest, stripped: packed.stripped };
    },
  };
}

export function createTemplateRoutes(
  deps: TemplateRoutesDeps,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /**
   * Whether the caller may act as the Bot they named. Required rather than optional, the same shape
   * `createPluginRoutes` takes it in, so a deployment cannot end up reading somebody else's
   * coworker's provenance by leaving an argument off.
   */
  canUseBot: BotAccessCheck,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { templateStore, installer } = deps;

  const actorEmail = (context: Context<{ Variables: AppVariables }>) =>
    context.var.actor.email ?? "unknown";

  /**
   * A document this deployment would not take, on the trail and on the wire.
   *
   * Both, in one place, because they have to agree: the person is shown the sentence and the reader
   * of the trail is shown the code, and a route that wrote one without the other would produce
   * refusals nobody can count or refusals nobody can read.
   *
   * Never the document and never a line of it. What went in is the reason, and the digest and slug
   * when the document got far enough to have them.
   */
  const refuse = async (
    context: Context<{ Variables: AppVariables }>,
    error: unknown,
    known: { digest?: string; slug?: string } = {},
  ): Promise<Response> => {
    const refusal = refusalFor(error);
    if (!refusal) throw error;
    await recordTemplateEvent(deps.auditStore, context.var.actor, {
      eventType: "template.import_refused",
      targetType: "template",
      ...(known.digest ? { targetId: known.digest } : {}),
      payload: {
        reason: refusal.reason,
        ...(known.digest ? { digest: known.digest } : {}),
        ...(known.slug ? { slug: known.slug } : {}),
        ...(refusal.field ? { field: refusal.field } : {}),
      },
    });
    return context.json(
      {
        error: refusal.message,
        reason: refusal.reason,
        ...(refusal.field ? { field: refusal.field } : {}),
      },
      400,
    );
  };

  /** Your drafts. An administrator sees the deployment's, which is what the store already decides. */
  routes.get("/", requireUser, async (context) => {
    const drafts = await templateStore.listDrafts(context.var.actor);
    return context.json({
      templates: drafts.map((draft) => draftDto(context.var.actor, draft)),
    });
  });

  /**
   * What a file would do here. Writes nothing, and on success records nothing.
   *
   * A preview that left a row would make reading a template indistinguishable from installing one,
   * and the point of the consent screen is that a person can read a stranger's file without having
   * agreed to anything yet. A REFUSAL is recorded, because a refusal leaves no other trace anywhere
   * in the product and the interesting case is the repeated one.
   */
  routes.post("/preview", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      source?: unknown;
    } | null;
    const source = typeof body?.source === "string" ? body.source : "";
    if (!source.trim()) {
      return context.json({ error: "Paste a template file." }, 400);
    }

    let template: BotTemplate;
    try {
      template = parseBotTemplate(source);
    } catch (error) {
      return refuse(context, error);
    }

    const digest = await botTemplateDigest(template);
    const plan = await resolveBotTemplate(deps.executor, template, {
      managedAgent: deps.managedAgent,
      digest,
    });
    /*
     * The parsed document goes back, not the text that was posted. The consent screen renders every
     * word of it, and what it must render is what the parser accepted rather than what the browser
     * happens to be holding — those are the same today only because the parser refused everything
     * that would have made them differ.
     */
    return context.json({ template, digest, plan });
  });

  routes.post("/install", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      source?: unknown;
      digest?: unknown;
      from?: unknown;
      sourceRef?: unknown;
      endpoint?: unknown;
      auth?: unknown;
      slugDecisions?: unknown;
    } | null;

    const source = typeof body?.source === "string" ? body.source : "";
    const digest = typeof body?.digest === "string" ? body.digest.trim() : "";
    if (!source.trim() || !digest) {
      return context.json(
        { error: "A template and the digest you were shown are required." },
        400,
      );
    }

    const auth = readAuth(body?.auth);
    if (auth === "invalid") {
      return context.json({ error: "That is not a valid header name." }, 400);
    }
    const slugDecisions = readSlugDecisions(body?.slugDecisions);
    if (slugDecisions === "invalid") {
      return context.json(
        { error: "A skill is reused, suffixed or skipped." },
        400,
      );
    }

    let template: BotTemplate;
    try {
      template = parseBotTemplate(source);
    } catch (error) {
      return refuse(context, error);
    }

    /*
     * Recomputed here as well as inside the installer, so a refusal after a clean parse can say
     * WHICH document was turned away. The installer refuses on its own value either way; this one
     * exists for the trail.
     */
    const actual = await botTemplateDigest(template);
    try {
      const result = await installer.installBotTemplate({
        template,
        digest,
        actor: context.var.actor,
        source: readSource(body?.from),
        ...(typeof body?.sourceRef === "string" && body.sourceRef.trim()
          ? { sourceRef: body.sourceRef.trim() }
          : {}),
        ...(typeof body?.endpoint === "string" && body.endpoint.trim()
          ? { endpoint: body.endpoint.trim() }
          : {}),
        ...(auth ? { auth } : {}),
        ...(slugDecisions ? { slugDecisions } : {}),
      });
      /*
       * The provenance row's `document` is deliberately not echoed. The caller posted it a moment
       * ago and the consent screen is still holding it; sending a stranger's whole file back as the
       * receipt for having installed it is a second copy of the largest thing in the exchange.
       */
      return context.json(
        {
          agentId: result.agentId,
          importId: result.imported.id,
          slug: result.imported.slug,
          digest: result.imported.digest,
          requests: result.ledger,
          plan: result.plan,
          skillsCreated: result.skillsCreated,
          skillsReused: result.skillsReused,
          skillsSuffixed: result.skillsSuffixed,
          skillsSkipped: result.skillsSkipped,
        },
        201,
      );
    } catch (error) {
      if (error instanceof TemplateDigestMovedError) {
        /*
         * 409 rather than 400, and the distinction is the point. Nothing is wrong with the document;
         * what is wrong is that it is not the document the person read. A 400 would have the screen
         * tell them their file is malformed, and they would go and look at the wrong thing.
         */
        await recordTemplateEvent(deps.auditStore, context.var.actor, {
          eventType: "template.import_refused",
          targetType: "template",
          targetId: error.actual,
          payload: {
            reason: "digest_moved",
            digest: error.actual,
            expected: error.expected,
            slug: template.template.slug,
          },
        });
        return context.json(
          {
            error: error.message,
            reason: "digest_moved",
            digest: error.actual,
          },
          409,
        );
      }
      if (error instanceof TemplateSlugDecisionError) {
        await recordTemplateEvent(deps.auditStore, context.var.actor, {
          eventType: "template.import_refused",
          targetType: "template",
          targetId: actual,
          payload: {
            reason: "slug_decision",
            digest: actual,
            slug: template.template.slug,
          },
        });
        return context.json(
          { error: error.message, reason: "slug_decision", slug: error.slug },
          409,
        );
      }
      return refuse(context, error, {
        digest: actual,
        slug: template.template.slug,
      });
    }
  });

  /**
   * Where this Bot came from, and what it asked for.
   *
   * 404 rather than 403 for a coworker somebody may not see, matching `GET /api/plugins/for/:agentId`
   * exactly: a distinguishable "you may not" is an oracle for other people's private Bots, and a
   * provenance row would tell a stranger which template somebody imported and what it wanted.
   */
  routes.get("/imports/:agentId", requireUser, async (context) => {
    const agentId = context.req.param("agentId");
    if (!(await canUseBot(context.var.actor, agentId))) {
      return context.json({ error: "There is no such Bot." }, 404);
    }
    const imported = await templateStore.importForAgent(agentId);
    if (!imported) {
      return context.json(
        { error: "This Bot did not come from a template." },
        404,
      );
    }
    return context.json({
      import: imported,
      requests: await templateStore.listRequests(imported.id),
      boundaries: await templateStore.boundariesFor(imported.id),
    });
  });

  /**
   * An administrator answering one ask, through the grant store that already refuses.
   *
   * `ref` arrives percent-encoded, because an MCP ref is `<serverId>/<toolName>` and a slash is a
   * path separator. Hono decodes the parameter, so what arrives here is the ref exactly as the
   * ledger stores it.
   */
  const decide = (verdict: "granted" | "declined") =>
    async function decision(context: Context<{ Variables: AppVariables }>) {
      const denied = requireAdmin(context);
      if (denied) return denied;

      /*
       * All three read as optional, because this handler is written out rather than declared inline
       * and Hono only infers a path's parameters at the call that registers it. Checked rather than
       * asserted: a non-null assertion here would be a claim about a router this file does not own.
       */
      const agentId = context.req.param("agentId");
      const kind = asRequestKind(context.req.param("kind"));
      const ref = context.req.param("ref");
      if (!agentId || !kind || !ref) {
        return context.json(
          { error: "A Bot, a kind and a ref are required." },
          400,
        );
      }

      const imported = await templateStore.importForAgent(agentId);
      if (!imported) {
        return context.json(
          { error: "This Bot did not come from a template." },
          404,
        );
      }
      const ledger = await templateStore.listRequests(imported.id);
      const row = ledger.find(
        (entry) => entry.kind === kind && entry.ref === ref,
      );
      if (!row) {
        return context.json(
          { error: "This template did not ask for that." },
          404,
        );
      }

      /*
       * The address is not a grant. It was answered on the way in by whoever typed it, and the row
       * exists so the profile's amber list does not show a slot that is filled. There is nothing
       * here for an administrator to approve or refuse; repointing a coworker is an edit of the Bot.
       */
      if (kind === "endpoint") {
        return context.json(
          {
            error:
              "The address this coworker runs at was answered by whoever imported it. Change it by editing the Bot.",
          },
          400,
        );
      }

      if (verdict === "granted") {
        if (kind === "mcp") {
          /*
           * A bare connector id is an ask with nothing grantable behind it — the template named a
           * connector that listed no tools — and the answer to it is adding the connector, not
           * writing a grant. `store.grant` performs no existence check, so a row written here would
           * be invisible on every screen and would go live the day somebody added that connector.
           */
          if (!ref.includes("/")) {
            return context.json(
              {
                error: `${ref} is a connector, not a tool. Add it on the Plugins page, then grant the tools this Bot needs.`,
              },
              400,
            );
          }
          if (!deps.grants) {
            return context.json(
              {
                error:
                  "This deployment cannot reach its grant table, so nothing can be granted.",
              },
              503,
            );
          }
          await deps.grants.grant("mcp", ref, agentId, actorEmail(context));
        } else {
          if (!deps.components) {
            return context.json(
              {
                error:
                  "This deployment has no component store, so nothing can be granted.",
              },
              503,
            );
          }
          await deps.components.grant(ref, agentId);
        }
      }

      const decided = await templateStore.decideRequest({
        importId: imported.id,
        kind,
        ref,
        status: verdict,
        decidedBy: actorEmail(context),
      });
      if (!decided) {
        return context.json(
          { error: "This template did not ask for that." },
          404,
        );
      }

      /*
       * Recorded against the Bot, and the author's `why` is deliberately not in it. That sentence is
       * a stranger's prose; it lives in the ledger, which is where it is rendered as one.
       */
      await recordTemplateEvent(deps.auditStore, context.var.actor, {
        eventType:
          verdict === "granted"
            ? "template.capability_granted"
            : "template.capability_declined",
        targetType: "agent",
        targetId: agentId,
        payload: { bot: agentId, importId: imported.id, kind, ref },
      });

      return context.json({ request: decided });
    };

  routes.post(
    "/imports/:agentId/requests/:kind/:ref/grant",
    requireUser,
    decide("granted"),
  );
  routes.post(
    "/imports/:agentId/requests/:kind/:ref/decline",
    requireUser,
    decide("declined"),
  );

  /**
   * Take back what the import gave, and nothing else.
   *
   * Both refusals answer 404. The owner and an administrator are the only people with any business
   * here, and telling anybody else that this Bot has an import to retract is the same oracle the
   * read above closes.
   */
  routes.delete("/imports/:agentId", requireUser, async (context) => {
    try {
      const result = await installer.retractTemplateImport({
        actor: context.var.actor,
        agentId: context.req.param("agentId"),
      });
      return context.json(result);
    } catch (error) {
      if (
        error instanceof TemplateImportNotFoundError ||
        error instanceof TemplateRetractionRefusedError
      ) {
        return context.json({ error: "There is no such Bot." }, 404);
      }
      throw error;
    }
  });

  /**
   * Edit a draft, which is editing a file.
   *
   * The parser and the secret scanner both run again, because this is the only path by which a
   * template's text changes after it was packed, and the packer's refusals are properties of the
   * document rather than of the coworker it came from. A refusal here writes nothing to the trail:
   * an author fixing their own draft is not an import, and filing it among the import refusals would
   * teach a reader to discount the ones that are somebody pasting a stranger's file.
   */
  routes.patch("/:templateId", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      source?: unknown;
    } | null;
    const source = typeof body?.source === "string" ? body.source : "";
    if (!source.trim()) {
      return context.json({ error: "A template file is required." }, 400);
    }

    let template: BotTemplate;
    try {
      template = parseBotTemplate(source);
      refuseSecrets(template);
    } catch (error) {
      const refusal = refusalFor(error);
      if (!refusal) throw error;
      return context.json(
        {
          error: refusal.message,
          reason: refusal.reason,
          ...(refusal.field ? { field: refusal.field } : {}),
        },
        400,
      );
    }

    try {
      const draft = await templateStore.updateDraft(
        context.var.actor,
        context.req.param("templateId"),
        template,
      );
      return context.json({
        template: draftDto(context.var.actor, draft),
        yaml: serializeBotTemplate(draft.document),
        digest: await botTemplateDigest(draft.document),
      });
    } catch (error) {
      return mapDraftError(context, error);
    }
  });

  routes.delete("/:templateId", requireUser, async (context) => {
    try {
      await templateStore.deleteDraft(
        context.var.actor,
        context.req.param("templateId"),
      );
      return context.body(null, 204);
    } catch (error) {
      return mapDraftError(context, error);
    }
  });

  /**
   * The draft as the file it is.
   *
   * `text/yaml` and an attachment, because the thing being served is a document somebody sends to
   * somebody else, not a page. The filename is built from the slug, which the parser has already
   * held to `^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$` — so there is nothing in it that could break out of
   * the header, and this is not the place to re-derive that rule.
   */
  routes.get("/:templateId/file", requireUser, async (context) => {
    try {
      const draft = await templateStore.getDraft(
        context.var.actor,
        context.req.param("templateId"),
      );
      return context.body(serializeBotTemplate(draft.document), 200, {
        "content-type": "text/yaml; charset=utf-8",
        "content-disposition": `attachment; filename="${draft.slug}.openbot.yaml"`,
      });
    } catch (error) {
      return mapDraftError(context, error);
    }
  });

  return routes;
}

/**
 * A draft on the wire.
 *
 * The document is not in it. A list of drafts is a roster, and every entry carrying a whole template
 * would make opening the page cost as much as opening every file on it; `/file` is how one is read.
 * `mine` is separate from being allowed to see it, for the reason `agentDto` gives: an administrator
 * sees everybody's, and a screen that split "mine" on permission would file other people's work
 * under theirs.
 */
function draftDto(actor: AgentActor, draft: TemplateDraft) {
  return {
    id: draft.id,
    agentId: draft.agentId,
    slug: draft.slug,
    name: draft.document.bot.name,
    title: draft.document.bot.title,
    summary: draft.document.template.summary,
    skills: draft.document.skills.map((skill) => skill.slug),
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    mine: draft.ownerUserId === actor.id,
  };
}

/**
 * A draft somebody may not see and a name somebody already has.
 *
 * Not-found rather than forbidden, and that is the store's decision rather than this one's: a draft
 * belonging to somebody else is answered as absent so the drafts route is not a way to enumerate
 * what other people are working on.
 */
function mapDraftError(
  context: Context<{ Variables: AppVariables }>,
  error: unknown,
): Response {
  if (error instanceof TemplateNotFoundError) {
    return context.json({ error: "There is no such template." }, 404);
  }
  if (error instanceof TemplateSlugTakenError) {
    /*
     * 409 rather than overwriting. A second export of the same coworker, or an edit that renames a
     * draft onto a name this person already used, would otherwise silently replace a file they had
     * been editing — and the edits are the whole reason export produces a draft.
     */
    return context.json({ error: error.message }, 409);
  }
  throw error;
}

/** The refusal a wire response and an audit row are both built from, or nothing if this is a bug. */
function refusalFor(
  error: unknown,
): { reason: string; message: string; field?: string } | null {
  if (error instanceof TemplateRefusedError) {
    return { reason: error.reason, message: error.message };
  }
  if (error instanceof SecretInTemplateError) {
    /*
     * The field, never the value. The message the scanner writes says what shape was found and
     * where; it does not quote what it found, because this string is rendered, logged and audited.
     */
    return {
      reason: "secret_shape" satisfies RefusalCode,
      message: error.message,
      field: error.field,
    };
  }
  if (error instanceof TemplateEndpointRequiredError) {
    return {
      reason: "endpoint_required" satisfies RefusalCode,
      message: error.message,
    };
  }
  if (error instanceof TemplateEndpointRefusedError) {
    return {
      reason: "endpoint_refused" satisfies RefusalCode,
      message: error.message,
    };
  }
  if (error instanceof TemplateVaultUnavailableError) {
    return {
      reason: "vault_unavailable" satisfies RefusalCode,
      message: error.message,
    };
  }
  if (error instanceof TemplateSlugUnavailableError) {
    return {
      reason: "slug_unavailable" satisfies RefusalCode,
      message: error.message,
    };
  }
  return null;
}

/**
 * One trail row, never fatal.
 *
 * The act is already done and the caller has been told so, so a trail that is briefly unavailable is
 * not a reason to report a failure that did not happen — the judgement `agents/routes.ts` and
 * `templates/install.ts` both make. It matters here because the refusal path writes its row before
 * answering: a throw would turn a 400 the person can act on into a 500 they cannot.
 *
 * Under `OPENBOT_SINGLE_USER` the actor is not a row in `users`, so `actorUserId` is left off and
 * the identity travels in the payload instead.
 */
async function recordTemplateEvent(
  auditStore: AuditStore,
  actor: TemplateActor,
  event: {
    eventType: AuditEventType;
    targetType: string;
    targetId?: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await recordAuditEvent(auditStore, {
      eventType: event.eventType,
      targetType: event.targetType,
      ...(event.targetId ? { targetId: event.targetId } : {}),
      ...(actor.id && actor.email && actor.email !== DEV_ACTOR_EMAIL
        ? { actorUserId: actor.id }
        : {}),
      payload: { actor: actor.email ?? actor.id, ...event.payload },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "template-audit-write-failed",
        eventType: event.eventType,
        error: String(error),
      }),
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Where the file came from, as the ledger records it.
 *
 * Narrowed rather than trusted: the column is plain text with a documented vocabulary, and an
 * unrecognised value reads as a paste, which is the shape that claims the least about provenance.
 */
function readSource(value: unknown): TemplateImportSource {
  return value === "file" || value === "gallery" ? value : "paste";
}

const REQUEST_KINDS: readonly TemplateRequestKind[] = [
  "mcp",
  "component",
  "endpoint",
];

/**
 * CHECKED AT RUNTIME, not only in the types. `kind` arrives in a path segment, so a type annotation
 * on it is a comment — the same reason `asGrantKind` exists in `plugins/routes.ts`.
 */
function asRequestKind(value: string | undefined): TemplateRequestKind | null {
  return REQUEST_KINDS.find((kind) => kind === value) ?? null;
}

/**
 * The key the importer typed, if they typed one.
 *
 * The header name is held to the same rule `parseAgentInput` holds it to, because this is a second
 * door into the same column and a template's `auth_header` is a stranger's suggestion. The value is
 * write-only from here on: it goes to the vault and is never read back to anybody.
 */
function readAuth(
  value: unknown,
): { header: string; value: string } | undefined | "invalid" {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return "invalid";
  const secret = typeof value.value === "string" ? value.value.trim() : "";
  if (!secret) return undefined;
  const header =
    typeof value.header === "string" && value.header.trim()
      ? value.header.trim()
      : "Authorization";
  if (!/^[A-Za-z0-9-]+$/.test(header)) return "invalid";
  return { header, value: secret };
}

const SLUG_RESOLUTIONS: readonly SlugResolution[] = ["reuse", "suffix", "skip"];

/** What the person chose about each colliding skill name, or nothing if they chose nothing. */
function readSlugDecisions(
  value: unknown,
): Record<string, SlugResolution> | undefined | "invalid" {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return "invalid";
  const decisions: Record<string, SlugResolution> = {};
  for (const [slug, resolution] of Object.entries(value)) {
    const chosen = SLUG_RESOLUTIONS.find((known) => known === resolution);
    if (!chosen) return "invalid";
    decisions[slug] = chosen;
  }
  return decisions;
}

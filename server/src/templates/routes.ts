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
 * connector, with nobody deciding. The call in `decide` below is the opposite of that in every
 * respect: it is behind `requireAdmin`, it acts on a ledger row a person already consented to, it
 * names a tool this file has just read out of `mcp_servers` and `mcp_tools`, and it is exactly the
 * act the grant screen performs. Scope the grep to the import path rather than to the directory, or
 * it will forbid the thing the feature is for.
 *
 * "IT NAMES A TOOL THAT EXISTS" USED TO BE A CLAIM RATHER THAN A CHECK, and that is the bug this
 * file was carrying. The only guard was that the ref contained a slash, so a ledger row recorded
 * `unavailable` — the row whose consent screen said "Nothing will be granted and nothing will be
 * written" and whose caption on the Bot's profile says there is nothing yet to grant — was one
 * administrator click away from a live `plugin_grants` row for a connector this deployment does not
 * have. Two guards now stand where the claim did, and both are needed: the ledger's own status,
 * because a person was told that ask was inert and connecting a server with that id afterwards is
 * not their consent; and a fresh read of the two tables, because the status is a snapshot from
 * resolve time and a connector can leave the deployment the day after an import.
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
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
import {
  ComponentNotFoundError,
  type ComponentStore,
} from "../components/store";
import {
  agents,
  mcpServers,
  mcpTools,
  templateBoundaries,
  templateImports,
  templateRequests,
} from "../db/schema";
import type { PluginStore } from "../plugins/store";
import {
  type CatalogueEntry,
  type CatalogueListing,
  type CatalogueSkip,
  CatalogueRefusedError,
  isTemplateInstallers,
  type TemplateCatalogue,
  type TemplateInstallers,
} from "./catalogue";
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
  /**
   * The gallery, and the setting that decides who may install out of it.
   *
   * Optional, and its absence is an EMPTY gallery rather than a missing route. A deployment built
   * without a catalogue still has an /agents/gallery screen and still has to say something on it,
   * and "no templates are shipped here" is a truthful answer where a 404 would read to the person
   * in front of it as the product being broken.
   *
   * `installerFloor` is the value `OPENBOT_TEMPLATE_INSTALLERS` set, carried alongside the catalogue
   * rather than asked of it. The catalogue holds the floor privately because its whole job is to
   * refuse a demotion below it; the admin screen needs to know the floor for a different reason —
   * to render the control disabled and say why, the `INITIAL_ADMIN_EMAILS` pattern. Both values come
   * off the same `config` field at the one call site that builds either, so they cannot disagree.
   */
  gallery?: {
    catalogue: TemplateCatalogue;
    installerFloor: TemplateInstallers;
  };
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
   * The gallery: what this deployment ships in the box, plus whatever a registered source holds.
   *
   * READ-ONLY, and there is deliberately no POST anywhere near it. Publishing a template is a git
   * push to a repository an administrator pinned, not a call somebody's browser makes — a write
   * endpoint here would be a hosted registry with none of the curation, moderation or takedown
   * machinery a hosted registry needs, growing out of a feature whose entire premise is that OpenBot
   * operates no such service.
   *
   * The listing is best effort by construction. One file that will not parse is a named skip beside
   * the templates that did, because a gallery that goes blank over one bad document teaches an
   * operator that the feature is unreliable rather than that one file is wrong.
   */
  routes.get("/gallery", requireUser, async (context) => {
    const gallery = deps.gallery;
    if (!gallery) {
      return context.json({ templates: [], skipped: [], installers: "anyone" });
    }
    const listing = await galleryListing(gallery.catalogue);
    return context.json({
      templates: listing.entries.map(galleryEntryDto),
      skipped: listing.skipped,
      /*
       * The setting travels with the list rather than being asked for separately, because the one
       * question the screen has about it is whether to draw the button — and a screen that drew the
       * button and learned the answer from a 403 would have taught somebody to press it first.
       */
      installers: gallery.catalogue.installers(),
    });
  });

  /**
   * One gallery template, as the document it is and as the file it came from.
   *
   * Both renderings go back on purpose. The parsed document is what the consent screen renders field
   * by field; the YAML is what goes in the paste box, so that what a person reads before agreeing is
   * a file they could have been sent by hand rather than a form this screen assembled for them.
   * `serializeBotTemplate` writes it out of the document this deployment parsed, so nothing a source
   * wrote outside the format — a comment, an ordering, a stray key the parser refused — reaches the
   * box.
   */
  routes.get("/gallery/:slug", requireUser, async (context) => {
    const gallery = deps.gallery;
    const entry = gallery
      ? await findGalleryEntry(gallery.catalogue, context.req.param("slug"))
      : null;
    if (!entry) {
      return context.json({ error: "There is no such template here." }, 404);
    }
    return context.json({
      entry: galleryEntryDto(entry),
      template: entry.document,
      digest: entry.digest,
      yaml: serializeBotTemplate(entry.document),
    });
  });

  /**
   * Every ceiling an import applied and has not retracted, across the deployment.
   *
   * Administrator only, because it names every Bot in the deployment and one row of it is enough to
   * tell a stranger which coworkers exist and which of them somebody bounded. It is a separate read
   * from `action_policy` for the reason the storage is separate: these clauses are composed into the
   * evaluation and are not in the array the Boundaries screen POSTs, precisely so an ordinary save
   * on that screen cannot erase them.
   *
   * The join is written here rather than added to the store because the row this answers with is not
   * an entity — it is a clause with the coworker's NAME on it, which is a rendering decision the
   * screen made, and the store has no business holding a projection built for one screen.
   */
  routes.get("/boundaries", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;

    /*
     * `removed_at IS NULL`, so a retracted clause does not appear on a screen about what is
     * enforced. What a retraction did belongs in Audit, which is where a history belongs.
     */
    const rows = await deps.executor
      .select({
        importId: templateBoundaries.importId,
        agentId: templateBoundaries.agentId,
        agentName: agents.name,
        expression: templateBoundaries.expression,
        sourceKey: templateBoundaries.sourceKey,
        appliedAt: templateBoundaries.appliedAt,
      })
      .from(templateBoundaries)
      .innerJoin(agents, eq(agents.id, templateBoundaries.agentId))
      .where(isNull(templateBoundaries.removedAt))
      .orderBy(templateBoundaries.appliedAt);
    return context.json({ boundaries: rows });
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
    const from = readSource(body?.from);
    const sourceRef =
      typeof body?.sourceRef === "string" ? body.sourceRef.trim() : "";
    if (!digest) {
      return context.json(
        { error: "A template and the digest you were shown are required." },
        400,
      );
    }

    /*
     * WHO MAY INSTALL AT ALL, asked before the document is even parsed.
     *
     * `installers: 'admin'` is the deployment saying that reading a stranger's file is fine but
     * turning one into a coworker is an administrator's act. It is checked here rather than by
     * mounting a different guard because the setting can change while this process runs, and a
     * guard captured at mount time would keep answering the question it was asked at boot.
     *
     * The preview above is deliberately NOT gated by it. Somebody who cannot install still has
     * every reason to read a template and hand the URL to somebody who can, and gating the read
     * would only mean the decision gets made from a screenshot.
     */
    if (deps.gallery?.catalogue.installers() === "admin") {
      const denied = requireAdmin(context);
      if (denied) return denied;
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

    /*
     * A GALLERY INSTALL IS READ FROM THE GALLERY, never from the body.
     *
     * The browser posts a slug and the digest it was shown; the document comes back out of the
     * catalogue on this side of the wire. Trusting a posted document would make `from: "gallery"` a
     * way to write "gallery" into the provenance column for a file that never was in one — and that
     * column is what an administrator reads on the Templates screen when deciding whether a coworker
     * came from somewhere the deployment vouches for. The digest still has to match, so a source
     * that moved between the consent screen and the button is a 409 exactly as a file that changed
     * on disk is.
     */
    let template: BotTemplate;
    if (from === "gallery") {
      const gallery = deps.gallery;
      const entry = gallery
        ? await findGalleryEntry(gallery.catalogue, sourceRef)
        : null;
      if (!entry) {
        return context.json({ error: "There is no such template here." }, 404);
      }
      template = entry.document;
    } else {
      if (!source.trim()) {
        return context.json(
          { error: "A template and the digest you were shown are required." },
          400,
        );
      }
      try {
        template = parseBotTemplate(source);
      } catch (error) {
        return refuse(context, error);
      }
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
        source: from,
        ...(sourceRef ? { sourceRef } : {}),
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
        /*
         * A bare connector id is an ask with nothing grantable behind it — the template named a
         * connector that listed no tools — and the answer to it is adding the connector, not writing
         * a grant. `store.grant` performs no existence check, so a row written here would be
         * invisible on every screen and would go live the day somebody added that connector.
         *
         * FIRST, ahead of the status check below, because it is the more specific thing to say about
         * the same row: a bare id always resolves `unavailable`, and telling somebody their ask was
         * not satisfiable would leave them looking for a tool that was never named.
         */
        if (kind === "mcp" && !ref.includes("/")) {
          return context.json(
            {
              error: `${ref} is a connector, not a tool. Add it on the Plugins page, then grant the tools this Bot needs.`,
            },
            400,
          );
        }

        /*
         * AN ASK THIS DEPLOYMENT COULD NOT SATISFY IS NOT AN ASK AN ADMINISTRATOR CAN ANSWER HERE,
         * and the reason is what the person was told rather than what the database holds. The
         * consent screen said of this row "Nothing will be granted and nothing will be written" and
         * the Bot's profile says there is nothing yet to grant; a button beside that sentence that
         * wrote a live grant would make both of those statements false. It stays refused even once
         * somebody connects a server with that id, because nobody has read a screen saying it would
         * grant anything — reinstalling the template is how that ask gets asked again.
         */
        if (row.status === "unavailable" || row.status === "not_in_build") {
          return context.json({ error: unsatisfiedAsk(kind, ref) }, 400);
        }

        if (kind === "mcp") {
          if (!deps.grants) {
            return context.json(
              {
                error:
                  "This deployment cannot reach its grant table, so nothing can be granted.",
              },
              503,
            );
          }
          /*
           * Read now rather than taken from `row.status`. That status is a snapshot from the moment
           * the plan was resolved, so a ref recorded `requested` while the connector was here is
           * still `requested` the week after somebody removed it — and `store.grant` performs no
           * existence check, so the grant would be a row invisible on every screen that comes back
           * to life on its own the day that id is connected again. Both tables, the pair
           * `resolve.ts` calls `available`: a connected server that has never been refreshed
           * advertises no tools, and a grant naming one of its refs is one `listForAgent` can never
           * resolve.
           */
          if (!(await mcpRefIsLive(deps.executor, ref))) {
            return context.json({ error: connectorMissing(ref) }, 400);
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
          try {
            await deps.components.grant(ref, agentId);
          } catch (error) {
            /*
             * The component half of the same snapshot problem, and it arrives as a throw rather than
             * as a false. `componentStore.grant` calls `requireComponent`, which raises for any name
             * absent from the build at this moment — including a row recorded `requested` whose
             * component has since left. Uncaught, that was an opaque 500 with no sentence, and
             * `decideRequest` never ran, so the row stayed undecided with nothing on the screen
             * saying why.
             */
            if (error instanceof ComponentNotFoundError) {
              return context.json({ error: componentMissing(ref) }, 400);
            }
            throw error;
          }
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
 * The deployment's own view of templates: what has been imported, who may import, and where the
 * gallery is allowed to read from.
 *
 * A SECOND ROUTER rather than more paths on the one above, mounted at `/api/admin/templates`, and
 * the split is the authorization rather than the tidiness. Everything here is `requireAdmin` on
 * every handler; everything above is `requireUser` with one delegated exception. Two prefixes make
 * that legible from the mount in `app.ts` — a reader can see which surface an administrator alone
 * reaches without reading a guard on each handler — and it means a route added here later inherits
 * the right neighbourhood rather than the wrong one.
 *
 * `requireAdmin` is still called INSIDE each handler rather than once as middleware, matching
 * `decide` above and `plugins/routes.ts`: the guard returns a response instead of throwing, so it
 * has to be returned from the handler that owns the request.
 */
export function createTemplateAdminRoutes(
  deps: TemplateRoutesDeps,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * The setting, the floor it cannot go below, and the sources the environment permits.
   *
   * All four in one answer, because they are one screen and three of them are only meaningful
   * beside each other: `installers` alone cannot tell an administrator why the control is disabled,
   * and a registered source alone cannot tell them why they may not register another.
   */
  routes.get("/settings", requireUser, (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const gallery = deps.gallery;
    if (!gallery) {
      return context.json({
        installers: "anyone",
        floor: "anyone",
        allowedSources: [],
        sources: [],
        configured: false,
      });
    }
    return context.json({
      installers: gallery.catalogue.installers(),
      floor: gallery.installerFloor,
      allowedSources: gallery.catalogue.allowedSources(),
      sources: gallery.catalogue.sources().map(sourceDto),
      configured: true,
    });
  });

  /**
   * Raise who may install, or fail and say what is still in force.
   *
   * REFUSES RATHER THAN COERCES. An unrecognised value is not read as the nearest thing it looks
   * like and it is not read as the default: a screen that sent `"Admin"` and got back `"anyone"`
   * would have quietly widened who may install a stranger's Bot, which is the exact opposite of
   * what whoever typed it meant. The refusal carries the value STILL IN FORCE, so the screen can
   * put the control back where it was rather than leaving it showing a choice nobody made.
   */
  routes.put("/settings", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const gallery = deps.gallery;
    if (!gallery) {
      return context.json(
        { error: "This deployment has no template gallery to configure." },
        503,
      );
    }

    const body = (await context.req.json().catch(() => null)) as {
      installers?: unknown;
    } | null;
    const wanted = typeof body?.installers === "string" ? body.installers : "";
    if (!isTemplateInstallers(wanted)) {
      return context.json(
        {
          error: "Who may install is either everybody or administrators only.",
          installers: gallery.catalogue.installers(),
        },
        400,
      );
    }

    try {
      return context.json({
        installers: gallery.catalogue.setInstallers(context.var.actor, wanted),
        floor: gallery.installerFloor,
      });
    } catch (error) {
      return refuseCatalogue(context, error, {
        installers: gallery.catalogue.installers(),
      });
    }
  });

  /**
   * Pin a repository the gallery may read from.
   *
   * The allowlist and the sha rule are both the catalogue's, and neither is restated here. What this
   * handler owns is that a refusal reaches the person as a sentence and a reason rather than as a
   * 500 — every one of `bad_handle`, `not_allowlisted` and `bad_ref` is somebody typing something,
   * and each of them needs a different correction.
   */
  routes.post("/sources", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const gallery = deps.gallery;
    if (!gallery) {
      return context.json(
        { error: "This deployment has no template gallery to configure." },
        503,
      );
    }

    const body = (await context.req.json().catch(() => null)) as {
      handle?: unknown;
      sha?: unknown;
    } | null;
    const handle = typeof body?.handle === "string" ? body.handle.trim() : "";
    const sha = typeof body?.sha === "string" ? body.sha.trim() : "";
    if (!handle || !sha) {
      return context.json(
        { error: "A repository and the commit to pin it to are required." },
        400,
      );
    }

    try {
      return context.json(
        {
          source: sourceDto(
            gallery.catalogue.registerSource(context.var.actor, {
              handle,
              sha,
            }),
          ),
        },
        201,
      );
    } catch (error) {
      return refuseCatalogue(context, error);
    }
  });

  /**
   * Forget a source, which is the whole of un-registering one.
   *
   * The id travels in the BODY rather than the path, and that is the id's shape rather than a
   * preference: a source is `owner/repo`, a slash is a path separator, and a percent-encoded one in
   * a DELETE path is the kind of thing a proxy in front of this deployment normalises without
   * telling anybody. Nothing already installed changes — an imported Bot is an ordinary Bot and no
   * longer refers to where its template came from.
   */
  routes.delete("/sources", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const gallery = deps.gallery;
    if (!gallery) {
      return context.json(
        { error: "This deployment has no template gallery to configure." },
        503,
      );
    }

    const body = (await context.req.json().catch(() => null)) as {
      id?: unknown;
    } | null;
    const id = typeof body?.id === "string" ? body.id.trim() : "";
    if (!id) {
      return context.json({ error: "A source is required." }, 400);
    }
    try {
      if (!gallery.catalogue.forgetSource(context.var.actor, id)) {
        return context.json({ error: "No such source is registered." }, 404);
      }
    } catch (error) {
      return refuseCatalogue(context, error);
    }
    return context.body(null, 204);
  });

  /**
   * Every Bot in this deployment that arrived as somebody's file, with what it asked for and the
   * ceiling it is under.
   *
   * The document is deliberately NOT in it. A roster where every row carries a whole template makes
   * opening the page cost as much as opening every file on it, which is the judgement `draftDto`
   * makes for drafts; the Bot's own page is where one import is read in full.
   *
   * Three queries rather than one join or one per row. A join would multiply each import by its
   * requests and its clauses and leave this file un-multiplying them; a read per import is an N+1
   * on a page that lists the whole deployment. Selecting the two child tables by the ids just read
   * and grouping in memory is neither, and it needs no projection this file would have to keep in
   * step with the store's.
   */
  routes.get("/imports", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;

    const rows = await deps.executor
      .select({
        id: templateImports.id,
        agentId: templateImports.agentId,
        agentName: agents.name,
        digest: templateImports.digest,
        slug: templateImports.slug,
        templateVersion: templateImports.templateVersion,
        authorClaim: templateImports.authorClaim,
        source: templateImports.source,
        sourceRef: templateImports.sourceRef,
        importedBy: templateImports.importedBy,
        importedAt: templateImports.importedAt,
      })
      .from(templateImports)
      .innerJoin(agents, eq(agents.id, templateImports.agentId))
      .orderBy(desc(templateImports.importedAt));

    if (rows.length === 0) return context.json({ imports: [] });

    const ids = rows.map((row) => row.id);
    const [requests, boundaries] = await Promise.all([
      deps.executor
        .select()
        .from(templateRequests)
        .where(inArray(templateRequests.importId, ids)),
      deps.executor
        .select()
        .from(templateBoundaries)
        .where(
          and(
            inArray(templateBoundaries.importId, ids),
            // In force, not "was once applied". See the /boundaries read above.
            isNull(templateBoundaries.removedAt),
          ),
        ),
    ]);

    return context.json({
      imports: rows.map((row) => ({
        ...row,
        requests: requests.filter((request) => request.importId === row.id),
        boundaries: boundaries.filter(
          (boundary) => boundary.importId === row.id,
        ),
      })),
    });
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
 * The whole gallery, in-box first and then every registered source, with one slug per entry.
 *
 * FIRST TAKER KEEPS THE SLUG, and the directory is asked first, so a source cannot shadow a
 * template that ships in the image by naming a file the same thing. The loser is not dropped
 * silently: it becomes a skip carrying both sides, because an operator who pinned a repository and
 * cannot find one of its templates needs to be told it collided rather than left to conclude the
 * pin is wrong.
 *
 * ONE FUNCTION FOR THE LIST AND THE LOOKUP. `findGalleryEntry` reads through this rather than
 * asking the catalogue directly, so the entry that installs is by construction the entry that was
 * listed — a lookup with its own precedence rule would eventually disagree with the list somebody
 * chose from, and the thing they chose from is the thing they consented to.
 */
async function galleryListing(
  catalogue: TemplateCatalogue,
): Promise<CatalogueListing> {
  const entries: CatalogueEntry[] = [];
  const skipped: CatalogueSkip[] = [];
  const claimed = new Map<string, CatalogueEntry>();

  const take = (listing: CatalogueListing, where: string) => {
    skipped.push(...listing.skipped);
    for (const entry of listing.entries) {
      const held = claimed.get(entry.slug);
      if (held) {
        skipped.push({
          where,
          reason: "duplicate_slug",
          message: `${entry.slug} is already offered by ${describeOrigin(held.origin)}, so this copy is not listed.`,
        });
        continue;
      }
      claimed.set(entry.slug, entry);
      entries.push(entry);
    }
  };

  take(await catalogue.directory(), "directory");
  for (const source of catalogue.sources()) {
    try {
      take(await catalogue.fromSource(source.id), source.id);
    } catch (error) {
      /*
       * EVERY failure, not only the catalogue's own refusals. A source is a third-party host over a
       * network, so the ways this call ends badly include a DNS failure, a timeout and a proxy
       * returning something that is not a response at all — and none of those is a reason for a
       * deployment's in-box templates to vanish from the screen. The source is named in the skip, so
       * a gallery that is quietly short of one repository says which one.
       */
      skipped.push({
        where: source.id,
        reason: "source_unreadable",
        message:
          error instanceof CatalogueRefusedError
            ? error.message
            : `${source.id} could not be read at its pinned commit.`,
      });
    }
  }
  return { entries, skipped };
}

/** One gallery template by its slug, through the same precedence the list was built with. */
async function findGalleryEntry(
  catalogue: TemplateCatalogue,
  slug: string,
): Promise<CatalogueEntry | null> {
  if (!slug) return null;
  const listing = await galleryListing(catalogue);
  return listing.entries.find((entry) => entry.slug === slug) ?? null;
}

/** Where a template came from, in a sentence, for a skip that has to name two of them. */
function describeOrigin(origin: CatalogueEntry["origin"]): string {
  return origin.kind === "directory"
    ? `the templates shipped here (${origin.filename})`
    : `${origin.sourceId} (${origin.path})`;
}

/**
 * A gallery entry as the roster shows it.
 *
 * The document is not in it, and neither is a single line of the author's prose: the summary is one
 * sentence the format caps, and `role_description` and every skill's `instructions` are read on the
 * consent screen where they are rendered verbatim under a heading saying whose words they are. A
 * card is where somebody decides whether to open a template, not where they decide to run it.
 *
 * `author` and `source` are CLAIMS and are named as such all the way down. Nothing on this side
 * verifies either, nothing decides anything from either, and the screen renders both as plain text.
 */
function galleryEntryDto(entry: CatalogueEntry) {
  const document = entry.document;
  return {
    slug: entry.slug,
    digest: entry.digest,
    name: document.bot.name,
    title: document.bot.title,
    summary: document.template.summary,
    /*
     * The drawing the coworker will actually have, so a card previews what importing produces.
     *
     * `boring-avatars` hashes this into a figure, which is why the same seed is the same picture on
     * every deployment and why a gallery of otherwise identical cards becomes scannable. It is an
     * opaque style token and never an id: the parser holds it to the slug rule, nothing resolves it,
     * and falling back to the template's own slug means a template that omitted one still draws
     * something stable rather than everything drawing the same thing.
     */
    avatarSeed: document.bot.avatarSeed ?? entry.slug,
    author: document.template.author ?? null,
    version: document.template.version ?? null,
    license: document.template.license ?? null,
    source: document.template.source ?? null,
    runtime: document.bot.runtime,
    /*
     * What the template ASKS FOR, which is not what it gets. These ids are the interesting half of
     * a gallery card — a coworker that wants a connector this deployment does not have is worth
     * knowing about before opening it — and they are inert here exactly as they are everywhere else.
     */
    connectors: document.requests.connectors.map((connector) => connector.id),
    components: document.requests.components.map((component) => component.name),
    skills: document.skills.map((skill) => skill.slug),
    origin: entry.origin,
  };
}

/** A registered source on the wire. The pin is the whole of it; there is nothing secret in a pin. */
function sourceDto(source: {
  id: string;
  owner: string;
  repo: string;
  sha: string;
  registeredBy: string;
  registeredAt: Date;
}) {
  return { ...source };
}

/**
 * A catalogue refusal as a status and a sentence.
 *
 * `not_admin` is 403 and everything else is 400, because they are two different answers: one says
 * the person may not do this at all, and the rest say the thing they typed is wrong. The extras are
 * merged in so a failed setting write can carry the value still in force.
 */
function refuseCatalogue(
  context: Context<{ Variables: AppVariables }>,
  error: unknown,
  extra: Record<string, unknown> = {},
): Response {
  if (!(error instanceof CatalogueRefusedError)) throw error;
  return context.json(
    { error: error.message, reason: error.reason, ...extra },
    error.reason === "not_admin" ? 403 : 400,
  );
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
 * What an administrator is told when the ledger already says this deployment could not satisfy an
 * ask. Written in the past tense on purpose: it is a fact about the moment the plan was resolved,
 * and it stays true even on a deployment that has since connected the thing.
 */
function unsatisfiedAsk(kind: TemplateRequestKind, ref: string): string {
  /*
   * The component half is `componentMissing` rather than its own copy of the sentence. The two
   * refusals answer the same question a snapshot apart — one from the ledger, one from the throw the
   * store raises a moment later — and a reader who saw them worded differently would go looking for
   * a difference that is not there.
   */
  return kind === "mcp"
    ? `${ref} was not connected here when this template was read, so nothing was going to be granted for it. Add it on the Plugins page, then grant the tools this Bot needs there.`
    : componentMissing(ref);
}

/** The bare-connector sentence, for a ref that names a tool this deployment does not have either. */
function connectorMissing(ref: string): string {
  return `${ref} is not connected on this deployment. Add it on the Plugins page, then grant the tools this Bot needs.`;
}

/** The same refusal for a component name no build here answers to. */
function componentMissing(ref: string): string {
  return `There is no component called ${ref} in this build, so there is nothing to grant.`;
}

/**
 * Whether this ref names a tool that exists on this deployment RIGHT NOW.
 *
 * A read of two tables rather than a call into the resolver, because the resolver answers about a
 * whole document and this question is about one row somebody is about to act on. Split on the FIRST
 * slash, matching how `resolve.ts` takes a ref apart and how `plugins/store.ts` matches a grant
 * against `serverId/toolName`; a second copy that split on the last one would disagree with both.
 */
async function mcpRefIsLive(
  executor: TemplateReadExecutor,
  ref: string,
): Promise<boolean> {
  const separator = ref.indexOf("/");
  if (separator <= 0) return false;
  const serverId = ref.slice(0, separator);
  const toolName = ref.slice(separator + 1);
  if (!toolName) return false;

  const [server] = await executor
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId))
    .limit(1);
  if (!server) return false;

  const [tool] = await executor
    .select({ name: mcpTools.name })
    .from(mcpTools)
    .where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)))
    .limit(1);
  return tool !== undefined;
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

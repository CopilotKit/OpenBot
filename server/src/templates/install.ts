/**
 * Turning a template somebody consented to into an ordinary Bot, in one act.
 *
 * ONE TRANSACTION IS THE WHOLE POINT OF THIS FILE. An import is a Bot, its skills, the grants that
 * pair them, a provenance row and a ledger — five writes across three stores — and either all of
 * them happened or none did. Without that, a failure partway leaves an orphan Bot holding half a
 * skill set, the person presses import again, and the deployment now has two coworkers with the same
 * name and no way to tell which one is the wreckage. `pluginStore.installSkill` and
 * `pluginStore.grant` take the executor for exactly this, and the profile store is built over the
 * transaction rather than the pool for the same reason.
 *
 * CONFIGURATION TRAVELS; CAPABILITY DOES NOT. There is no code path here that writes a
 * `plugin_grants` row with kind `mcp` — not a conditional one, not one behind a flag. The one grant
 * an import makes is the Bot-to-skill pairing, which is what switches per-run narrowing on and
 * confers nothing by itself. Everything else a template asked for lands in `template_requests` as an
 * ask, and is satisfied later by an administrator on a screen that already refuses. `store.grant`
 * performs no existence check and `listServers` computes `withdrawn` only for servers that exist, so
 * an optimistic grant for an absent connector would be invisible on every screen and would go live
 * the day somebody added that connector, with nobody deciding.
 *
 * NOTHING THE CLIENT PARSED IS TRUSTED. The document is serialised and parsed again here, so the
 * refusals that ran at preview run again at install; the digest is recomputed and a move is refused,
 * which closes the window where a gallery file or a pasted buffer changes between the screen a
 * person read and the button they pressed; and the plan is resolved again on this transaction rather
 * than taken from the preview, because a preview is a screen somebody read and not evidence about
 * the database a second later.
 */
import { and, eq } from "drizzle-orm";
import {
  type BotTemplate,
  botTemplateDigest,
  parseBotTemplate,
  serializeBotTemplate,
  templateGrantMark,
} from "../../../shared/bot-template";
import { checkAgentEndpoint } from "../agents/endpoint";
import { createAgentProfileStore } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import {
  type AuditEventType,
  type AuditStore,
  recordAuditEvent,
} from "../audit";
import { announceActionPolicyChange } from "../computer/policy-store";
import type { CredentialStore } from "../credentials";
import type { Database } from "../db/client";
import { agentProfiles, pluginGrants, skills } from "../db/schema";
import type { PluginStore } from "../plugins/store";
import { compileBoundary } from "./boundary";
import {
  MAX_SUFFIX,
  resolveBotTemplate,
  type SlugResolution,
  suffixedSlug,
  type TemplatePlan,
} from "./resolve";
import type {
  TemplateBoundaryRow,
  TemplateExecutor,
  TemplateImportRow,
  TemplateImportSource,
  TemplateRequestRow,
  TemplateRequestSeed,
  TemplateStore,
} from "./store";

/**
 * The local development actor, which is not a row in `users`.
 *
 * The audit table has a foreign key to that table, so writing this id there fails the constraint and
 * loses the entire row. Who it was goes in the payload either way — the convention
 * `agents/routes.ts:123-129` already follows.
 */
const DEV_ACTOR_EMAIL = "dev@openbot.local";

export type TemplateActor = AgentActor & { email?: string };

export type InstallBotTemplateInput = {
  /** The parsed document. Re-serialised and re-parsed here rather than believed. */
  template: BotTemplate;
  /** What the consent screen showed. A mismatch is refused rather than reconciled. */
  digest: string;
  actor: TemplateActor;
  source: TemplateImportSource;
  sourceRef?: string;
  /**
   * The address the importer typed, when the plan asked for one.
   *
   * Never from the file — the format has no url field — and re-checked here against this
   * deployment's allowlist rather than trusted from the route, because a caller that forgot is a
   * caller that registered an SSRF target.
   */
  endpoint?: string;
  /** The key the importer typed, header name and value. The value goes to the vault and nowhere else. */
  auth?: { header: string; value: string };
  /** What to do about each colliding skill slug, keyed by the slug the TEMPLATE names. */
  slugDecisions?: Record<string, SlugResolution>;
};

export type InstallBotTemplateResult = {
  agentId: string;
  imported: TemplateImportRow;
  ledger: TemplateRequestRow[];
  /** The plan as it was resolved server-side, which may differ from the preview the person saw. */
  plan: TemplatePlan;
  /** The ceiling this import put on the Bot, as it was written. Empty when the file asked for none. */
  boundaries: TemplateBoundaryRow[];
  skillsCreated: string[];
  skillsReused: string[];
  skillsSuffixed: string[];
  skillsSkipped: string[];
};

export type RetractTemplateImportInput = {
  actor: TemplateActor;
  agentId: string;
};

export type RetractTemplateImportResult = {
  agentId: string;
  importId: string;
  /** Exactly the grants this import made, and nothing an administrator made by hand. */
  revoked: { kind: string; ref: string }[];
  /** The compiled clauses that stopped applying. */
  boundaries: string[];
};

/**
 * The file moved between the screen and the click.
 *
 * A distinguishable type because the route turns it into a 409 rather than a 400: nothing is wrong
 * with the document, and the honest thing to tell the person is that what they are about to install
 * is not what they read.
 */
export class TemplateDigestMovedError extends Error {
  readonly expected: string;
  readonly actual: string;
  constructor(expected: string, actual: string) {
    super(
      "This template has changed since you read it. Look at it again before installing.",
    );
    this.name = "TemplateDigestMovedError";
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * A coworker that lives somewhere else, with nobody having said where.
 *
 * Only `runtime: remote` reaches this. A `managed` template runs on this deployment whether or not
 * there is a Bot in the box, so the absence of one is no longer a reason to ask anybody for an
 * address.
 */
export class TemplateEndpointRequiredError extends Error {
  constructor() {
    super(
      "This template's coworker runs somewhere else. Type the address it runs at.",
    );
    this.name = "TemplateEndpointRequiredError";
  }
}

/** An address this deployment will not dial, named so the person typing it sees which one. */
export class TemplateEndpointRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TemplateEndpointRefusedError";
  }
}

/**
 * A key with nowhere safe to put it.
 *
 * Refused rather than dropped. `store.create` only writes an agent's key when a vault was
 * configured, so without this the import would succeed, report success, and produce a Bot that
 * silently authenticates with nothing — which is the failure people spend an afternoon on.
 */
export class TemplateVaultUnavailableError extends Error {
  constructor() {
    super(
      "This deployment has no vault, so a coworker's key cannot be stored. Import it without a key.",
    );
    this.name = "TemplateVaultUnavailableError";
  }
}

/**
 * A decision that no longer describes the deployment.
 *
 * `reuse` means "the skill already here is the same skill", and that has to be true at the moment of
 * writing rather than at the moment of the preview. If somebody edited that skill in between, quietly
 * pairing the Bot to it anyway would give an imported coworker instructions nobody consented to, and
 * quietly suffixing instead would give them a skill they thought they were reusing. Refused, so the
 * person reads the plan again.
 */
export class TemplateSlugDecisionError extends Error {
  readonly slug: string;
  constructor(slug: string, message: string) {
    super(message);
    this.name = "TemplateSlugDecisionError";
    this.slug = slug;
  }
}

/** No free name left for a skill this template ships. */
export class TemplateSlugUnavailableError extends Error {
  readonly slug: string;
  constructor(slug: string) {
    super(
      `Every name near "${slug}" is taken on this deployment. Skip that skill or free a name.`,
    );
    this.name = "TemplateSlugUnavailableError";
    this.slug = slug;
  }
}

export class TemplateImportNotFoundError extends Error {
  readonly agentId: string;
  constructor(agentId: string) {
    super(`No template import is recorded for ${agentId}.`);
    this.name = "TemplateImportNotFoundError";
    this.agentId = agentId;
  }
}

/** Retraction is the owner's or an administrator's. Nobody else's. */
export class TemplateRetractionRefusedError extends Error {
  readonly agentId: string;
  constructor(agentId: string) {
    super(
      `Only the owner of ${agentId} or an administrator may retract its import.`,
    );
    this.name = "TemplateRetractionRefusedError";
    this.agentId = agentId;
  }
}

export type TemplateInstallerDeps = {
  database: Database;
  templateStore: TemplateStore;
  /** Only these two, and both of them take this module's transaction. */
  pluginStore: Pick<PluginStore, "installSkill" | "grant">;
  auditStore: AuditStore;
  /**
   * The Bot in the box, if this deployment has one. `config.managedAgent?.endpoint`.
   *
   * Absent is the recommended one-container image, and there it decides which process answers a
   * `managed` template rather than whether the import can happen at all: with one the coworker is
   * bound to that address, without one it is created `built_in` on the role description the file
   * carries. Either way the importer is asked for nothing.
   */
  managedAgentAgUiUrl?: URL;
  vault?: { store: CredentialStore; encryptionKey: string };
  /**
   * What this deployment will let a coworker live at, checked here as well as at the route.
   *
   * Defaulted to the strictest reading — no private hosts, no named ones — because the failure mode
   * of forgetting to pass it is a registered SSRF target, and the failure mode of passing it too
   * strictly is a refusal somebody can read.
   */
  endpointPolicy?: {
    allowPrivateHosts?: boolean;
    allowedHosts?: ReadonlySet<string>;
  };
};

export type TemplateInstaller = {
  installBotTemplate(
    input: InstallBotTemplateInput,
  ): Promise<InstallBotTemplateResult>;
  retractTemplateImport(
    input: RetractTemplateImportInput,
  ): Promise<RetractTemplateImportResult>;
};

export function createTemplateInstaller(
  deps: TemplateInstallerDeps,
): TemplateInstaller {
  const {
    database,
    templateStore,
    pluginStore,
    auditStore,
    managedAgentAgUiUrl,
    vault,
  } = deps;
  const endpointPolicy = deps.endpointPolicy ?? {};

  /**
   * A trail row, never fatal.
   *
   * The change is already committed and the caller has been told so; a trail that is briefly
   * unavailable is not a reason to report a failure that did not happen. The same judgement
   * `agents/routes.ts` makes for `bot.created`, and it matters more here because a partial audit is
   * still readable while a thrown error after a commit is a lie.
   */
  const record = async (
    eventType: AuditEventType,
    actor: TemplateActor,
    agentId: string,
    payload: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await recordAuditEvent(auditStore, {
        eventType,
        targetType: "agent",
        targetId: agentId,
        ...(actor.id && actor.email && actor.email !== DEV_ACTOR_EMAIL
          ? { actorUserId: actor.id }
          : {}),
        payload: { bot: agentId, actor: actor.email ?? actor.id, ...payload },
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "template-audit-write-failed",
          eventType,
          agentId,
          error: String(error),
        }),
      );
    }
  };

  /**
   * Take a slug, or find out somebody else already has.
   *
   * THE UNIQUE INDEX DECIDES, NOT A READ. `installSkill` upserts on `skills.slug`, so handing it a
   * name that was free when the plan was resolved and taken by the time it runs would silently
   * rewrite somebody's `/` command with a stranger's instructions — the one outcome this whole
   * feature may never produce. A read-then-write cannot close that: the gap is the bug. So the row
   * is claimed first with `on conflict do nothing`, and an empty result means the name is not ours.
   *
   * The claim writes the real values rather than a placeholder, and `installSkill` then upserts the
   * same row a moment later, taking its conflict branch and leaving `owner_user_id`, `origin` and
   * `installed_by` exactly as claimed while it writes the declarations and the trail. Duplicating
   * the insert is the price of letting the constraint be the arbiter, and it is a smaller price than
   * a lost `/` command.
   */
  async function claimSlug(
    executor: TemplateExecutor,
    slug: string,
    values: {
      ownerUserId: string;
      title: string;
      summary: string;
      instructions: string;
      installedBy: string;
    },
  ): Promise<boolean> {
    const claimed = await executor
      .insert(skills)
      .values({
        id: slug,
        slug,
        ownerUserId: values.ownerUserId,
        title: values.title,
        summary: values.summary,
        instructions: values.instructions,
        origin: "template",
        installedBy: values.installedBy,
      })
      .onConflictDoNothing({ target: skills.slug })
      .returning({ slug: skills.slug });
    return claimed.length > 0;
  }

  /**
   * Who owns the skill already sitting on a slug, or `undefined` when nothing does.
   *
   * Null is a real answer and a different one from absent: a skill with no owner belongs to the
   * deployment, which is exactly the case the grant route singles out. Read on the install
   * transaction, so the answer is about the database being written rather than the one the preview
   * saw.
   */
  async function skillOwner(
    executor: TemplateExecutor,
    slug: string,
  ): Promise<string | null | undefined> {
    const [row] = await executor
      .select({ ownerUserId: skills.ownerUserId })
      .from(skills)
      .where(eq(skills.slug, slug))
      .limit(1);
    return row?.ownerUserId;
  }

  return {
    async installBotTemplate(input) {
      /*
       * Re-parsed from its own serialisation, not read from the object the caller handed over. The
       * client's parse decided what a person was shown; this one decides what is written, and the
       * two must be the same function run twice rather than one run trusted twice.
       */
      const template = parseBotTemplate(serializeBotTemplate(input.template));
      const digest = await botTemplateDigest(template);
      if (digest !== input.digest) {
        throw new TemplateDigestMovedError(input.digest, digest);
      }

      const actor = input.actor;
      /*
       * An email where there is one, and the actor id where there is not. `imported_by` and
       * `installed_by` are trails rather than foreign keys, and under `OPENBOT_SINGLE_USER` there is
       * frequently no `users` row worth naming.
       */
      const actorLabel = actor.email ?? actor.id;
      const mark = templateGrantMark(digest);

      if (input.auth && !vault) throw new TemplateVaultUnavailableError();
      if (input.auth && !/^[A-Za-z0-9-]+$/.test(input.auth.header)) {
        throw new TemplateEndpointRefusedError(
          "That is not a valid header name.",
        );
      }

      /*
       * The same rule `resolve.ts` applies, restated here because this module is callable without
       * going through a preview and the two must not be able to disagree about who gets asked.
       */
      const endpointRequired = template.bot.runtime === "remote";
      if (endpointRequired && !input.endpoint?.trim()) {
        throw new TemplateEndpointRequiredError();
      }

      /*
       * Checked here even though the route checks it too. The rule this enforces is that a URL which
       * must never be fetched never reaches the database, and a second caller of this module — a
       * gallery installer, a CLI, a test — is exactly how the first check gets skipped.
       */
      let endpoint: string | undefined;
      if (input.endpoint?.trim()) {
        const verdict = checkAgentEndpoint(
          input.endpoint.trim(),
          endpointPolicy,
        );
        if (!verdict.allowed) {
          throw new TemplateEndpointRefusedError(verdict.reason);
        }
        endpoint = verdict.url;
      }

      const outcome = await database.transaction(
        async (transaction) => {
          /*
           * The profile store, built over this transaction rather than the pool.
           *
           * The cast is the same one `work/queue.ts:217` makes and for the same reason: a drizzle
           * transaction is a database handle for every purpose this store has — its own
           * `transaction` call opens a savepoint inside ours — but the two are not the same
           * nominal type. Going through the store rather than writing `agents` and `agent_profiles`
           * here is what keeps the vault write, the endpoint handling and the id minting identical
           * to what `POST /api/agents` does, so an imported Bot is an ordinary Bot in the only sense
           * that matters: the same code made it.
           */
          const profileStore = createAgentProfileStore(
            transaction as unknown as Database,
            managedAgentAgUiUrl,
            vault,
          );

          const profile = await profileStore.create(actor, {
            name: template.bot.name,
            title: template.bot.title,
            roleDescription: template.bot.roleDescription,
            // Forced, both of them. Ownership and visibility are facts about this deployment, and a
            // template has no field that could carry either. Making it public is an ordinary later
            // PATCH the owner makes on a Bot they can already see.
            visibility: "private",
            ...(endpoint ? { endpoint } : {}),
            ...(input.auth ? { auth: input.auth } : {}),
            /*
             * THE SAME TEXT, USED THE SAME WAY. A `managed` template with no Bot in the box and no
             * address is created `built_in` on its own `role_description` — which is already handed
             * to a model as the standing instruction for a remote coworker, and already rendered
             * verbatim on the consent screen under a heading saying a stranger wrote it. So nothing
             * new is exposed, and the outcome is the safer one: the alternative was pushing somebody
             * to register a third-party endpoint to try a template, after which their conversations
             * leave the network.
             *
             * Passed only for `managed`. A `remote` template has already been refused above without
             * an address, and handing `create` a prompt there would give a stranger's file a second
             * way to land — quietly in-process, on a document that said it runs somewhere else.
             */
            ...(template.bot.runtime === "managed"
              ? { systemPrompt: template.bot.roleDescription }
              : {}),
          });
          const agentId = profile.id;

          /*
           * The face the consent screen drew.
           *
           * `create` hardcodes the seed to the agent id, so an imported coworker used to arrive
           * looking nothing like the avatar the person had just looked at one click earlier — and
           * because `newAgentId` mints `agent_<uuid>`, which is not a slug, the seed could not even
           * travel back out on a re-export. A style token is one of the few things a template
           * legitimately carries, and there is no route that can repair it afterwards, so it is
           * written here inside the same transaction rather than left to a later PATCH that does not
           * exist. `POST /api/agents` is untouched: a hand-made Bot still gets its id.
           */
          if (template.bot.avatarSeed) {
            await transaction
              .update(agentProfiles)
              .set({ avatarSeed: template.bot.avatarSeed })
              .where(eq(agentProfiles.agentId, agentId));
          }

          /*
           * Resolved again, on this transaction. The preview read a database that has since had a
           * skill added to it, a connector connected, or a component published, and the decisions
           * below are about the one being written.
           */
          const plan = await resolveBotTemplate(transaction, template, {
            managedAgent: Boolean(managedAgentAgUiUrl),
            digest,
          });

          const decisions = input.slugDecisions ?? {};
          const skillsCreated: string[] = [];
          const skillsReused: string[] = [];
          const skillsSuffixed: string[] = [];
          const skillsSkipped: string[] = [];
          /** The slug each template skill actually ended up as, for the pairing below. */
          const installedAs = new Map<string, string>();

          for (const skill of template.skills) {
            const resolved = plan.skills.find(
              (entry) => entry.slug === skill.slug,
            );
            /* Every template skill is in the plan; this is a type narrowing, not a case. */
            if (!resolved) continue;

            const asked = decisions[skill.slug];
            /*
             * The importer's decision only governs a slug that actually collides. A free name has
             * nothing to reuse and nothing to suffix, so the only decision worth honouring there is
             * skipping the skill entirely.
             */
            let decision: SlugResolution = resolved.collides
              ? (asked ?? resolved.resolution)
              : asked === "skip"
                ? "skip"
                : "suffix";

            if (decision === "reuse") {
              if (!resolved.identical) {
                throw new TemplateSlugDecisionError(
                  skill.slug,
                  `The skill already called "${skill.slug}" here is not the one this template ships, so it cannot be reused. Read the plan again.`,
                );
              }
              /*
               * AN IMPORT MAY NOT PAIR A BOT TO A SKILL ITS OWNER COULD NOT PAIR BY HAND.
               *
               * `POST /api/plugins/grants` refuses a non-admin the skills they do not own —
               * "belongs to this deployment. An administrator decides which Bots use it", and "is
               * somebody else's skill" — and this handler is only permitted to `requireUser`
               * because its write set is a subset of what those routes already allow. Reuse was the
               * hole: the text of every skill a tenant package seeds is on the Skills page, so
               * anybody could ship a byte-identical copy, get `identical: true`, and have the import
               * pair their Bot to the deployment's own row under a `granted_by` of
               * `template:<digest>` rather than a person. The instructions were the ones they
               * consented to that day; the point is the day after, when an administrator edits that
               * row and the Bot follows it with nobody deciding.
               *
               * Suffixed instead of refused. The two skills are byte-identical, so a private copy
               * says exactly what the consent screen said, and the import degrades rather than
               * blocks — which is the rule everywhere else on this path.
               */
              const owner = await skillOwner(transaction, skill.slug);
              if (actor.role !== "admin" && owner !== actor.id) {
                decision = "suffix";
              }
            }

            if (decision === "skip") {
              skillsSkipped.push(skill.slug);
              continue;
            }

            if (decision === "reuse") {
              // Nothing is written. The skill already here is paired to the Bot as it stands, which
              // is what reuse means and why it is the default when the two are identical.
              installedAs.set(skill.slug, skill.slug);
              skillsReused.push(skill.slug);
              continue;
            }

            /*
             * `installAs` is what the plan would do on its own, and it names the colliding slug when
             * the plan said reuse. An importer who overrode reuse to suffix is asking for the other
             * name, so the suffix candidate is taken directly rather than letting the claim below
             * discover the collision and walk to it — which would work, and would make the reason a
             * name was chosen unreadable from the code.
             */
            const wanted = resolved.collides
              ? resolved.suffixCandidate
              : resolved.installAs;
            if (!wanted) throw new TemplateSlugUnavailableError(skill.slug);

            const values = {
              ownerUserId: actor.id,
              title: skill.title,
              summary: skill.summary,
              instructions: skill.instructions,
              installedBy: actorLabel,
            };
            let written: string | null = null;
            if (await claimSlug(transaction, wanted, values)) {
              written = wanted;
            } else {
              /*
               * Somebody took the name between the plan and the claim — another import in flight, or
               * the Skills page. Walk on rather than fail: the constraint has already told us the
               * truth, and the next free suffix is as good a name as the one we asked for.
               */
              for (let index = 2; index <= MAX_SUFFIX; index += 1) {
                const candidate = suffixedSlug(skill.slug, index);
                if (!candidate) continue;
                if (await claimSlug(transaction, candidate, values)) {
                  written = candidate;
                  break;
                }
              }
            }
            if (!written) throw new TemplateSlugUnavailableError(skill.slug);

            await pluginStore.installSkill(
              {
                slug: written,
                title: skill.title,
                summary: skill.summary,
                instructions: skill.instructions,
                // The importer's own, as `duplicate` already makes a forked Bot theirs. The source
                // deployment's owner, installer and declarer are identities that mean nothing here.
                ownerUserId: actor.id,
                origin: "template",
                tools: skill.tools,
                /*
                 * A template names the connectors its author had, so every template naming
                 * `google-drive/search_files` would fail to install on every deployment that has not
                 * connected Drive — which is every fresh one. A declaration grants nothing; the
                 * run-time offer is granted ∩ declared, so an unknown ref is inert.
                 */
                allowUnknownTools: true,
                by: actorLabel,
              },
              transaction,
            );
            installedAs.set(skill.slug, written);
            // Disjoint lists, so a reader of the trail can count them. A skill written under the
            // name the template asked for is created; one written under another name is suffixed,
            // and the name it took is the interesting half of that.
            if (written === skill.slug) skillsCreated.push(written);
            else skillsSuffixed.push(written);
          }

          /*
           * The one grant an import makes.
           *
           * Without it the Bot boots with skills attached to nobody and per-run narrowing never
           * switches on — the skills exist, the Bot cannot see them, and nothing anywhere says so.
           * Marked with the digest so a retraction takes back exactly this, and leaves an
           * administrator's own grant on the same Bot untouched.
           */
          for (const slug of template.bot.skills) {
            const written = installedAs.get(slug);
            if (!written) continue;
            await pluginStore.grant(
              "skill",
              written,
              agentId,
              mark,
              transaction,
            );
          }

          const imported = await templateStore.recordImport(
            {
              agentId,
              digest,
              slug: template.template.slug,
              ...(template.template.version
                ? { templateVersion: template.template.version }
                : {}),
              ...(template.template.author
                ? { authorClaim: template.template.author }
                : {}),
              source: input.source,
              ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
              document: template,
              importedBy: actorLabel,
            },
            transaction,
          );

          /*
           * The author's ceiling, compiled here and stored apart from the deployment's own policy.
           *
           * Inside the transaction because it is part of the same act: a Bot that exists without the
           * ceiling its file described, even for the moment between two commits, is a Bot running
           * looser than the screen the person read. `compileBoundary` refuses a clause that would not
           * behave like a rule and `recordBoundaries` refuses it again at the column, and either
           * refusal reaches here as a throw that rolls the whole import back. That is the direction
           * to fail in: no Bot at all, rather than a Bot whose ceiling nobody could write down.
           *
           * NEVER `action_policy.deny`. That is one row for the whole deployment, replaced wholesale
           * by the next administrator who saves the Boundaries screen, so a clause put there would be
           * erased by an unrelated save and this Bot would quietly come uncaged. The clauses go in
           * `template_boundaries`, which `policyStore.get()` composes in for evaluation and which a
           * retraction can retire in one act.
           */
          const boundaries = await templateStore.recordBoundaries(
            compileBoundary(agentId, template.boundary).map((clause) => ({
              importId: imported.id,
              ...clause,
            })),
            transaction,
          );
          /*
           * Every server re-reads, this one included.
           *
           * The clauses are held in memory on each server and refreshed on an announcement, because
           * the policy is asked on every single action and a query there would be a query per
           * keystroke. Without this the new ceiling would apply from the next restart onwards, which
           * is the fleet-wide version of a boundary that looks like it works. Issued on this
           * transaction so it is delivered on commit: an import that rolls back announces nothing.
           */
          if (boundaries.length > 0) {
            await announceActionPolicyChange(transaction);
          }

          await templateStore.recordRequests(
            ledgerFor(imported.id, plan, endpoint, actorLabel),
            transaction,
          );
          /*
           * Read back rather than returned from what was written. `recordRequests` does nothing on a
           * row that is already there, so the rows in the database are the ones that count and the
           * caller should be handed those.
           */
          const ledger = await templateStore.listRequests(
            imported.id,
            transaction,
          );

          return {
            agentId,
            imported,
            plan,
            ledger,
            boundaries,
            skillsCreated,
            skillsReused,
            skillsSuffixed,
            skillsSkipped,
          };
        },
        { isolationLevel: "read committed" },
      );

      /*
       * The trail, after the commit and in this order.
       *
       * After, because the audit store holds its own handle and writes on the pool: a row written
       * inside the transaction would survive a rollback and claim a Bot that does not exist.
       * `bot.created` first, so a reader filtering `bot.*` still sees every Bot that ever existed on
       * this deployment rather than only the hand-made ones.
       *
       * NEVER THE PROSE AND NEVER A KEY. `redactAuditPayload` is a key-NAME filter and would pass a
       * field called `roleDescription` or `instructions` through verbatim, so the rule is kept here
       * rather than downstream: what goes in is a slug, a digest, a count and a host.
       */
      const endpointHost = endpoint ? new URL(endpoint).host : undefined;
      await record("bot.created", actor, outcome.agentId, {
        name: template.bot.name,
        ...(endpoint ? { endpoint } : {}),
        hasKey: Boolean(input.auth),
      });
      await record("template.imported", actor, outcome.agentId, {
        templateSlug: template.template.slug,
        ...(template.template.version
          ? { templateVersion: template.template.version }
          : {}),
        // A claim, and the payload says so in the field name. Nothing verified it.
        ...(template.template.author
          ? { authorClaim: template.template.author }
          : {}),
        digest,
        source: input.source,
        ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
        skillsCreated: outcome.skillsCreated,
        skillsReused: outcome.skillsReused,
        skillsSuffixed: outcome.skillsSuffixed,
        skillsSkipped: outcome.skillsSkipped,
        ...(endpointHost ? { endpointHost } : {}),
        hasKey: Boolean(input.auth),
      });
      /*
       * What the Bot may not do, in the words the engine will actually evaluate.
       *
       * The expressions go in verbatim, and that is safe in a way the prose above is not: a clause is
       * this compiler's own output over a closed vocabulary, so it carries no stranger's sentence and
       * nothing a template author chose the wording of. A reader of the trail can compare what was
       * applied against what the consent screen said, character for character, which is the only way
       * to check that claim from outside the code.
       */
      if (outcome.boundaries.length > 0) {
        await record("template.boundary_applied", actor, outcome.agentId, {
          importId: outcome.imported.id,
          clauses: outcome.boundaries.map((row) => row.expression),
        });
      }
      /*
       * One row per unmet ask, written even though the install SUCCEEDED. A Bot that silently cannot
       * work has to be distinguishable from one nobody asked to work: an imported coworker routinely
       * arrives naming a connector nobody here has connected, installs, looks finished on the Bots
       * page, and answers from memory. Without these rows that is indistinguishable from a badly
       * written prompt, and the person debugging it reads the prose over and over looking for a fault
       * that is not there. The author's `why` is deliberately NOT in the payload; it is a stranger's
       * prose and it lives in the ledger, which is where it is rendered as one.
       */
      for (const row of outcome.ledger) {
        if (row.status === "granted") continue;
        await record("template.capability_requested", actor, outcome.agentId, {
          kind: row.kind,
          ref: row.ref,
          status: row.status,
        });
      }

      return outcome;
    },

    async retractTemplateImport(input) {
      const actor = input.actor;
      const outcome = await database.transaction(
        async (transaction) => {
          const imported = await templateStore.importForAgent(
            input.agentId,
            transaction,
          );
          if (!imported) throw new TemplateImportNotFoundError(input.agentId);

          const [profile] = await transaction
            .select({ ownerUserId: agentProfiles.ownerUserId })
            .from(agentProfiles)
            .where(eq(agentProfiles.agentId, input.agentId))
            .limit(1);
          if (
            !profile ||
            (actor.role !== "admin" && profile.ownerUserId !== actor.id)
          ) {
            throw new TemplateRetractionRefusedError(input.agentId);
          }

          /*
           * Only what this import gave.
           *
           * Both predicates, and the pairing is what makes the mark safe. The mark is derived from
           * the document, so two imports of the same file share it; the agent id is what separates
           * them. Every other value in `granted_by` is the id of a person who pressed a button, so a
           * grant an administrator made by hand on this same Bot cannot match and survives untouched
           * — which is the property the whole sentinel exists for, and the one the test asserts.
           */
          const mark = templateGrantMark(imported.digest);
          const revoked = await transaction
            .delete(pluginGrants)
            .where(
              and(
                eq(pluginGrants.agentId, input.agentId),
                eq(pluginGrants.grantedBy, mark),
              ),
            )
            .returning({ kind: pluginGrants.kind, ref: pluginGrants.ref });

          const boundaries = await templateStore.retractBoundaries(
            imported.id,
            transaction,
          );
          /*
           * And every server stops enforcing them, rather than at its next restart.
           *
           * The same announcement the install makes, for the direction that matters more: a ceiling
           * that outlives its retraction is a coworker that goes on being refused actions its owner
           * has just been told it may take again, on some servers and not others.
           */
          if (boundaries.length > 0) {
            await announceActionPolicyChange(transaction);
          }

          /*
           * The Bot stays, and so does every skill. Retracting an import takes back what the import
           * GAVE; it does not delete a coworker somebody has been using or a skill that is now in
           * somebody's `/` menu. Those are ordinary things with ordinary delete gestures of their
           * own, and an import undoing them would be a stranger's file reaching further on the way
           * out than it did on the way in. The provenance row stays too: it is the record of what
           * was consented to, and a retraction is not a reason to forget that it happened.
           */
          return {
            agentId: input.agentId,
            importId: imported.id,
            revoked: revoked.map((row) => ({ kind: row.kind, ref: row.ref })),
            boundaries: boundaries.map((row) => row.expression),
          };
        },
        { isolationLevel: "read committed" },
      );

      await record("template.retracted", actor, outcome.agentId, {
        importId: outcome.importId,
        revoked: outcome.revoked,
        boundaries: outcome.boundaries.length,
      });
      if (outcome.boundaries.length > 0) {
        await record("template.boundary_removed", actor, outcome.agentId, {
          importId: outcome.importId,
          clauses: outcome.boundaries,
        });
      }

      return outcome;
    },
  };
}

/**
 * The consent ledger, derived from the plan rather than from the file.
 *
 * A row per tool a connector asked for, because a tool ref is the thing an administrator can
 * actually grant; a row for a connector that named no tools, so an ask with nothing grantable behind
 * it is still recorded rather than lost; a row per component name; and a row for the endpoint slot
 * when there was one. Nothing here is a permission — see `db/schema/templates.ts` for why there is
 * no `satisfied` column and why `granted` means a person pressed a button rather than that a grant
 * is in force.
 */
function ledgerFor(
  importId: string,
  plan: TemplatePlan,
  endpoint: string | undefined,
  importedBy: string,
): TemplateRequestSeed[] {
  const rows: TemplateRequestSeed[] = [];

  for (const connector of plan.connectors) {
    if (connector.tools.length === 0) {
      rows.push({
        importId,
        kind: "mcp",
        ref: connector.id,
        why: connector.why,
        status: connector.verdict === "available" ? "requested" : "unavailable",
      });
      continue;
    }
    for (const tool of connector.tools) {
      rows.push({
        importId,
        kind: "mcp",
        ref: tool.ref,
        why: tool.why,
        /*
         * `available` is a statement about the deployment, never about this Bot, so it lands as
         * `requested` — the ask is recorded and nothing was granted. `unavailable` says this
         * deployment could not have satisfied it at all when the plan was resolved.
         */
        status: tool.verdict === "available" ? "requested" : "unavailable",
      });
    }
  }

  for (const component of plan.components) {
    rows.push({
      importId,
      kind: "component",
      ref: component.name,
      why: component.why,
      status: component.verdict === "available" ? "requested" : "not_in_build",
    });
  }

  if (endpoint) {
    /*
     * The one ask an import answers on the spot, because the importer answered it: they typed the
     * address. Recorded as decided by them rather than left `requested`, or the profile's amber
     * "requested, not granted" list would forever show a slot that is filled.
     *
     * Written whenever an address was actually stored, rather than only when the plan asked for
     * one. A `managed` template is not asked for an address and may still be given one, and a
     * coworker dialling somewhere the ledger does not mention is the trail lying by omission.
     *
     * The ref is the host rather than the whole address. A ledger row is rendered on a screen and
     * read back out of the database by people, and the path and query of an AG-UI endpoint are
     * neither interesting nor always free of a token somebody put there.
     */
    rows.push({
      importId,
      kind: "endpoint",
      ref: new URL(endpoint).host,
      why:
        plan.endpoint.sendsConversationTo ??
        "The address this coworker runs at, typed by whoever imported it.",
      status: "granted",
      decidedBy: importedBy,
      decidedAt: new Date(),
    });
  }

  return rows;
}

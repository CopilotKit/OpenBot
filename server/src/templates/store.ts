/**
 * The rows a Bot template leaves behind: the drafts this deployment authored, the provenance of a
 * Bot that arrived as somebody's file, and the ledger of everything that file asked for.
 *
 * NOTHING THIS FILE WRITES IS A PERMISSION, and that is the property to keep rather than a slogan.
 * A draft is a document. An import row is a record of what somebody consented to. A ledger row is an
 * ask nobody has answered. What a Bot may actually call stays `plugin_grants`, and the only grant an
 * import makes is the Bot-to-skill pairing written in `install.ts` — there is deliberately no code
 * path here that touches `plugin_grants` at all.
 *
 * Shaped as `agents/profile-store.ts` is: a factory over the database returning an object of
 * methods, every write inside `database.transaction`, and an actor threaded through the reads that
 * belong to somebody. The writes an import makes additionally accept an executor, because an import
 * is one act across two stores — the Bot, its skills, their grants, this provenance and this ledger
 * commit together or not at all.
 */
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import {
  type BotTemplate,
  parseBotTemplate,
  serializeBotTemplate,
  TemplateRefusedError,
} from "../../../shared/bot-template";
import type { AgentActor } from "../agents/profile-types";
import type { Database } from "../db/client";
import {
  botTemplates,
  templateBoundaries,
  templateImports,
  templateRequests,
} from "../db/schema";
import { refuseUnsafeClauses } from "./boundary";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Where a template write runs: the pool, or a caller's open transaction.
 *
 * The same shape and the same reasoning as `PluginExecutor` in `plugins/store.ts`. `update` is in
 * the set because a ledger decision and a retracted boundary are updates rather than inserts, and a
 * caller holding a transaction must be able to make them on it.
 */
export type TemplateExecutor =
  | Pick<Database, "select" | "insert" | "update" | "delete">
  | Pick<Transaction, "select" | "insert" | "update" | "delete">;

/** Reading only, for the callers that have a transaction open and must not borrow a second one. */
export type TemplateReadExecutor =
  | Pick<Database, "select">
  | Pick<Transaction, "select">;

export type TemplateDraft = {
  id: string;
  /** The Bot it was packed from, or null once that Bot is gone. A draft outlives its Bot. */
  agentId: string | null;
  ownerUserId: string;
  slug: string;
  document: BotTemplate;
  createdAt: Date;
  updatedAt: Date;
};

/** How a file got here. The vocabulary grows when registered git sources land. */
export type TemplateImportSource = "paste" | "file" | "gallery";

export type TemplateImportRow = {
  id: string;
  agentId: string;
  digest: string;
  slug: string;
  templateVersion: string | null;
  /** What the file CLAIMS. Never verified, never used to decide anything. */
  authorClaim: string | null;
  source: TemplateImportSource;
  sourceRef: string | null;
  document: BotTemplate;
  importedBy: string;
  importedAt: Date;
};

export type TemplateRequestKind = "mcp" | "component" | "endpoint";

/**
 * Where an ask stands.
 *
 * `requested` is the day-one state of everything a template asked for. `unavailable` and
 * `not_in_build` say this deployment could not satisfy the ask when the plan was resolved.
 * `granted` and `declined` say a person decided — and `granted` means somebody pressed the button,
 * never that the grant is in force today. That question is `plugin_grants` and is asked there.
 */
export type TemplateRequestStatus =
  | "requested"
  | "unavailable"
  | "not_in_build"
  | "granted"
  | "declined";

export type TemplateRequestRow = {
  importId: string;
  kind: TemplateRequestKind;
  ref: string;
  /** The author's sentence, stored verbatim and rendered as a stranger's prose. */
  why: string;
  status: TemplateRequestStatus;
  decidedBy: string | null;
  decidedAt: Date | null;
};

/**
 * A ledger row on the way in.
 *
 * `decidedBy` and `decidedAt` are optional rather than absent because one ask is answered by the
 * import itself: the endpoint slot, which the importer filled by typing an address. Everything else
 * arrives undecided, and the two columns stay null until somebody presses a button on a screen that
 * already refuses.
 */
export type TemplateRequestSeed = Omit<
  TemplateRequestRow,
  "decidedBy" | "decidedAt"
> & {
  decidedBy?: string;
  decidedAt?: Date;
};

/** Which line of the author's closed vocabulary produced a compiled clause. */
export type TemplateBoundarySource =
  | "shell"
  | "files"
  | "browser"
  | "navigate_hosts"
  | "mcp";

export type TemplateBoundaryRow = {
  importId: string;
  agentId: string;
  expression: string;
  sourceKey: TemplateBoundarySource;
  appliedAt: Date;
  removedAt: Date | null;
};

/**
 * A compiled clause on the way in.
 *
 * Structurally the compiler's `CompiledClause` with the import it belongs to, and deliberately not
 * an import of that type: this file knows what the column holds and does not need to know which
 * module produced it. `appliedAt` and `removedAt` are the database's to decide — a clause is in
 * force from the moment it is written, and nothing may arrive claiming to have been in force
 * earlier.
 */
export type TemplateBoundarySeed = {
  importId: string;
  agentId: string;
  expression: string;
  sourceKey: TemplateBoundarySource;
};

/**
 * A draft, an import or a ledger row this actor may not see.
 *
 * Not-found rather than not-permitted, deliberately, and the same call
 * `GET /api/plugins/for/:agentId` makes: a template slug is chosen by its author and a refusal that
 * distinguishes "not yours" from "does not exist" turns the drafts route into a way to enumerate
 * what other people are working on.
 */
export class TemplateNotFoundError extends Error {
  readonly templateId: string;
  constructor(templateId: string) {
    super(`Template ${templateId} was not found.`);
    this.name = "TemplateNotFoundError";
    this.templateId = templateId;
  }
}

/**
 * Two drafts of one name, for one person. The unique index decides; this names what it decided.
 *
 * The sentence tells somebody to rename one of them, which is only useful when there really are two
 * files. Exporting the same coworker twice used to arrive here as well, and told a person to rename
 * something on a panel with no rename control and no sight of the draft they already had. That case
 * is now sorted out before this is thrown, by asking `draftForAgent` which Bot took the name.
 */
export class TemplateSlugTakenError extends Error {
  readonly slug: string;
  constructor(slug: string) {
    super(
      `You already have a template draft called "${slug}". Rename one of them.`,
    );
    this.name = "TemplateSlugTakenError";
    this.slug = slug;
  }
}

/** The one index a draft can collide on, named once so the two writes that catch it agree. */
const OWNER_SLUG_INDEX = "bot_templates_owner_slug_key";

/**
 * Did this failure come from that unique index?
 *
 * Walked down the `cause` chain rather than matched on one message, because the driver's error is
 * wrapped: drizzle raises a `DrizzleQueryError` carrying the SQL, and the PostgreSQL error naming
 * the constraint is underneath it. Matching only the outer message reads the query text — which
 * happens to contain the table name and not the index — so the check silently never fired and a
 * person who already had a draft of that name got a 500 instead of a sentence.
 *
 * The constraint NAME rather than the SQLSTATE, because this table can only be collided on in one
 * way today and a future second index must not be reported as the first.
 */
function isOwnerSlugCollision(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current !== "object") return false;
    const row = current as { constraint?: unknown; message?: unknown };
    if (row.constraint === OWNER_SLUG_INDEX) return true;
    if (
      typeof row.message === "string" &&
      row.message.includes(OWNER_SLUG_INDEX)
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function newTemplateId() {
  return `tpl_${crypto.randomUUID()}`;
}

/**
 * A stored document, read back the same way a pasted one is read.
 *
 * Round-tripped through the serialiser and the parser rather than cast, because a row in a database
 * is not a promise about its own shape. This one is a stranger's document that was written months
 * ago by an older build, or hand-edited by whoever has `psql`, and every refusal the format makes —
 * the unknown key, the `${`, the invisible codepoint, the length ceilings — is a refusal about text
 * that is about to be put in front of a person as something to consent to. Casting would mean the
 * parse ran once, at the boundary, and never again.
 *
 * The cost is a serialise and a parse per row, which is a millisecond on documents this size and is
 * paid on screens that list a handful of drafts.
 */
function readStoredTemplate(value: unknown, where: string): BotTemplate {
  try {
    return parseBotTemplate(serializeBotTemplate(value as BotTemplate));
  } catch (error) {
    if (error instanceof TemplateRefusedError) throw error;
    /*
     * A row that is not a template at all lands here — `serializeBotTemplate` reads through
     * `template.slug` and throws a TypeError rather than a refusal. Restated as a refusal so a
     * caller has one error type to map, and named so the row can be found.
     */
    throw new TemplateRefusedError(
      "bad_type",
      `The stored document for ${where} is not a Bot template.`,
    );
  }
}

function draftFrom(row: {
  id: string;
  agentId: string | null;
  ownerUserId: string;
  slug: string;
  document: unknown;
  createdAt: Date;
  updatedAt: Date;
}): TemplateDraft {
  return {
    id: row.id,
    agentId: row.agentId,
    ownerUserId: row.ownerUserId,
    slug: row.slug,
    document: readStoredTemplate(row.document, row.id),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Whether this actor may see and change this draft.
 *
 * Owner or admin, which is what the API table says. Applied in the store rather than left to the
 * route, because there are five routes and one of them will be added later by somebody who did not
 * read this comment.
 */
function mayReach(actor: AgentActor, ownerUserId: string): boolean {
  return actor.role === "admin" || ownerUserId === actor.id;
}

export type TemplateStore = {
  createDraft(
    actor: AgentActor,
    input: {
      agentId?: string | null;
      document: BotTemplate;
    },
  ): Promise<TemplateDraft>;
  /**
   * The draft this person already packed this coworker into, under this name, or null.
   *
   * THE ONE QUESTION `createDraft`'S REFUSAL CANNOT ANSWER, and the reason it exists. The unique
   * index is on `(owner_user_id, slug)` and says nothing about which Bot a draft was packed from, so
   * a person pressing Export a second time on the same coworker and a person exporting two different
   * coworkers that slugify to one name hit the identical error. The first is somebody repeating
   * themselves and must not be told to rename anything — there is no rename control on that panel and
   * the draft they already have is not on it either, so the refusal is a dead end. The second really
   * is two files fighting for a name and a person has to choose.
   *
   * Scoped to `actor.id` rather than through `mayReach`, because the collision a caller is trying to
   * explain is always the actor's own: `createDraft` writes `ownerUserId: actor.id`, so the row that
   * took the name is theirs even when an administrator is exporting somebody else's Bot.
   *
   * A draft with no `agent_id` is never a match. A pasted document that happens to share the name is
   * not this coworker being packed again, and returning it would hand somebody a file they wrote by
   * hand when they asked for one packed from a Bot.
   */
  draftForAgent(
    actor: AgentActor,
    input: { agentId: string; slug: string },
  ): Promise<TemplateDraft | null>;
  /** Yours, or the deployment's if you are an administrator. Newest first. */
  listDrafts(actor: AgentActor): Promise<TemplateDraft[]>;
  getDraft(actor: AgentActor, templateId: string): Promise<TemplateDraft>;
  /** Replaces the document wholesale. The caller has already re-run the parser and the scanner. */
  updateDraft(
    actor: AgentActor,
    templateId: string,
    document: BotTemplate,
  ): Promise<TemplateDraft>;
  deleteDraft(actor: AgentActor, templateId: string): Promise<void>;

  recordImport(
    input: {
      agentId: string;
      digest: string;
      slug: string;
      templateVersion?: string;
      authorClaim?: string;
      source: TemplateImportSource;
      sourceRef?: string;
      document: BotTemplate;
      importedBy: string;
    },
    executor?: TemplateExecutor,
  ): Promise<TemplateImportRow>;
  /** Where this Bot came from, or null for one somebody made here. */
  importForAgent(
    agentId: string,
    executor?: TemplateReadExecutor,
  ): Promise<TemplateImportRow | null>;

  recordRequests(
    rows: readonly TemplateRequestSeed[],
    executor?: TemplateExecutor,
  ): Promise<void>;
  listRequests(
    importId: string,
    executor?: TemplateReadExecutor,
  ): Promise<TemplateRequestRow[]>;
  /**
   * Record that a person answered one ask. Returns null when there is no such row, so a caller can
   * 404 rather than report a decision nobody made.
   */
  decideRequest(input: {
    importId: string;
    kind: TemplateRequestKind;
    ref: string;
    status: Extract<TemplateRequestStatus, "granted" | "declined">;
    decidedBy: string;
  }): Promise<TemplateRequestRow | null>;

  /**
   * Write the compiled ceiling, refusing anything that would not behave like a rule.
   *
   * THE LAST GATE BEFORE THE COLUMN, and the reason validation is here rather than only in the
   * compiler. A clause that throws sits in a deny position, and `evaluateActionPolicy` counts a
   * throw as a match, so a malformed row would not be a bad rule — it would be a coworker that is
   * refused every action it ever attempts, permanently, with an audit trail blaming an expression
   * nobody can read. The compiler already refuses its own output; this refuses its input, so a
   * second caller written later cannot reach the table by another door. Both checks cost a few
   * evaluations against a synthetic context nobody is waiting on.
   *
   * Returns the rows it wrote, so the trail can name the clauses verbatim.
   */
  recordBoundaries(
    rows: readonly TemplateBoundarySeed[],
    executor?: TemplateExecutor,
  ): Promise<TemplateBoundaryRow[]>;
  /** The clauses in force for this import. Written by the boundary phase; read by retraction. */
  boundariesFor(
    importId: string,
    executor?: TemplateReadExecutor,
  ): Promise<TemplateBoundaryRow[]>;
  /**
   * Take this import's ceiling off, softly.
   *
   * `removed_at` rather than a delete, because "this Bot was never bounded" and "somebody took this
   * Bot's bound off" must not be the same database state. Returns the rows it retired, so the trail
   * can say what stopped applying.
   */
  retractBoundaries(
    importId: string,
    executor?: TemplateExecutor,
  ): Promise<TemplateBoundaryRow[]>;
};

export function createTemplateStore(database: Database): TemplateStore {
  const draftProjection = {
    id: botTemplates.id,
    agentId: botTemplates.agentId,
    ownerUserId: botTemplates.ownerUserId,
    slug: botTemplates.slug,
    document: botTemplates.document,
    createdAt: botTemplates.createdAt,
    updatedAt: botTemplates.updatedAt,
  };

  const importProjection = {
    id: templateImports.id,
    agentId: templateImports.agentId,
    digest: templateImports.digest,
    slug: templateImports.slug,
    templateVersion: templateImports.templateVersion,
    authorClaim: templateImports.authorClaim,
    source: templateImports.source,
    sourceRef: templateImports.sourceRef,
    document: templateImports.document,
    importedBy: templateImports.importedBy,
    importedAt: templateImports.importedAt,
  };

  function importFrom(row: {
    id: string;
    agentId: string;
    digest: string;
    slug: string;
    templateVersion: string | null;
    authorClaim: string | null;
    source: string;
    sourceRef: string | null;
    document: unknown;
    importedBy: string;
    importedAt: Date;
  }): TemplateImportRow {
    return {
      id: row.id,
      agentId: row.agentId,
      digest: row.digest,
      slug: row.slug,
      templateVersion: row.templateVersion,
      authorClaim: row.authorClaim,
      /*
       * The column is plain text with a documented vocabulary, so nothing at the database level
       * stops a value nobody wrote here. Narrowed rather than cast: an unrecognised source reads as
       * a paste, which is the shape that claims the least about where the file came from.
       */
      source:
        row.source === "file" || row.source === "gallery"
          ? row.source
          : "paste",
      sourceRef: row.sourceRef,
      document: readStoredTemplate(row.document, row.id),
      importedBy: row.importedBy,
      importedAt: row.importedAt,
    };
  }

  function requestFrom(row: {
    importId: string;
    kind: string;
    ref: string;
    why: string;
    status: string;
    decidedBy: string | null;
    decidedAt: Date | null;
  }): TemplateRequestRow {
    return {
      importId: row.importId,
      /*
       * Same narrowing, and the fallback matters more here. An unknown kind reads as `component`,
       * which is the one kind whose satisfaction is not a grant at all, so a row nobody recognises
       * can never be routed to the MCP grant screen by accident.
       */
      kind:
        row.kind === "mcp" || row.kind === "endpoint" ? row.kind : "component",
      ref: row.ref,
      why: row.why,
      /*
       * An unknown status reads as `requested`, which is the state that says nothing has been
       * decided. The alternatives all assert something — that a person approved, that a person
       * refused, that the deployment cannot satisfy it — and a row we cannot read must not assert.
       */
      status:
        row.status === "unavailable" ||
        row.status === "not_in_build" ||
        row.status === "granted" ||
        row.status === "declined"
          ? row.status
          : "requested",
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt,
    };
  }

  function boundaryFrom(row: {
    importId: string;
    agentId: string;
    expression: string;
    sourceKey: string;
    appliedAt: Date;
    removedAt: Date | null;
  }): TemplateBoundaryRow {
    return {
      importId: row.importId,
      agentId: row.agentId,
      expression: row.expression,
      sourceKey:
        row.sourceKey === "shell" ||
        row.sourceKey === "files" ||
        row.sourceKey === "browser" ||
        row.sourceKey === "navigate_hosts"
          ? row.sourceKey
          : "mcp",
      appliedAt: row.appliedAt,
      removedAt: row.removedAt,
    };
  }

  async function draftWithin(
    executor: TemplateReadExecutor,
    actor: AgentActor,
    templateId: string,
  ): Promise<TemplateDraft> {
    const [row] = await executor
      .select(draftProjection)
      .from(botTemplates)
      .where(eq(botTemplates.id, templateId))
      .limit(1);
    if (!row || !mayReach(actor, row.ownerUserId)) {
      throw new TemplateNotFoundError(templateId);
    }
    return draftFrom(row);
  }

  return {
    createDraft(actor, input) {
      return database.transaction(async (transaction) => {
        const id = newTemplateId();
        const slug = input.document.template.slug;
        /*
         * The unique index is what decides, and the read that would have "checked first" is not
         * here on purpose: two exports of the same Bot a second apart would both read a free slug
         * and the second insert would still fail. Caught and restated instead, so the person is told
         * the true reason rather than a constraint name.
         */
        try {
          await transaction.insert(botTemplates).values({
            id,
            agentId: input.agentId ?? null,
            ownerUserId: actor.id,
            slug,
            document: input.document,
          });
        } catch (error) {
          if (isOwnerSlugCollision(error)) {
            throw new TemplateSlugTakenError(slug);
          }
          throw error;
        }
        return draftWithin(transaction, actor, id);
      });
    },

    async draftForAgent(actor, input) {
      const [row] = await database
        .select(draftProjection)
        .from(botTemplates)
        .where(
          and(
            eq(botTemplates.ownerUserId, actor.id),
            eq(botTemplates.slug, input.slug),
            eq(botTemplates.agentId, input.agentId),
          ),
        )
        .limit(1);
      return row ? draftFrom(row) : null;
    },

    async listDrafts(actor) {
      const rows = await database
        .select(draftProjection)
        .from(botTemplates)
        .where(
          actor.role === "admin"
            ? undefined
            : eq(botTemplates.ownerUserId, actor.id),
        )
        .orderBy(desc(botTemplates.updatedAt));
      return rows.map(draftFrom);
    },

    getDraft(actor, templateId) {
      return draftWithin(database, actor, templateId);
    },

    updateDraft(actor, templateId, document) {
      return database.transaction(async (transaction) => {
        // Reached through the same gate as a read, so a draft somebody may not see is one they may
        // not overwrite either, and both answer with the same not-found.
        await draftWithin(transaction, actor, templateId);
        const slug = document.template.slug;
        try {
          await transaction
            .update(botTemplates)
            .set({ slug, document, updatedAt: new Date() })
            .where(eq(botTemplates.id, templateId));
        } catch (error) {
          if (isOwnerSlugCollision(error)) {
            throw new TemplateSlugTakenError(slug);
          }
          throw error;
        }
        return draftWithin(transaction, actor, templateId);
      });
    },

    deleteDraft(actor, templateId) {
      return database.transaction(async (transaction) => {
        await draftWithin(transaction, actor, templateId);
        await transaction
          .delete(botTemplates)
          .where(eq(botTemplates.id, templateId));
      });
    },

    async recordImport(input, executor = database) {
      const [row] = await executor
        .insert(templateImports)
        .values({
          agentId: input.agentId,
          digest: input.digest,
          slug: input.slug,
          templateVersion: input.templateVersion ?? null,
          authorClaim: input.authorClaim ?? null,
          source: input.source,
          sourceRef: input.sourceRef ?? null,
          document: input.document,
          importedBy: input.importedBy,
        })
        .returning(importProjection);
      if (!row) {
        throw new Error(
          `The provenance row for ${input.agentId} was not written.`,
        );
      }
      return importFrom(row);
    },

    async importForAgent(agentId, executor = database) {
      const [row] = await executor
        .select(importProjection)
        .from(templateImports)
        .where(eq(templateImports.agentId, agentId))
        .limit(1);
      return row ? importFrom(row) : null;
    },

    async recordRequests(rows, executor = database) {
      if (rows.length === 0) return;
      await executor
        .insert(templateRequests)
        .values(
          rows.map((row) => ({
            importId: row.importId,
            kind: row.kind,
            ref: row.ref,
            why: row.why,
            status: row.status,
            decidedBy: row.decidedBy ?? null,
            decidedAt: row.decidedAt ?? null,
          })),
        )
        /*
         * A retried install that got past the first write must not write a stranger's `why` twice.
         * `doNothing` rather than an update, because a row already here may carry an
         * administrator's decision, and an import has no business overwriting one.
         */
        .onConflictDoNothing({
          target: [
            templateRequests.importId,
            templateRequests.kind,
            templateRequests.ref,
          ],
        });
    },

    async listRequests(importId, executor = database) {
      const rows = await executor
        .select()
        .from(templateRequests)
        .where(eq(templateRequests.importId, importId))
        .orderBy(asc(templateRequests.kind), asc(templateRequests.ref));
      return rows.map(requestFrom);
    },

    decideRequest(input) {
      return database.transaction(async (transaction) => {
        const [row] = await transaction
          .update(templateRequests)
          .set({
            status: input.status,
            decidedBy: input.decidedBy,
            decidedAt: new Date(),
          })
          .where(
            and(
              eq(templateRequests.importId, input.importId),
              eq(templateRequests.kind, input.kind),
              eq(templateRequests.ref, input.ref),
            ),
          )
          .returning();
        return row ? requestFrom(row) : null;
      });
    },

    async recordBoundaries(rows, executor = database) {
      if (rows.length === 0) return [];
      /*
       * One row per distinct clause, first source_key wins.
       *
       * The primary key is `(import_id, expression)`, so two vocabulary lines that compiled to the
       * same clause would collide and abort the import over what is in fact agreement — the same
       * restriction stated twice is the same restriction. Collapsed here instead, which is what the
       * schema comment on that key already describes, at the cost that `source_key` then names only
       * one of the two lines that asked for it.
       */
      const distinct = new Map<string, TemplateBoundarySeed>();
      for (const row of rows) {
        if (!distinct.has(row.expression)) distinct.set(row.expression, row);
      }
      const seeds = [...distinct.values()];
      refuseUnsafeClauses(seeds);

      const written = await executor
        .insert(templateBoundaries)
        .values(
          seeds.map((row) => ({
            importId: row.importId,
            agentId: row.agentId,
            expression: row.expression,
            sourceKey: row.sourceKey,
          })),
        )
        .returning();
      return written.map(boundaryFrom);
    },

    async boundariesFor(importId, executor = database) {
      const rows = await executor
        .select()
        .from(templateBoundaries)
        .where(eq(templateBoundaries.importId, importId))
        .orderBy(asc(templateBoundaries.expression));
      return rows.map(boundaryFrom);
    },

    async retractBoundaries(importId, executor = database) {
      const rows = await executor
        .update(templateBoundaries)
        .set({ removedAt: new Date() })
        .where(
          and(
            eq(templateBoundaries.importId, importId),
            // Only what is still in force. Re-stamping a clause somebody already removed would move
            // the date of an act that happened at a different time.
            isNull(templateBoundaries.removedAt),
          ),
        )
        .returning();
      return rows.map(boundaryFrom);
    },
  };
}

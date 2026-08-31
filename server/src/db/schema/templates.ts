/**
 * Schema owned by Bot templates: the drafts this deployment authored, and the provenance of every
 * Bot that arrived as somebody else's file.
 *
 * A new file rather than columns on `agents` or `agent_profiles`, and that is a decision rather than
 * housekeeping. An imported Bot must be an ORDINARY Bot — private, owned by the importer, editable
 * and deletable by exactly the rules that govern one somebody made by hand, and specifically not
 * `systemOwned`. A column on the Bot's own row would eventually be read as a flag, and a flag on a
 * Bot is a second thing deciding what that Bot is. `coworker.ts:1-6` states the file rule; this is
 * why the rule is worth keeping here rather than merely convenient.
 *
 * NOTHING IN THESE TABLES IS A PERMISSION. Configuration travels; capability does not. What a Bot
 * may call is `plugin_grants` and only `plugin_grants`; what an MCP server is, is `mcp_servers`.
 * These tables hold a document somebody wrote, a record of what was consented to, an ask nobody has
 * answered yet, and a ceiling. Every one of them is inert until an administrator acts on a screen
 * that already exists.
 */
import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";
import { jsonb } from "./json";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * A template draft this deployment authored, before it is a file anybody else has.
 *
 * Export produces a draft rather than a download because the interesting half of packing a Bot is
 * what was stripped: the endpoint, the credential, the id, the package it belonged to. An author
 * reads the draft, widens the strict boundary block to what the Bot actually needs, and only then
 * sends the file. A one-shot download would put a document nobody read into somebody else's paste
 * box, and the person who wrote it would be the last to know what it said.
 */
export const botTemplates = pgTable(
  "bot_templates",
  {
    /**
     * `tpl_<uuid>`, minted here rather than derived from the document.
     *
     * A text id carrying its kind, the same shape agents and skills use, so an id in a URL or an
     * audit payload says what it addresses without a lookup. Deliberately not content-addressed: a
     * draft is edited, and an id that moved on every save would break every link to it and make the
     * audit trail refer to something that no longer exists.
     */
    id: text("id").primaryKey(),
    /**
     * The Bot this was packed from, or null once that Bot is gone.
     *
     * `set null` rather than `cascade`, because a draft OUTLIVES the Bot it came from. Once the
     * document exists it is an artifact in its own right — the thing that was going to be published,
     * or the thing already sent to somebody — and deleting the coworker it was taken from is not a
     * reason to destroy it. Null here reads as "packed from a Bot that is no longer on this
     * deployment", which is a true sentence a screen can say.
     */
    agentId: text("agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    /**
     * Whose draft this is. Cascades, matching `skills.ownerUserId`: an unpublished document belongs
     * to the person who wrote it and goes when they do.
     */
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * The slug the file is named by, unique PER OWNER rather than across the deployment.
     *
     * A template slug names a file. It is not `skills.slug`, which is unique deployment-wide because
     * it IS the shared `/` namespace and two behaviours answering to `/standup` is a real collision.
     * A draft reaches nobody until it is sent, so two people packing the same Bot must not race each
     * other for a name — first-taker-keeps would be an obstruction with nothing behind it.
     */
    slug: text("slug").notNull(),
    /**
     * The parsed, NFC-normalised template, not the YAML text.
     *
     * One canonical value, so the digest, the serialiser and the edit path all read the same thing
     * and a `PATCH` re-runs the parser instead of editing a string. The cost is real and worth
     * stating: `serializeBotTemplate` regenerates the file, so comments an author typed into their
     * YAML are not preserved across an edit. The alternative — keeping the text and parsing it on
     * every read — means the stored bytes and the stored meaning can disagree, which for a document
     * a stranger will later be asked to consent to is the worse of the two.
     */
    document: jsonb("document").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("bot_templates_owner_slug_key").on(
      table.ownerUserId,
      table.slug,
    ),
  ],
);

/**
 * Where an imported Bot came from: one row per Bot that arrived as somebody's template.
 *
 * The only record that a Bot was not made here, and it is keyed by the BOT rather than by the
 * template because there is no update channel. Re-importing the same file creates a second Bot with
 * its own row, and the two are unrelated from that moment on. That is not an omission — auto-update
 * is the mechanism behind the Cyberhaven and Coze compromises, and there is no version of it that is
 * safe without publisher identity, which this design deliberately does not have.
 */
export const templateImports = pgTable(
  "template_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The Bot this import produced. One import per Bot, enforced rather than assumed.
     *
     * Without the unique constraint a retried install that got past the first write would leave two
     * provenance rows for one coworker, and every screen asking "where did this Bot come from" would
     * answer with whichever the query happened to order first. Cascades: the provenance of a Bot
     * that no longer exists is not a record anybody can act on, and the audit trail — which is
     * append-only and not in this file — is what preserves that the import happened.
     */
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /**
     * sha256 over the sorted-key JSON of the parsed, NFC-normalised document.
     *
     * Recorded because it is what the consent screen showed. Install recomputes it and returns 409
     * if it moved, which closes the window where a gallery entry or a pasted buffer changes between
     * the screen a person read and the button they pressed. Its first twelve characters are also the
     * mark every grant this import made carries (`templateGrantMark`), mirroring the
     * `'tenant-package'` sentinel — which is what lets a retraction take back exactly what this
     * import gave and leave an administrator's own grant on the same Bot untouched.
     */
    digest: text("digest").notNull(),
    slug: text("slug").notNull(),
    /**
     * The author's version string, and nothing reads it.
     *
     * Stored so a person can be told which version of a file they took, never to compare against
     * anything. Comparing is an update channel by another name, and the absence of one is what makes
     * a template safe to import from a stranger.
     */
    templateVersion: text("template_version"),
    /**
     * The author, as the file CLAIMS it. The column name says what it is.
     *
     * Named `author_claim` rather than `author` on purpose: nothing verifies it, and a name like
     * `author` invites the next person writing a query in a hurry to treat it as an identity this
     * deployment established. There is no publisher namespace, no signing key and no registry, so
     * there is nothing this could have been checked against.
     */
    authorClaim: text("author_claim"),
    /**
     * How the file got here: `paste`, `file` or `gallery`.
     *
     * Plain text with a documented vocabulary rather than a `pgEnum`, matching `mcp_servers.provenance`
     * and `plugin_grants.kind`. The vocabulary grows — a registered git source lands in a later phase
     * — and a new member should be a code change rather than a migration that rewrites a type across
     * every existing row.
     */
    source: text("source").notNull(),
    /**
     * What that source named this file, or null for a paste.
     *
     * The gallery filename, or an `owner/repo@sha` and a path once git sources exist. A record of
     * where to look, never an address anything dials: fetching is server-side and only from a source
     * an administrator registered, and this column is not consulted on the way.
     */
    sourceRef: text("source_ref"),
    /**
     * Exactly what was consented to, stored rather than referenced.
     *
     * The second copy of a document is the point, not redundancy. A gallery entry is a file on disk
     * that a redeploy replaces and a git pin is a sha an administrator can move, so a pointer would
     * let the record of what somebody agreed to change after they agreed to it. The consent screen
     * showed these bytes; this table can still produce them years later.
     */
    document: jsonb("document").notNull(),
    /**
     * Who imported it, as an email, and NOT a foreign key.
     *
     * The `plugin_grants.granted_by` convention, shared with `skills.installed_by` and
     * `mcp_servers.added_by`. A trail records who acted, and removing the person must not rewrite
     * what happened: `cascade` would erase the row, and `set null` would leave it claiming nobody
     * imported this Bot. Under `OPENBOT_SINGLE_USER` there is frequently no `users` row worth
     * pointing at in the first place.
     */
    importedBy: text("imported_by").notNull(),
    /**
     * When. Written out rather than using the shared `createdAt()` helper, which fixes the column
     * name to `created_at` — the same choice `mcp_user_credentials.connected_at` made, and for the
     * same reason: this row records an act somebody performed, and it is worth the column saying
     * which act.
     */
    importedAt: timestamp("imported_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("template_imports_agent_key").on(table.agentId),
    /** "Has this document been imported here before", asked by the preview screen. */
    index("template_imports_digest_idx").on(table.digest),
  ],
);

/**
 * The consent ledger: everything a template asked for, and what an administrator later said about it.
 *
 * A row here is an ASK. It is not, and can never become, a permission — the import module has no
 * code path that writes a `plugin_grants` row with `kind='mcp'`, and that is a grep test over
 * `server/src/templates/` rather than a promise in a comment. An unmet ask never blocks an install
 * either: blocking would make "grant everything" the fastest route to a working Bot, which inverts
 * the feature it was meant to protect.
 *
 * THERE IS DELIBERATELY NO `satisfied` COLUMN, and the omission is the design rather than an
 * oversight. Whether a capability exists is answered live, at read time, by `plugin_grants`,
 * `mcp_servers` and `components`. A column here saying "yes, this one is satisfied" would be a
 * second source of truth for a permission, and this codebase already carries the bill for exactly
 * that: `server/src/components/sandboxed.ts:288-293` records a `component_exclusions` row that went
 * missing and released a component to every Bot, because a governance table whose rows are consulted
 * separately from the thing they govern fails open the moment the two disagree. A stale `satisfied`
 * here would do the same shape of damage in reverse — a grant retracted through the Plugins page
 * would leave this table still saying yes, and a screen reading this table would show a person a
 * capability their Bot no longer has.
 */
export const templateRequests = pgTable(
  "template_requests",
  {
    importId: uuid("import_id")
      .notNull()
      .references(() => templateImports.id, { onDelete: "cascade" }),
    /** `mcp`, `component` or `endpoint`. Which screen answers this ask. */
    kind: text("kind").notNull(),
    /**
     * What is being asked for: `<serverId>/<toolName>` for an MCP tool, the component's name, or the
     * slot an endpoint gets typed into. The same shape `plugin_grants.ref` holds, so the two can be
     * compared without either side parsing the other's format.
     */
    ref: text("ref").notNull(),
    /**
     * The author's sentence explaining the ask, shown to the importer verbatim.
     *
     * Stored because it is the only thing on the grant screen that says WHY, and because an
     * administrator deciding this next month was not in the room when the consent screen was read.
     * It is a stranger's prose and is rendered as such — never interpreted, never given to a model.
     */
    why: text("why").notNull(),
    /**
     * `requested`, `unavailable`, `not_in_build`, `granted` or `declined`.
     *
     * `requested` is the day-one state of everything a template asked for. `unavailable` and
     * `not_in_build` record that this deployment could not satisfy the ask at all when the plan was
     * resolved — there is no `mcp_servers` row, or the build ships no such component. `granted` and
     * `declined` record that a person decided.
     *
     * `granted` means an administrator pressed the button on this row. It does NOT mean the grant is
     * currently in force; that question belongs to `plugin_grants` and is asked there every time. See
     * the note above about the second source of truth — nothing decides anything from this column.
     */
    status: text("status").notNull(),
    /** The administrator's email, same convention and same reasoning as `imported_by`. */
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (table) => [
    /**
     * One ask per capability per import. A surrogate id with no unique constraint would let a
     * retried install write the same ask twice, and then the screen shows a stranger's `why` twice
     * and a grant answers one of the two while the other sits there still saying `requested`.
     */
    primaryKey({ columns: [table.importId, table.kind, table.ref] }),
  ],
);

/**
 * The compiled ceiling on one imported Bot, kept deliberately AWAY from `action_policy.deny`.
 *
 * Written by a later phase. The table lands now so this is one migration rather than two, and so the
 * storage decision is recorded next to what enforces it rather than only in a design document.
 *
 * SEPARATE STORAGE IS THE ENTIRE POINT. `policyStore.set` replaces the whole `deny` array, and the
 * `/admin/boundaries` screen posts a snapshot of what it last read, with no version column between
 * them. A clause written into `action_policy.deny` by an import is therefore erased by the next
 * administrator who saves an unrelated change on that screen — a lost update that silently uncages
 * an imported Bot, with nothing anywhere saying it happened. Clauses live here instead and
 * `policyStore.get()` composes `stored ++ generated` for evaluation only. Different storage makes
 * the lost update unrepresentable rather than merely unlikely.
 */
export const templateBoundaries = pgTable(
  "template_boundaries",
  {
    importId: uuid("import_id")
      .notNull()
      .references(() => templateImports.id, { onDelete: "cascade" }),
    /**
     * The Bot the clause binds. Denormalised from the import row on purpose: every policy check asks
     * "what is in force for this Bot", and that read must not have to join through provenance to
     * find out.
     */
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /**
     * The compiled CEL clause, validated before the import commits.
     *
     * A template never writes CEL; it writes a closed vocabulary, and the compiler emits this. Three
     * properties this column depends on, all of them required rather than defensive. NO REGEX: a
     * host list compiles to `page.host == "a" || page.host == "b"` over validated, JSON-escaped
     * hostnames, so there is no backtracking to exploit and no `") || true || matches("` to inject.
     * PARAMETERIZED EMISSION, never concatenation of a template's values. And WRITE-TIME VALIDATION:
     * every clause is evaluated against a synthetic neutral context first, because a clause that
     * throws sits in a deny position and would deny every action for every Bot on the deployment.
     */
    expression: text("expression").notNull(),
    /**
     * Which line of the author's vocabulary produced this clause: `shell`, `files`, `browser`,
     * `navigate_hosts` or `mcp`.
     *
     * Kept so a screen can state the restriction in the words the author wrote rather than in CEL,
     * and so retracting one line does not require parsing CEL to work out which rows it owns.
     */
    sourceKey: text("source_key").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * When the clause stopped applying. Null means in force, and that is the read every evaluation
     * makes.
     *
     * Soft rather than a delete, because "this Bot was never bounded" and "somebody took this Bot's
     * bound off" must not be the same database state. One of those is a template that asked for
     * nothing; the other is an act a person performed and should be able to be asked about.
     */
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => [
    /**
     * One row per distinct clause per import. Two vocabulary lines that compile to the identical
     * clause collapse into one row, which is correct — the same restriction stated twice is the same
     * restriction — with the consequence that `source_key` then names only one of the two.
     */
    primaryKey({ columns: [table.importId, table.expression] }),
    /** The evaluation read: which clauses are in force for this Bot, on every policy check. */
    index("template_boundaries_agent_idx").on(table.agentId, table.removedAt),
  ],
);

/**
 * A git repository an administrator pinned, so that the pin is still there after a restart.
 *
 * IT WAS IN MEMORY AND ONLY IN MEMORY, which is the bug this table exists to close. The catalogue
 * kept its registrations in a `Map`, so an administrator registered `owner/repo` at a sha, the
 * deployment restarted, and every source was gone: the gallery quietly narrowed to the templates
 * baked into the image and `GET /api/admin/templates/settings` answered `sources: []` minutes after
 * one had been registered. Nothing said why, because nothing had failed — a registration that
 * vanishes leaves no trace of having existed.
 *
 * ONE ROW PER REPOSITORY, and the handle is the primary key rather than a surrogate beside a unique
 * index. `owner/repo` IS the identity of a source: a second pin on the same repository is that
 * source's pin being MOVED, not a second source, and moving the pin is the only update mechanism
 * this design has. A surrogate id would make two live pins on one repository representable, and then
 * `fromSource("owner/repo")` has to pick one of them.
 *
 * THIS TABLE IS NOT AN ALLOWLIST. `OPENBOT_TEMPLATE_SOURCES` is, it comes from the environment, and
 * a row here that is no longer named there is not loaded — see `load` in `templates/catalogue.ts`.
 * A deployment that took a repository out of its configuration has withdrawn permission to fetch
 * from it, and a row remembering an administrator once said yes must not be able to give that
 * permission back.
 */
export const templateSources = pgTable("template_sources", {
  /**
   * `owner/repo`, lowercased. The handle is the id, so registering the same repository again
   * conflicts here and updates the pin rather than inserting beside it.
   */
  id: text("id").primaryKey(),
  /**
   * The two halves, stored as well as the handle they compose.
   *
   * Redundant on purpose. The handle is what an allowlist and a URL are both built from, and a
   * reader of this table should not have to split a string on `/` and trust that nothing ever put
   * something else in it. `parseSourceHandle` is the one place that split happens.
   */
  owner: text("owner").notNull(),
  repo: text("repo").notNull(),
  /**
   * A full 40-character commit sha, validated before this row is written.
   *
   * Never a branch. `main` is a name whoever owns that repository can repoint after an administrator
   * has read the files, which turns a reviewed catalogue into an update channel — the mechanism
   * behind the Cyberhaven and Coze compromises. The column takes what registration validated; it is
   * not a second parser.
   */
  sha: text("sha").notNull(),
  /**
   * Who registered it, and NOT a foreign key.
   *
   * The `plugin_grants.granted_by` and `template_imports.imported_by` convention. A trail records
   * who acted, and removing that person must not rewrite what happened: `cascade` would delete the
   * registration a live gallery is still serving from, and `set null` would leave it claiming
   * nobody registered it. Under `OPENBOT_SINGLE_USER` there is frequently no `users` row worth
   * pointing at in the first place.
   */
  registeredBy: text("registered_by").notNull(),
  /**
   * When, spelled out rather than taken from the shared `createdAt()` helper, which fixes the column
   * name to `created_at`. Same choice `template_imports.imported_at` made and for the same reason:
   * this row records an act somebody performed, and the column is worth naming the act.
   */
  registeredAt: timestamp("registered_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents, credentials, users } from "./core";
import { jsonb } from "./json";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * Schema owned by Plugins: MCP servers a deployment has added, the tools they offer, packaged
 * skills, and which Bots may use any of it.
 *
 * One surface for both. A tool from an MCP server and a
 * packaged skill are different things to build and the same thing to govern: somebody adds it once
 * for the deployment, and then decides which Bots may use it. Two tables with two grant surfaces
 * would give an operator two places to look and two ways to be wrong about what a Bot can reach.
 */

/**
 * An MCP server this deployment has added.
 *
 * Account-wide, not per-Bot. Adding a server is an administrative act with a
 * credential behind it; which Bots may use its tools is a separate decision, recorded in
 * {@link pluginGrants}. Conflating them would mean adding a server to a second Bot re-entered the
 * credential, and a deployment would end up with the same vendor authorised several times over with
 * no single place to revoke it.
 *
 * `id` is the slug and a contract: it prefixes every tool name the model is offered, so a tool
 * from two servers can never collide, and a rule written against `mcp.server == "atlassian"` keeps
 * meaning the same thing after somebody renames the display title.
 */
export const mcpServers = pgTable("mcp_servers", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  logo: text("logo"),
  /** The vendor this server is maintained by, which is what the first-party rule is checked against. */
  vendor: text("vendor").notNull(),
  url: text("url").notNull(),
  /**
   * `first-party` for a curated entry, `custom` for one an administrator added by URL, `composio`
   * for an app enabled through the broker.
   *
   * Recorded because the three are not the same risk. A curated entry has reviewed source provenance
   * and a pinned host. A custom one is a URL somebody typed, and every surface that lists it says so.
   * Storing which it is means the Plugins page, the audit trail and anybody reading the database
   * later all agree about how a server got here, rather than inferring it from whether the host
   * happens to still be in this build's catalogue.
   *
   * AND `composio` IS NOT MERELY A THIRD LABEL — it decides how the row is REACHED. `accessFor`
   * reads this column to answer that a call is brokered, which is what makes it run in the account
   * of the person asking rather than on the deployment's own credential, and `toolkitOf` then reads
   * which app out of {@link mcpServers.url}. So this column and that one are ONE FACT IN TWO PLACES,
   * and the invariant every writer keeps is that they are written together: a `composio://` url
   * carries `provenance = composio`, and a row saying `composio` carries a url naming an app. Half
   * of the pair is not a mislabelled row, it is a row dialled one way and governed another — see
   * `requireNotBrokered` in `plugins/store.ts` for which writes are refused to keep the pair whole,
   * and `addBrokeredApp` for the one that converts.
   */
  provenance: text("provenance").notNull().default("first-party"),
  /**
   * The vault row holding this server's credential, or null for a server that needs none.
   *
   * A pointer rather than the secret: the vault owns encryption, rotation and revocation, and a
   * second copy of a token here would be a second thing to remember to revoke.
   *
   * A REAL foreign key, where this was `text` against a `uuid` primary key with none. That is not a
   * typing nicety. The database was willing to hold a pointer to a credential row that did not
   * exist, and it did: a test deleted the credential an administrator had registered and left this
   * column addressing nothing, so the connector reported "no OAuth client registered yet" while the
   * row still looked configured. Nothing caught it because nothing was checking.
   *
   * `restrict`, not `cascade` or `set null`. A credential this server points at should not be
   * removable out from under it — the two legitimate ways to change it are replacing it, which
   * repoints this column first, and removing the server, which takes the row with it. Anything else
   * is a mistake, and should be refused rather than silently tidied into a working-looking state.
   */
  credentialId: uuid("credential_id").references(() => credentials.id, {
    onDelete: "restrict",
  }),
  /**
   * How this app connects, as it was resolved when somebody enabled it.
   *
   * Recorded rather than re-derived, because the catalogue is somebody else's and a vendor that
   * starts publishing a new scheme for an app must not move live connections onto a different
   * flow underneath them.
   *
   * THE VENDOR'S OWN SCHEME LITERAL, NOT A {@link BrokerConnection} KIND — `OAUTH2`, `DCR_OAUTH`,
   * `API_KEY`, `BASIC`, `BEARER_TOKEN`, `BASIC_WITH_JWT`, `NO_AUTH`. Those two vocabularies name one
   * fact, and this column is where a reader comes to find out which of them is written down, so it
   * says: somebody looking here for `consent` or `fields` is reading the other one. Migration 0038
   * backfilled every row whose provenance is `composio` to `OAUTH2`, because managed OAuth was the
   * only config this deployment ever created and `addBrokeredApp` writes the row only after that
   * config stands. A null is therefore not an older brokered row this deployment WROTE.
   *
   * WHICH IS NOT THE SAME AS A NULL BEING UNREACHABLE ON A BROKERED READ, and the difference has
   * cost a verdict already. Every reader finds an app's row by {@link mcpServers.url}, which carries
   * no unique index — two rows may name one app, and the one that answers is not always the one an
   * enable wrote a scheme onto. Add a row inserted by hand, a row restored from elsewhere, or an app
   * whose `BrokerConnection` was `unsupported`, and a brokered read really does meet a null here. So
   * a reader must have three answers and not two: a key, a consent, and a column it cannot act on.
   * `schemeKind` in `plugins/broker.ts` is that reading, and `confirmBrokeredConnection` is what
   * happened without it — a null read as consent, and `verified: true` written on every page load
   * over evidence nobody had.
   */
  authScheme: text("auth_scheme"),
  /** What the deployment last heard back from it. `null` until the first successful listing. */
  toolsRefreshedAt: timestamp("tools_refreshed_at", { withTimezone: true }),
  /** The last failure, kept so the Plugins page can say why a server has no tools. */
  lastError: text("last_error"),
  addedBy: text("added_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * A tool one server says it offers, as of the last listing.
 *
 * A cache of what the server said, never a source of truth about what it will accept. The row exists
 * so the Plugins page and the `@` menu can show a list without a network call per render, and so a
 * grant can name a tool that is not reachable this second. Every actual call re-reads the server.
 *
 * Rows are replaced wholesale on each refresh rather than merged, so a tool a vendor withdrew stops
 * being offered instead of lingering as a name the model will call and the server will reject.
 */
export const mcpTools = pgTable(
  "mcp_tools",
  {
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** The tool's own JSON Schema, passed to the model unchanged. */
    inputSchema: jsonb("input_schema").notNull().default({}),
    /**
     * What this action does, as the vendor itself described it, or null when nothing said.
     *
     * Recorded here rather than derived per call because the source is the listing: Composio labels
     * every action, and those labels arrive with the tool list and nowhere else. A hand-written write
     * list per app — which is what {@link CatalogueEntry.writeTools} is — cannot be kept for a
     * catalogue of several hundred apps that changes weekly, and a list naming only the actions
     * somebody thought of reads as a guard while behaving like a gap.
     *
     * PLAIN TEXT RATHER THAN AN ENUM, deliberately. The value is somebody else's vocabulary, so a
     * database enum would need a migration every time a vendor invents a label, and the migration
     * would be the thing standing between a refresh and a correct classification. `classifyTool`
     * defends instead: only the exact string `read` produces a read, so an unrecognised value fails
     * closed. Same reasoning as `mcp_servers.provenance`, which is text for the same reason.
     *
     * NULLABLE, AND NOT DEFAULTED TO "write". Every row that already exists was listed before this
     * column did, and a default would reclassify every Notion read as a write when the migration ran.
     * Null means "nothing said", and the classifier decides that means write.
     */
    effect: text("effect"),
    /**
     * Whether the vendor marked this action as destroying something.
     *
     * Separate from {@link mcpTools.effect} rather than a third value in it, so the rule engine keeps
     * the two values every existing policy is written against and nobody's rules need migrating. It
     * is recorded now because the confirmation card is what needs it, and re-listing every app later
     * to backfill a column is worse than carrying it from the start.
     *
     * `false` for an action nothing said about — the same fail-closed direction as `effect` without
     * claiming a vendor said something it did not. An unclassified action is already gated as a
     * write; marking it destructive as well would paint every ordinary write as dangerous and teach
     * an approver to click through the colour.
     */
    destructive: boolean("destructive").notNull().default(false),
    /**
     * The vendor's version for this action, as the listing gave it — `20260903_00` and the like.
     *
     * NOT OPTIONAL BOOKKEEPING. Composio refuses to execute an action without a specific version,
     * and refuses the word `latest` too, so this column is what makes a call possible at all. It is
     * stored rather than fetched per call because it arrives free with the listing and fetching it
     * would be a second round trip on every single call.
     *
     * Null for every other transport, which publishes no such thing, and for rows listed before this
     * column existed. The Composio transport treats a missing version as a reason to refuse rather
     * than a reason to guess — a guessed version is a call against an action's other behaviour.
     */
    version: text("version"),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.serverId, table.name] })],
);

/**
 * One person's Composio connection to one app.
 *
 * WHY THIS IS NOT `mcp_user_credentials`. That table's whole guarantee is that a row means real held
 * access: it points at a vault row, not-null, and the vault is what offboarding scans. Composio holds
 * the account, so there is no secret to point at and none to scan for — and `retireConnectionsFor`
 * deliberately reads the VAULT rather than the join table, because the join row is deleted along with
 * the person while the vault row survives. Putting a Composio connection there would mean removing
 * somebody deletes the only record of it, leaving their mailbox connected at Composio with nothing
 * left to revoke it by, while an administrator has been told they removed it.
 *
 * So `user_id` is plain text with NO foreign key and no cascade. The row outliving the person is the
 * point, not an oversight: it is the only thing that lets offboarding say "this person had Gmail
 * connected, tell Composio to drop it". A scope column would be a lie — Composio returns no scope we
 * see, and the column on the other table exists precisely to record what the vendor said it granted —
 * so there is none.
 *
 * A CACHE, NOT THE TRUTH. Composio is authoritative about whether a connection is live; this row
 * exists so the settings page can be drawn without a network call per row, and so offboarding has
 * something to iterate. A call against an app the person never connected fails at Composio, and that
 * refusal is the answer rather than this table's absence.
 */
export const composioConnections = pgTable(
  "composio_connections",
  {
    /** The Composio app slug, lower case, as their directory spells it: `gmail`, `slack`. */
    toolkit: text("toolkit").notNull(),
    /**
     * The person, as `users.id`.
     *
     * The same value sent to Composio as the identity a call runs under, so the two cannot drift:
     * what this row says somebody connected is what a call will act as.
     */
    userId: text("user_id").notNull(),
    /** When they connected, shown on their own settings page. */
    connectedAt: timestamp("connected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Whether a real call was made with this connection and answered. See the verify path.
     *
     * TRUE ON EVERY ROW THAT PREDATES THIS COLUMN WITHOUT A PROBE BEHIND IT. Migration 0038 —
     * `server/drizzle/0038_composio_schemes.sql`, which is where this pair and `auth_scheme` are
     * both added and both backfilled; every "0038" in this file names that one file —
     * backfilled them to true with `verified_at = connected_at`, and no call was made to earn it:
     * every one of the rows it touched is a consent connection, which is verified by construction,
     * because the only way it exists at all is that the vendor's own screen sent the person back
     * connected. So on a backfilled row the timestamp is the moment of consent, not the moment of a
     * check, and a reader treating every `verified_at` as "this connection answered then" would be
     * wrong about exactly the rows that were here first.
     *
     * AND THE SAME NOW HOLDS OF EVERY CONSENT ROW AND NOT ONLY THE BACKFILLED ONES, because the
     * writer that records a connection sets `verified` itself: `recordBrokeredConnection` is the
     * one place a row is written, and `confirmBrokeredConnection` calls it with `verified: true` on
     * the vendor's yes. So a consent connection made today carries the same true migration 0038
     * wrote and earns it the same way — the vendor answered that the account is attached — and its
     * `verified_at` is the moment of that answer: the consent itself on the first confirm, and the
     * vendor's yes again on every later one, because a confirm really does go and ask. What it used
     * to do was insert on the defaults, and until it stopped, every consent connection made since
     * the backfill read `false` beside a null `verified_at` — the very pair a key connection nobody
     * has ever checked reads — so nothing could tell the two apart, and the rows the migration
     * touched were the only ones in the table saying anything true.
     *
     * ON A CONSENT ROW, AND ONLY THERE. That confirm runs from an effect on mount, so what it
     * writes it writes on every page load — and the vendor's yes is evidence about a KEY of
     * nothing, because Composio takes a key when it is typed and never tests it again. So the
     * confirm branches on the scheme recorded on the app's row: it writes this flag where consent
     * IS the check, and leaves a key connection's recorded verdict exactly as the last real call
     * left it. Written across a key row instead, it restated the consent pair below — `verified`
     * true beside a null `probe_action` — over the record of a check that had actually happened,
     * and moved this timestamp to the page load, so the page's own sentence named a day on which
     * nothing was checked.
     *
     * AND A CHECK THAT COULD NOT BE MADE LEAVES THIS COLUMN ALONE, which is the one thing a writer
     * of it must not improvise. `false` here means "no evidence that this connection answers", and
     * a Composio outage produces no evidence in EITHER direction — so on a connect, whose row has
     * to exist whatever happens, the outage is written as the unchecked pair, and on a re-check,
     * which finds a row already standing, NOTHING IS WRITTEN AT ALL. Clearing a verification
     * because the vendor could not be reached destroys the only record anywhere that this
     * connection was ever checked, and the date beside it, on the word of an event that says
     * nothing about the key. See {@link composioConnections.probeAction}.
     *
     * WHAT THE PAIR SEPARATES IS A CHECKED CONNECTION FROM AN UNCHECKED ONE, and never one KIND of
     * connection from another. Which kind a row is comes from the app's own `auth_scheme`, which
     * the settings page branches on first; this column says only that somebody established the
     * account is live, and `verified_at` when that was last done.
     */
    verified: boolean("verified").notNull().default(false),
    /** When that check last passed, which is what the page reports instead of a present tense. */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    /**
     * The action the last check SPENT on this connection, and null where it spent none.
     *
     * A RECORD OF WHAT HAPPENED, NOT A QUESTION ASKED OF TODAY'S METADATA — which is the whole
     * reason it is a column at all. `verified` is a fact about a check made against the app's action
     * listing as it stood THEN; this used to be derived on read from the listing as it stands NOW,
     * and the argument that the two agreed held only for as long as nothing changed in between.
     * Something can: `POST /servers/:id/refresh` is a generic administrator's route keyed on a
     * server id and `composio-<slug>` is one, so an ordinary press of Refresh re-lists a brokered
     * app's actions — the very press the Composio transport tells an operator to make when an
     * action gains the version that makes it callable. The moment it did, a row that truthfully
     * said "the key was accepted without being checked, because this app publishes nothing safe to
     * try one on" began reading as a NAMED probe beside `verified: false`, which the settings page
     * draws as "your key was checked and rejected, and the account still stands — disconnect it".
     * Every clause of that is false for somebody whose key was never tried, and it persisted: it is
     * what every page load said until they pressed Re-check.
     *
     * SO THE WRITER RECORDS IT, and the writer is the one place that cannot be wrong about it.
     * `recordBrokeredConnection` is the single writer of this row, every caller knows what it spent
     * — a probe's name, or nothing — and it is passed in beside `verified` because the two are one
     * fact: what was checked, and how it went.
     *
     * NULL MEANS NO ACTION WAS SPENT, WHICH IS NOT THE SAME AS UNCHECKED. Read beside `verified` it
     * says which:
     *
     *   null, not verified   — nothing was tried, so nothing is known about the key. EITHER the app
     *                          published nothing safe to spend one on at the moment of the check,
     *                          OR a check was attempted and could not be made — Composio
     *                          unreachable, a socket closed, an answer `@composio/core` could not
     *                          parse. A fact about the app or about the vendor's availability, and
     *                          in neither case about the key.
     *
     *                          THE OUTAGE WAS NOT ALWAYS HERE, and where it used to land is the
     *                          reason this clause is spelled out. `callTool` answers with a result
     *                          rather than throwing, so every failure it has wears `isError`, and
     *                          the probe read that as the vendor's verdict: an outage was written
     *                          down as the FOURTH state below — the accusation — while the connect
     *                          path deleted the account somebody had just made and told them their
     *                          key was refused. An unreachable vendor is not a fifth state and has
     *                          no column of its own, because the row records what is KNOWN about a
     *                          connection and an outage establishes nothing: the honest record is
     *                          the mildest pair, and the trail carries the attempt. See
     *                          {@link BrokeredProbe} in `plugins/store.ts` for the four answers a
     *                          check can reach and which of them may be written here.
     *   null, verified       — a CONSENT connection. The vendor's own yes at the end of its own
     *                          screen is the evidence, and no call was ever made against the
     *                          account, so there is no action to name and there never will be.
     *                          Which is why `confirmBrokeredConnection`, the one writer of this
     *                          pair, writes it only for a consent app: on a key row it is not a
     *                          heal but one of the other three states overwritten by a page load.
     *   a name, verified     — it ran in this person's account and the vendor took the key.
     *   a name, not verified — it ran and the vendor refused the key, and the account it ran in is
     *                          still standing. A live account with a bad key behind it.
     *
     *                          AND ONLY A CALL THE VENDOR ANSWERED MAY WRITE IT. This pair is an
     *                          accusation — the settings page draws it as "your key was checked and
     *                          rejected, disconnect it" — so the name is withheld from every
     *                          outcome that cannot be shown to have run in the account. That is
     *                          structural rather than a rule anybody has to remember:
     *                          {@link BrokeredProbe} carries no action name on the unreachable
     *                          outcome, so the writer has none to record.
     *
     * AND NULL ON A ROW WRITTEN BEFORE THIS COLUMN EXISTED, which is the same null and deliberately
     * so. No backfill is possible or wanted: what a check spent in March is not recoverable, and
     * today's chooser answering for it is exactly the inference this column retires. The rows
     * migration 0038 touched are consent rows, where null is permanently right; a key row that
     * predates it reads as unchecked, the mildest of the four states and the only safe direction to
     * be uncertain in — a name invented for it would be the false accusation above, written down.
     *
     * WHAT A CALLER MUST NOT READ IT AS is "the action this app could be checked with now". That is
     * a different question, asked of `probeActionFor`, and the two answers diverge exactly when
     * the app's listing has moved since the check.
     */
    probeAction: text("probe_action"),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.toolkit, table.userId] }),
    // "What has this person connected" is the settings page's only query, and offboarding's.
    index("composio_connections_user_idx").on(table.userId),
  ],
);

/**
 * One person's grant on one MCP server: the row that makes a Bot answer as the asker.
 *
 * A table rather than a column, and this is the whole architectural point of the knowledge lane.
 * `mcp_servers.credential_id` holds what the DEPLOYMENT has — for a `user-oauth` vendor that is the
 * OAuth client, which reaches nobody's documents by itself. What reaches somebody's documents is
 * here, one row per person, and a call picks the row belonging to whoever asked. Two people asking
 * the same question therefore get the answers their own accounts can see, and neither can be served
 * the other's.
 *
 * The key is the pair. "Which credential serves this server for this person" must have exactly one
 * answer: with a surrogate id and no unique constraint, two rows for one pair are legal, and then
 * the answer is whichever the query happened to order first — so somebody who reconnected could keep
 * being served the grant they thought they had replaced.
 *
 * A pointer to the vault, never the secret, the same as everywhere else. The vault owns encryption,
 * rotation and revocation, and a second copy of a refresh token here would be a second thing to
 * remember to revoke when somebody disconnects.
 */
export const mcpUserCredentials = pgTable(
  "mcp_user_credentials",
  {
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * The vault row holding this person's refresh token.
     *
     * A real foreign key, unlike {@link mcpServers.credentialId}, which is `text` against a `uuid`
     * primary key and so references nothing the database will check. The new table does not copy
     * that.
     *
     * Deliberately not cascading. A revoked credential row is kept for the trail, and deleting the
     * row that says whose it was would take the trail with it.
     */
    credentialId: uuid("credential_id")
      .notNull()
      .references(() => credentials.id),
    /**
     * What the vendor actually granted, as it said it — not what we asked for.
     *
     * The two differ in practice: a person can decline part of a consent screen. Storing the reply
     * rather than the request means a tool failing for want of a scope can be explained instead of
     * being a mystery about a permission we assumed we had.
     */
    scope: text("scope").notNull(),
    /**
     * When this person connected.
     *
     * Written out rather than using the shared `createdAt()` helper, which fixes the column name to
     * `created_at`. This row records an act somebody performed and a date they are shown on their
     * own settings page, so it is worth the column saying which act.
     */
    connectedAt: timestamp("connected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.serverId, table.userId] }),
    index("mcp_user_credentials_user_idx").on(table.userId),
  ],
);

/**
 * A packaged skill: a named instruction a person invokes with `/` and a Bot follows.
 *
 * Not a tool, and the difference matters. A tool is something a Bot calls; a skill is something a
 * Bot is told. Writing one adds no capability at all: it can only ask a Bot to use what that Bot was
 * already granted, and every one of those calls is still decided, policy-checked and audited. The
 * firewall is at the tool call, not at the prose, which is why anybody may write a skill while
 * adding an MCP server stays an administrator's decision.
 */
export const skills = pgTable(
  "skills",
  {
    id: text("id").primaryKey(),
    /**
     * Whose skill this is. Null means the deployment's: written by an administrator, or shipped,
     * and offered to everybody.
     *
     * A person's own skill is theirs alone. They may write one freely and put it on a Bot they own,
     * and nobody else sees it in their `/` menu or their list.
     */
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    /**
     * What a person types after `/`, and unique across the deployment rather than per person.
     *
     * The `/` namespace is shared because Bots are shared: two different behaviours answering to
     * `/standup` in one deployment is confusing wherever the second one came from. First to take a
     * name keeps it, and the refusal says so.
     */
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    /** One line, shown in the catalogue and in the `/` menu. */
    summary: text("summary").notNull(),
    /** The instruction itself, prepended to the run when the skill is invoked. */
    instructions: text("instructions").notNull(),
    /** Where it came from: `catalogue` for one we ship, `yours` for one somebody wrote here. */
    origin: text("origin").notNull().default("yours"),
    installedBy: text("installed_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("skills_slug_key").on(table.slug),
    index("skills_owner_idx").on(table.ownerUserId),
  ],
);

/**
 * The tools a skill says it needs. A row is a declaration, and a declaration is not a grant.
 *
 * WHY THIS EXISTS. Choosing between a thousand tools is a retrieval problem, and the unit being
 * retrieved has to be the skill rather than the tool: a model picks the skill from its summary, and
 * the skill says which tools to load. Without this table there is no such unit. See K3.
 *
 * IT GRANTS NOTHING, AND THAT IS LOAD-BEARING RATHER THAN TIDY. Anybody signed in may write a skill,
 * precisely because a skill adds no capability — `plugins/routes.ts` says so where it declines to
 * require an administrator. If naming a tool here could make it callable, then writing a skill would
 * be a way to grant yourself a tool, and the one surface in this deployment that is deliberately not
 * an administrator's would become the way around every surface that is. What a Bot may call stays
 * `plugin_grants`; this only ever narrows what is offered out of what was already granted.
 *
 * NO FOREIGN KEY TO `mcp_tools`, on purpose. Refreshing a server deletes every one of its tool rows
 * and writes them again (`plugins/store.ts`), so a composite key with `on delete cascade` would empty
 * every skill's declarations on a routine refresh. `plugin_grants.ref` is plain text for the same
 * reason, and holding the two in the same shape is what lets them be compared without either side
 * parsing the other's format. The cost is a ref that can outlive the tool it names, which is the
 * price grants already pay, and is why a missing tool must read as "load nothing" rather than as an
 * error at run time.
 */
export const skillTools = pgTable(
  "skill_tools",
  {
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    /** `<serverId>/<toolName>`, the same key a grant is written against. */
    ref: text("ref").notNull(),
    declaredBy: text("declared_by"),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.skillId, table.ref] }),
    // Answering "which skills want this tool" without scanning, for the withdrawal question in #106.
    index("skill_tools_ref_idx").on(table.ref),
  ],
);

/**
 * One Bot's hold on one plugin, whether that plugin is an MCP tool or a skill. A row is the grant.
 *
 * Absence is the refusal, the same shape component grants use and for the same reason. A Bot
 * created before a server was added, a deployment that lost this table, a tool nobody ever enabled:
 * all of them land on "not granted", which is a refusal. An `enabled` boolean would make a missing
 * row undefined behaviour, and undefined behaviour in a grant table resolves to "allowed" the first
 * time somebody is in a hurry.
 *
 * One table for both kinds. `kind` says which, and `ref` names it: `<serverId>/<toolName>` for an
 * MCP tool, the slug for a skill. A second table would mean two code paths asking the same question
 * and two chances for them to disagree.
 */
export const pluginGrants = pgTable(
  "plugin_grants",
  {
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    grantedBy: text("granted_by"),
    grantedAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.ref, table.agentId] }),
    index("plugin_grants_agent_idx").on(table.agentId),
  ],
);

/**
 * A component authored in the browser rather than compiled into the build.
 *
 * This is not a column on `components`. That table governs components the build ships: its rows
 * describe something the code already owns, and a fork that deletes the React file leaves a row the
 * Admin page reports as missing. A sandboxed component has no React file and never will, so the
 * source is the row. Putting the source on the same table would mean every compiled component
 * carried three permanently empty columns, and "is this row backed by code" would become a question
 * about whether a text field happened to be blank.
 *
 * The two share the grant surface and the publish gate, because an operator deciding what a Bot may
 * answer with should not have to know which of the two they are looking at.
 */
export const sandboxedComponents = pgTable("sandboxed_components", {
  /** The tool name the model calls. Namespaced on save so it can never collide with a compiled one. */
  name: text("name").primaryKey(),
  title: text("title").notNull(),

  /**
   * The draft, which is what the playground edits, and the published copy, which is the only version
   * that ever renders or reaches a model.
   *
   * Separate columns rather than one live body. Publishing without a rebuild is the whole point of
   * this table, and it is also what makes an editor one keystroke away from changing what every Bot
   * draws in production. A draft absorbs that: it is edited freely, previewed against sample
   * arguments, and changes nothing until somebody publishes it. Same reason the catalogue splits a compiled
   * component's description, and the same fail-closed property: null published means no model is
   * ever offered this component, so a half-written draft cannot be called.
   */
  draftDescription: text("draft_description").notNull().default(""),
  draftHtml: text("draft_html").notNull().default(""),
  draftCss: text("draft_css").notNull().default(""),
  /**
   * Functions the body may call, as source. Runs inside `@jetbrains/websandbox`, so it reaches
   * neither the page, the session nor the network except through what the host hands it.
   */
  draftJsFunctions: text("draft_js_functions").notNull().default(""),
  /**
   * The arguments this component takes, as JSON Schema. This is what the model fills in, so it is
   * the difference between a component a model can use and one it will call wrongly forever.
   */
  draftArgumentSchema: jsonb("draft_argument_schema").notNull().default({}),

  publishedDescription: text("published_description"),
  publishedHtml: text("published_html"),
  publishedCss: text("published_css"),
  publishedJsFunctions: text("published_js_functions"),
  publishedArgumentSchema: jsonb("published_argument_schema"),

  /** Sample arguments the playground previews against, kept so the next editor sees what it draws. */
  sampleArguments: jsonb("sample_arguments").notNull().default({}),
  /** Bumped on every publish, so a reader can tell which version of a component drew something. */
  revision: integer("revision").notNull().default(0),
  published: boolean("published").notNull().default(false),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  authoredBy: text("authored_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

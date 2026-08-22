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
  /** The vendor this server is maintained by, which is what the first-party rule is checked against. */
  vendor: text("vendor").notNull(),
  url: text("url").notNull(),
  /**
   * `first-party` for a curated entry, `custom` for one an administrator added by URL.
   *
   * Recorded because the two are not the same risk. A curated entry has reviewed source provenance
   * and a pinned host. A custom one is a URL somebody typed, and every surface that lists it says so.
   * Storing which it is means the Plugins page, the audit trail and anybody reading the database
   * later all agree about how a server got here, rather than inferring it from whether the host
   * happens to still be in this build's catalogue.
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
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.serverId, table.name] })],
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

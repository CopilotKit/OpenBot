// server/tests/arcade-journey.integration.test.ts
/**
 * THE WHOLE ARCADE DEPLOYMENT, END TO END, THROUGH `createApp`.
 *
 * Select Arcade → browse the catalogue → enable an app → discover its actions → load the
 * connected-accounts index → authorize one action → come back through the verifier → execute a
 * call → disconnect. Every other Arcade suite checks one of those against its own factory; this one
 * is the only place they are checked against EACH OTHER, which is where a vendor's name written by
 * hand in one step and read by a parser in the next shows up.
 *
 * SO EVERY ASSERTION IS A PERSISTED FACT AND NEVER A STATUS CODE. A 201 says a route answered; what
 * the journey turns on is the ROW it left — `arcade://GoogleCalendar-…` with its capitals intact,
 * an `mcp_tools` row carrying the vendor's own `behavior`, a `pending_authorizations` row holding
 * the resolved identity, a `brokered_connections` row stamped `arcade`, an audit entry naming the
 * action and the scopes, and — on disconnect — the absence of all of them.
 *
 * AND THE SECOND HALF IS THE MERGE GATE. Two apps are switched to Shared, and the whole of what
 * keeps them apart is that each holds its own minted identity: the two sit under ONE auth provider
 * at the vendor, which is the configuration where a shared identity would be invisible until
 * somebody pressed Disconnect on one app and lost the other. That is exercised THROUGH THE PRODUCT
 * here — the mint the vendor was sent, the rows, the sibling preview and the disconnect — rather
 * than inferred from the unique indexes.
 *
 * NOTHING IS DIALLED. The vendor is stubbed at the SDK PROTOTYPE, the seam every other Arcade
 * adapter suite uses (`new Arcade({ apiKey })` opens no socket), so the REAL adapter and the REAL
 * transport run: `listApps`, `authProviderOf`, `authorize`, `auth.status`, `auth.confirmUser`,
 * `admin.userConnections` and `tools.execute` are this deployment's own code throughout, and only
 * the wire is fake.
 *
 * THE FIXTURE IS EVIDENCE AND THE TOOLKITS ARE A CASE. `arcade-catalogue.json` is read for the one
 * thing only a recording can be trusted about — the exact `metadata` a read, a write, a destructive
 * and an UNANNOTATED action are published with — and nothing is appended to it. The toolkits themselves are
 * constructed here, because the journey needs two apps sharing ONE auth provider, which is the
 * live `Gmail`/`GoogleCalendar`-under-`google` shape the adapter's own docblock describes and which
 * no single recorded page carries.
 *
 * WHY NO `execute` UNDER A SHARED APP'S IDENTITY IS DRIVEN HERE: coverage, not scope. The identity
 * hop is already pinned by name at `gate-grant-is-local.test.ts:183` ("a vendor-held grant on a
 * Shared app still runs as the app's shared identity"), which drives `connectionTokenFor`'s
 * `broker && !broker.grantIsLocal -> resolved.ref.vendorUserId` with a deployment ref; that ref
 * itself comes from `store.accountRefFor`, which this suite drives four times over. A shared execute
 * would add only provider-agnostic gate machinery, owned by `shared-gated-mode.integration.test.ts`.
 * If that test is deleted, this is the gap to re-check.
 *
 * `events.length === 1` IS A PER-ACTOR FACT, NOT A SYSTEM INVARIANT. `ON CONFLICT (actor_id)` proves
 * one actor cannot overlap himself. Two DIFFERENT admins pressing Authorize on the same Shared app
 * hold two attempt rows, both minting under the one shared vendor identity, and both completions
 * run: the connection upsert is idempotent so the row stays single, but the trail takes two
 * `mcp.account_connected` rows for one connection. That is consistent with D10 ("at most one
 * authorization in flight PER ACTOR") and is arguably the honest trail.
 *
 * THE TWO `describe` BLOCKS ARE ORDER-COUPLED: the merge-gate describe relies on the first having
 * enabled and connected both apps, and fails if run alone with `--test-name-pattern "two
 * separately-shared"`. That failure is not a defect.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import Arcade from "@arcadeai/arcadejs";
import { and, eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  brokeredConnections,
  mcpServers,
  mcpTools,
  pendingAuthorizations,
  pluginGrants,
} from "../src/db/schema";
import { createAccountModeSwitch } from "../src/plugins/account-mode";
import { useArcadeClient } from "../src/plugins/arcade";
import { createArcadeClient } from "../src/plugins/arcade-adapter";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import { createSharedUseStore } from "../src/plugins/shared-use-store";
import { createPluginStore } from "../src/plugins/store";
import fixture from "./fixtures/arcade-catalogue.json";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";
import { removePeople, seedPeople } from "./support/people";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const suite = randomUUID().slice(0, 8);
/**
 * Two toolkits whose CAPITALS CARRY MEANING. `GoogleCalendar-…` is the name a lowercasing step
 * anywhere between the picker and the transport would destroy, and the suite suffix is what makes
 * `audit_events` — which is append-only and cannot be cleaned between tests — answer about this run
 * and no other.
 */
const MAIL = `Gmail-${suite}`;
const DIARY = `GoogleCalendar-${suite}`;
const MAIL_ROW = `arcade-${MAIL}`;
const DIARY_ROW = `arcade-${DIARY}`;
const SEND = `${MAIL}.SendEmail`;
const DELETE_EVENT = `${DIARY}.DeleteEvent`;

/**
 * ONE AUTH PROVIDER FOR BOTH TOOLKITS, which is the whole point of the pair.
 *
 * `provider` is the BROKER (`arcade`); this is the VENDOR'S OAuth provider, and one Google
 * configuration serves Gmail and GoogleCalendar both. Deliberately nothing like either toolkit
 * name, so anything deriving one from the other fails here.
 */
const AUTH_PROVIDER = "google";

/**
 * AND THE CONFIGURATION OF IT THE CONNECTIONS ARE ACTUALLY HELD UNDER, which is a THIRD name.
 *
 * A tool listing's `provider_id` is the provider TYPE (`google`); a user-connection row's
 * `provider_id` is the provider INSTANCE — an operator's configuration of that type, which is what
 * the live project answers (`google-openbot`, `arcade-google`, `cpk-poc`). Spelled differently
 * here on purpose: a journey whose vendor used one spelling on both sides would be green against
 * an adapter that compares the two raw strings and finds nothing on every real deployment.
 */
const AUTH_PROVIDER_INSTANCE = `${AUTH_PROVIDER}-openbot`;

const ADMIN = `arcade-journey-${suite}`;
const BOT = `bot-${suite}`;
const APP_URL = "https://app.example";
/** A stand-in for the live `gho_…` the vendor's status reply carries beside the three fields. */
const LIVE_TOKEN = `gho_live_access_token_${suite}`;

const SCOPES: Record<string, string[]> = {
  [`${MAIL}.ListEmails`]: ["https://www.googleapis.com/auth/gmail.readonly"],
  [SEND]: ["https://www.googleapis.com/auth/gmail.send"],
  [`${MAIL}.TrashEmail`]: ["https://www.googleapis.com/auth/gmail.modify"],
  [`${DIARY}.ListEvents`]: [
    "https://www.googleapis.com/auth/calendar.readonly",
  ],
  [DELETE_EVENT]: ["https://www.googleapis.com/auth/calendar.events"],
};

/**
 * The `metadata` shapes, READ OUT OF THE RECORDING rather than written here — the whole object and
 * not just its `behavior`, so what the fold reads is the shape the vendor publishes. What a vendor
 * actually publishes is the one thing a hand-written literal cannot be trusted about, and it is
 * exactly what `classify` reads.
 *
 * `unclassified` IS A RECORDED `metadata: null`, AND IT IS WHAT MAKES THE COUNTS DISCRIMINATING. It
 * classifies to the SAME closed `{ write, destructive }` verdict a genuinely destructive action
 * does, so a toolkit whose every action is annotated cannot tell `classifiedCount` apart from
 * `actionCount` — the coverage warning that exists to name unannotated actions would be green
 * against a count that simply echoed the other.
 */
const recorded = fixture.tools as unknown as Record<
  string,
  { metadata: unknown }
>;
const METADATA = {
  read: recorded.read.metadata,
  write: recorded.write.metadata,
  destructive: recorded.destructive.metadata,
  unclassified: recorded.unclassified.metadata,
};

function action(
  toolkit: string,
  name: string,
  metadata: unknown,
): Record<string, unknown> {
  const qualified = `${toolkit}.${name}`;
  return {
    fully_qualified_name: `${qualified}@1.0.0`,
    qualified_name: qualified,
    name,
    description: `${name} at ${toolkit}`,
    toolkit: { name: toolkit, description: `Arcade tools for ${toolkit}` },
    input: {
      parameters: [
        {
          name: "q",
          required: true,
          description: "What to act on.",
          value_schema: { val_type: "string" },
        },
      ],
    },
    requirements: {
      /*
       * TRUE FOR EVERYBODY, AND NOTHING MAY READ IT. `requirements.met` answers true on a listing
       * asked without a `user_id`, which is every listing on this journey bar `grantsFor`'s. A step
       * that read it would record this run as connected to everything before a single consent, and
       * the journey below would still be green — so it is set true here on purpose.
       */
      met: true,
      authorization: {
        id: `arcade-${AUTH_PROVIDER}`,
        provider_id: AUTH_PROVIDER,
        provider_type: "oauth2",
        oauth2: { scopes: SCOPES[qualified] ?? [] },
        status: "inactive",
      },
    },
    metadata,
  };
}

/**
 * `DraftEmail` carries the recorded `metadata: null` AND NO SCOPES, which is the live
 * `Github`-shaped action: an `oauth2` block with an empty scope list, where the connection itself
 * is the grant. It is what separates all four of the picker's counts from one another.
 */
const CATALOGUE: Record<string, unknown>[] = [
  action(MAIL, "ListEmails", METADATA.read),
  action(MAIL, "SendEmail", METADATA.write),
  action(MAIL, "TrashEmail", METADATA.destructive),
  action(MAIL, "DraftEmail", METADATA.unclassified),
  action(DIARY, "ListEvents", METADATA.read),
  action(DIARY, "DeleteEvent", METADATA.destructive),
];

/**
 * The same listed action as the vendor publishes it when asked ABOUT an identity: with that
 * identity's own `token_status` — `completed` once it has consented, `not_started` before.
 *
 * `token_status` AND NOT `status`. The authorization's `status` is the AUTH PROVIDER's standing
 * (`inactive` / "Provider not found" in `fixtures/arcade-catalogue.json`), the same for everybody;
 * this fixture once flipped it to `active` to mean "this person consented", and the grants screen
 * read it that way — which is the K2 (A7c) defect: every action of a configured provider drawn as
 * held. The catalogue listing (no `user_id`) carries no `token_status`, as the live one does not.
 */
function askedAbout(
  item: Record<string, unknown>,
  consented: boolean,
): Record<string, unknown> {
  const requirements = item.requirements as Record<string, unknown>;
  const authorization = requirements.authorization as Record<string, unknown>;
  return {
    ...item,
    requirements: {
      ...requirements,
      authorization: {
        ...authorization,
        token_status: consented ? "completed" : "not_started",
      },
    },
  };
}

/* ------------------------------------------------------------------ the vendor, at its own wire */

type VendorConnection = {
  id: string;
  connection_id: string;
  provider_id: string;
  user_id: string;
  provider_user_info: { name: string };
};

/** What the vendor holds. One row per (identity, auth provider), which is how Arcade keys them. */
let vendorConnections: VendorConnection[] = [];
let authorizeCalls: Record<string, unknown>[] = [];
const executeCalls: Record<string, unknown>[] = [];
const deleted: string[] = [];
let mints = 0;
/** Every mint, by its `ar_…` id, and the newest one per identity for the return leg to name. */
const minted = new Map<string, { userId: string; scopes: string[] }>();
const newestMint = new Map<string, string>();

type Methods = Record<string, (...args: unknown[]) => unknown>;
const protoOf = (pick: (client: Arcade) => unknown): Methods =>
  Object.getPrototypeOf(pick(new Arcade({ apiKey: "never-dialled" })));

const restores: (() => void)[] = [];
function stub(
  pick: (client: Arcade) => unknown,
  name: string,
  impl: (...args: unknown[]) => unknown,
) {
  const on = protoOf(pick);
  const was = on[name];
  on[name] = impl;
  restores.push(() => {
    on[name] = was;
  });
}

/** The vendor's connection for one identity under this journey's single auth provider. */
function holdConnection(userId: string) {
  if (vendorConnections.some((row) => row.user_id === userId)) return;
  const n = vendorConnections.length + 1;
  vendorConnections.push({
    id: `at_${n}`,
    connection_id: `ac_${n}`,
    provider_id: AUTH_PROVIDER_INSTANCE,
    user_id: userId,
    provider_user_info: { name: `Account ${n}` },
  });
}

function installVendor() {
  stub(
    (client) => client.tools,
    "list",
    (...args: unknown[]) => {
      const query = (args[0] ?? {}) as {
        toolkit?: string;
        limit?: number;
        offset?: number;
        user_id?: string;
      };
      const items = CATALOGUE.filter(
        (item) =>
          !query.toolkit ||
          (item.toolkit as { name: string }).name === query.toolkit,
      ).map((item) =>
        /*
         * A LISTING ASKED ABOUT SOMEBODY ANSWERS ABOUT THEM, which is the only difference the
         * `user_id` makes and the whole of what `grantsFor` is reading. `met` stays true on every
         * item either way (see `action`), so a step reading it instead of the authorization's own
         * `token_status` would report this run as holding every grant before a single consent.
         */
        query.user_id
          ? askedAbout(
              item,
              vendorConnections.some((r) => r.user_id === query.user_id),
            )
          : item,
      );
      const offset = query.offset ?? 0;
      const limit = query.limit ?? items.length;
      return Promise.resolve({
        items: items.slice(offset, offset + limit),
        total_count: items.length,
      });
    },
  );

  stub(
    (client) => client.tools,
    "authorize",
    (...args: unknown[]) => {
      const request = args[0] as { tool_name: string; user_id: string };
      authorizeCalls.push({ ...request });
      mints += 1;
      const id = `ar_${mints}`;
      minted.set(id, {
        userId: request.user_id,
        scopes: SCOPES[request.tool_name] ?? [],
      });
      newestMint.set(request.user_id, id);
      return Promise.resolve({
        id,
        // A BEARER CAPABILITY. It goes to the caller and nowhere else; the suite checks that
        // nothing else it touches ever carries it.
        url: `https://vendor.example/consent/${id}?secret=bearer-capability`,
        status: "pending",
      });
    },
  );

  stub(
    (client) => client.tools,
    "execute",
    (...args: unknown[]) => {
      const request = args[0] as {
        tool_name: string;
        input: Record<string, unknown>;
        user_id: string;
      };
      executeCalls.push({ ...request });
      return Promise.resolve({
        success: true,
        output: { value: { ran: request.tool_name } },
      });
    },
  );

  stub(
    (client) => client.auth,
    "confirmUser",
    (...args: unknown[]) => {
      const request = args[0] as { flow_id: string; user_id: string };
      // The consent finished at the vendor BEFORE this deployment looked, which is the true order.
      holdConnection(request.user_id);
      return Promise.resolve({
        auth_id: newestMint.get(request.user_id) ?? "ar_unknown",
      });
    },
  );

  stub(
    (client) => client.auth,
    "status",
    (...args: unknown[]) => {
      const { id } = args[0] as { id: string };
      const mint = minted.get(id);
      /*
       * DELIBERATELY WIDER THAN THE SEAM. The live reply carries a working provider access token
       * and the person's whole profile beside the three fields the adapter narrows to, and the
       * point of sending them here is that nothing downstream can be carrying either.
       */
      return Promise.resolve({
        id,
        status: "completed",
        user_id: mint?.userId ?? "",
        scopes: mint?.scopes ?? [],
        context: { token: LIVE_TOKEN, user_info: { email: "person@vendor" } },
        url: `https://vendor.example/consent/${id}?secret=bearer-capability`,
      });
    },
  );

  /*
   * THE PROJECT'S CONFIGURED AUTH PROVIDERS, in the live shape: `id` is the INSTANCE and
   * `provider_id` is the TYPE. This is the listing that bridges a toolkit's type to the instance
   * ids its connection rows carry; `cpk-poc` is here so the bridge has something to exclude.
   */
  stub(
    (client) => client.admin.authProviders,
    "list",
    () =>
      Promise.resolve({
        items: [
          { id: "cpk-poc", provider_id: "github", type: "oauth2" },
          {
            id: AUTH_PROVIDER_INSTANCE,
            provider_id: AUTH_PROVIDER,
            type: "oauth2",
          },
        ],
        total_count: 2,
      }),
  );

  stub(
    (client) => client.admin.userConnections,
    "list",
    (...args: unknown[]) => {
      const { user_id: userId } = args[0] as { user_id: string };
      const rows = vendorConnections.filter((row) => row.user_id === userId);
      // A PAGE, as the real `list` resolves to. `connectionsFor` pages the listing itself: the
      // SDK's own auto-pagination stops after page one when the engine omits `total_count`.
      return Promise.resolve({
        items: rows,
        offset: 0,
        total_count: rows.length,
      });
    },
  );

  stub(
    (client) => client.admin.userConnections,
    "delete",
    (...args: unknown[]) => {
      const id = args[0] as string;
      deleted.push(id);
      vendorConnections = vendorConnections.filter(
        (row) => row.connection_id !== id,
      );
      return Promise.resolve();
    },
  );
}

/* --------------------------------------------------------------------- the deployment, as booted */

let broker: ConnectedAppBroker;

/**
 * The deployment as `createApp` builds it.
 *
 * Positional, by index rather than by a run of `undefined`s, for the reason
 * `shared-wiring.integration.test.ts` gives: a parameter added in the middle then moves a type
 * error onto the wrong index here rather than shifting an argument silently.
 */
function build() {
  const auditStore = createAuditStore(database);
  const pluginStore = createPluginStore({
    brokerProvider: "arcade",
    database,
    auditStore,
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    broker,
    deploymentId: `acme-${suite}`,
  });
  const use = createSharedUseStore(database, "arcade");
  const modes = createAccountModeSwitch({
    store: pluginStore,
    sharedUse: use,
    teamRules: undefined,
    deploymentId: `acme-${suite}`,
    audit: auditStore,
  });
  const args = new Array(createApp.length) as unknown as Parameters<
    typeof createApp
  >;
  args[0] = loadConfig(testEnvironment({ OPENBOT_APP_URL: APP_URL }));
  args[1] = {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async () => ({
        user: { id: ADMIN, email: `${ADMIN}@example.test`, name: "Admin" },
      }),
    },
  } as never;
  args[2] = { rolesForUser: async () => ["admin"] } as never;
  args[12] = auditStore;
  args[14] = pluginStore;
  args[29] = { broker, provider: "arcade" } as never;
  args[34] = { shared: { modes, use } } as never;
  return createApp(...args);
}

const api = (path: string, init?: RequestInit) =>
  build().request(`http://openbot.test/api/plugins${path}`, init);

const send = (method: string, path: string, body: unknown) =>
  api(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/* -------------------------------------------------------------------------------- what persisted */

async function serverRow(id: string) {
  const [row] = await database
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.id, id));
  return row ?? null;
}

async function toolRows(serverId: string) {
  return (
    await database
      .select({
        name: mcpTools.name,
        /* Both spellings, because the split between them is the thing under test: `name` is what a
           grant and an offered tool name are built from, `vendorName` what Arcade is called by. */
        vendorName: mcpTools.vendorName,
        effect: mcpTools.effect,
        destructive: mcpTools.destructive,
      })
      .from(mcpTools)
      .where(eq(mcpTools.serverId, serverId))
  ).sort((left, right) => (left.name < right.name ? -1 : 1));
}

async function connectionsOf(app: string) {
  return await database
    .select()
    .from(brokeredConnections)
    .where(eq(brokeredConnections.app, app));
}

/**
 * The trail for one app and one event type, OLDEST FIRST — and the order is asked for rather than
 * inherited.
 *
 * `.at(-1)` below means "the disconnect this test just caused", which a `SELECT` with no `ORDER BY`
 * does not answer: PostgreSQL may return the rows of an unordered read in any order it likes, and
 * what it actually returns is roughly heap order. Insertion order and time order agree on a table
 * only ever appended to by one test, which is why this read passed locally and failed on CI — there
 * the last row back was the PERSONAL disconnect from the describe above, so a Shared app's audit
 * entry was read as a person ending their own account, and the assertion reported a defect in the
 * product that the product had not committed.
 *
 * `createdAt` is the only key that can carry this: `id` is a random UUID, so it sorts arbitrarily.
 * The disconnects it separates arrive on their own requests and so in their own transactions, which
 * is what makes their `now()` values distinct.
 */
async function eventsOn(app: string, eventType: string) {
  return await database
    .select()
    .from(auditEvents)
    .where(
      and(eq(auditEvents.targetId, app), eq(auditEvents.eventType, eventType)),
    )
    .orderBy(auditEvents.createdAt);
}

async function attemptRow() {
  const [row] = await database
    .select()
    .from(pendingAuthorizations)
    .where(eq(pendingAuthorizations.actorId, ADMIN));
  return row ?? null;
}

/**
 * One whole consent: mint through the product, come back through the verifier.
 *
 * THE TWO HALVES ARE ONE OBJECT BECAUSE THE ATTEMPT KEY IS ONE ROW. `pending_authorizations` is
 * keyed on the actor, so a second mint by the same person while the first is live is answered 409
 * and NOTHING GOES OUT — a return leg driven from a fresh `consent()` call would be verifying the
 * EARLIER mint while reading as though it had just made one. So a mint is handed back with its own
 * return leg attached, and the suite completes the mint it actually made.
 */
async function consent(serverRowId: string, actionName: string) {
  const minting = await send("POST", `/servers/${serverRowId}/authorize`, {
    action: actionName,
  });
  const body = (await minting.json()) as { authorizationUrl?: string };
  return {
    minting,
    authorizationUrl: body.authorizationUrl,
    returning: () =>
      api(`/arcade/verify?flow_id=flow-${encodeURIComponent(actionName)}`),
  };
}

beforeAll(async () => {
  // The administrator walking this journey is a real `users` row, because the attempt rows minted
  // along the way key to one on `actor_id` (with `user_id` held equal to it) and cascade from it.
  await seedPeople(database, [ADMIN]);
  installVendor();
  const client = createArcadeClient("never-dialled");
  broker = client.broker;
  useArcadeClient(client.actions);
  await database.insert(agents).values({
    id: BOT,
    name: "Helper",
    type: "built_in",
    configuration: {},
  });
});

afterAll(async () => {
  useArcadeClient(null);
  while (restores.length) restores.pop()?.();
  await database
    .delete(pendingAuthorizations)
    .where(eq(pendingAuthorizations.actorId, ADMIN));
  await database
    .delete(brokeredConnections)
    .where(inArray(brokeredConnections.app, [MAIL, DIARY]));
  await database
    .delete(mcpServers)
    .where(inArray(mcpServers.id, [MAIL_ROW, DIARY_ROW]));
  await database.delete(agents).where(eq(agents.id, BOT));
  await removePeople(database, [ADMIN]);
  await database.$client.close();
});

describe("an Arcade deployment, from the picker to the disconnect", () => {
  /** The personal leg's one mint, completed by the verifier test below. See {@link consent}. */
  let personal: Awaited<ReturnType<typeof consent>> | null = null;

  test("the catalogue an administrator chooses from is Arcade's own", async () => {
    const response = await api("/composio/apps");
    expect(response.status).toBe(200);
    const { apps } = (await response.json()) as {
      apps: Record<string, unknown>[];
    };
    const mail = apps.find((app) => app.slug === MAIL);
    const diary = apps.find((app) => app.slug === DIARY);

    /*
     * COUNTED ACROSS THE FULL LISTING, and the toolkit names come back exactly as published. The
     * four counts are four different numbers here on purpose: `DraftEmail` is annotated by nobody
     * and asks for no scopes, so a count derived from any of the others is wrong about one of them.
     */
    expect(mail).toMatchObject({
      slug: MAIL,
      name: MAIL,
      actionCount: 4,
      classifiedCount: 3,
      scopedActionCount: 3,
      permissionCount: 3,
      enabled: false,
    });
    expect(diary).toMatchObject({
      slug: DIARY,
      actionCount: 2,
      classifiedCount: 2,
      enabled: false,
    });
  });

  test("enabling an app writes an arcade row whose url keeps the vendor's case", async () => {
    /*
     * THE LOWERCASED TOOLKIT IS NOT AN APP ARCADE LISTS, and enabling it would write a second row
     * at `arcade://gmail-…` that every later call resolves against and that reaches nothing. The
     * directory is what the slug is checked against rather than a pattern, so this is that check
     * read through the one listing both halves of the picker share.
     */
    const folded = await send("POST", "/composio/apps", {
      slug: MAIL.toLowerCase(),
    });
    expect(folded.status).toBe(400);
    expect(await serverRow(`arcade-${MAIL.toLowerCase()}`)).toBeNull();

    for (const toolkit of [MAIL, DIARY]) {
      const response = await send("POST", "/composio/apps", { slug: toolkit });
      expect([response.status, toolkit]).toEqual([201, toolkit]);
    }

    for (const [toolkit, rowId] of [
      [MAIL, MAIL_ROW],
      [DIARY, DIARY_ROW],
    ]) {
      const row = await serverRow(rowId);
      expect(row).toMatchObject({
        id: rowId,
        // THE BROKER, spelled as the column spells it — never derived at the call site.
        provenance: "arcade",
        vendor: "Arcade",
        url: `arcade://${toolkit}`,
        accountMode: "personal",
      });
      // CASE INTACT. `GoogleCalendar-…` lowercased reaches nothing at Arcade, and this is the one
      // place the name crosses from the vendor's catalogue into a column.
      expect(row?.url).not.toBe(row?.url.toLowerCase());
      expect(row?.authScheme).not.toBeNull();
    }

    // And the picker now says so, through the same parser the transport dials with.
    const { apps } = (await (await api("/composio/apps")).json()) as {
      apps: { slug: string; enabled: boolean }[];
    };
    expect(
      apps
        .filter((app) => [MAIL, DIARY].includes(app.slug))
        .map((app) => app.enabled),
    ).toEqual([true, true]);
  });

  test("discovery records the effect and the destructive flag the vendor published", async () => {
    for (const rowId of [MAIL_ROW, DIARY_ROW]) {
      const response = await send("POST", `/servers/${rowId}/refresh`, {});
      expect([response.status, rowId]).toEqual([200, rowId]);
    }

    /*
     * TWICE, because an administrator presses Refresh twice and the second press must replace what
     * the first recorded rather than add to it: a duplicated `mcp_tools` row is an action a model is
     * offered twice and a grant that names two rows.
     */
    const again = await send("POST", `/servers/${MAIL_ROW}/refresh`, {});
    expect(again.status).toBe(200);

    expect(await toolRows(MAIL_ROW)).toEqual([
      // NOTHING SAID, SO IT FAILS CLOSED: an unannotated action is approved like a deletion.
      {
        name: "DraftEmail",
        vendorName: `${MAIL}.DraftEmail`,
        effect: "write",
        destructive: true,
      },
      {
        name: "ListEmails",
        vendorName: `${MAIL}.ListEmails`,
        effect: "read",
        destructive: false,
      },
      {
        name: "SendEmail",
        vendorName: `${MAIL}.SendEmail`,
        effect: "write",
        destructive: false,
      },
      {
        name: "TrashEmail",
        vendorName: `${MAIL}.TrashEmail`,
        effect: "write",
        destructive: true,
      },
    ]);
    expect(await toolRows(DIARY_ROW)).toEqual([
      {
        name: "DeleteEvent",
        vendorName: `${DIARY}.DeleteEvent`,
        effect: "write",
        destructive: true,
      },
      {
        name: "ListEvents",
        vendorName: `${DIARY}.ListEvents`,
        effect: "read",
        destructive: false,
      },
    ]);
  });

  test("the connected-accounts index answers, and claims no account nobody made", async () => {
    const response = await api("/connections");
    expect(response.status).toBe(200);
    const { connections } = (await response.json()) as {
      connections: { serverId: string }[];
    };
    expect(
      connections.filter((row) => [MAIL_ROW, DIARY_ROW].includes(row.serverId)),
    ).toEqual([]);
  });

  test("the account page says what is held before a consent, and reads no met flag to say it", async () => {
    const { actions } = (await (
      await api(`/servers/${MAIL_ROW}/grants`)
    ).json()) as { actions: { action: string; state: string }[] };

    /*
     * NOTHING IS HELD, AND `requirements.met` IS TRUE FOR EVERY ONE OF THESE ACTIONS. The two sit
     * in the same object and behave oppositely, and this is the assertion that tells them apart: a
     * read of `met` answers `authorized` for all four before anybody has consented to anything,
     * and the only visible consequence would be a page offering to call somebody else's mailbox.
     */
    expect(actions.map((entry) => [entry.action, entry.state]).sort()).toEqual([
      [`${MAIL}.DraftEmail`, "needs-consent"],
      [`${MAIL}.ListEmails`, "needs-consent"],
      [`${MAIL}.SendEmail`, "needs-consent"],
      [`${MAIL}.TrashEmail`, "needs-consent"],
    ]);
  });

  test("authorizing one action claims an attempt holding the RESOLVED identity", async () => {
    /*
     * THE SAME ACTION IN LOWER CASE IS NOT AN ACTION THIS APP PUBLISHES, and that is the discovery
     * above read back through the authorize route's own `===`. It is checked BEFORE the real mint
     * so that nothing has been claimed: a route that folded case here would mint a consent for an
     * action name that reaches nothing at Arcade, and the 400 is what says the stored names kept
     * their capitals all the way from the catalogue.
     */
    const folded = await send("POST", `/servers/${MAIL_ROW}/authorize`, {
      action: SEND.toLowerCase(),
    });
    expect(folded.status).toBe(400);
    // NOTHING WENT OUT AND NOTHING WAS CLAIMED, which is what makes the mint below the first one.
    expect(authorizeCalls).toEqual([]);
    expect(await attemptRow()).toBeNull();

    personal = await consent(MAIL_ROW, SEND);
    const { minting, authorizationUrl } = personal;
    expect(minting.status).toBe(200);
    expect(authorizationUrl).toBe(
      "https://vendor.example/consent/ar_1?secret=bearer-capability",
    );

    /*
     * WHAT WENT OUT, AND NOTHING ELSE WENT WITH IT. `next_uri` is declared by the SDK and refused by
     * the API for every value, so the mint carries exactly two fields.
     */
    expect(authorizeCalls).toEqual([{ tool_name: SEND, user_id: ADMIN }]);

    const attempt = await attemptRow();
    expect(attempt).toMatchObject({
      serverId: MAIL_ROW,
      action: SEND,
      holder: "person",
      userId: ADMIN,
      vendorUserId: ADMIN,
      authId: "ar_1",
      completedAt: null,
      outcome: null,
    });
  });

  test("the verifier writes one arcade connection and one audit entry naming the action and the scopes", async () => {
    // THE RETURN LEG OF THE MINT THE TEST ABOVE MADE, and of no other: see {@link consent}.
    const response = await personal?.returning();
    expect(response?.status).toBe(303);
    // STILL ONE MINT. A second one here would mean the return leg was verifying somebody else's.
    expect(authorizeCalls).toEqual([{ tool_name: SEND, user_id: ADMIN }]);
    expect(response?.headers.get("location")).toBe(
      `${APP_URL}/connections/${MAIL_ROW}?action=${encodeURIComponent(SEND)}`,
    );

    const connections = await connectionsOf(MAIL);
    expect(connections.length).toBe(1);
    expect(connections[0]).toMatchObject({
      provider: "arcade",
      app: MAIL,
      holder: "person",
      userId: ADMIN,
      vendorUserId: ADMIN,
      verified: true,
    });

    const events = await eventsOn(MAIL, "mcp.account_connected");
    expect(events.length).toBe(1);
    expect(events[0]?.payload).toMatchObject({
      action: SEND,
      scope: "https://www.googleapis.com/auth/gmail.send",
      // THE BROKER'S ANSWER, read off the listing and never derived from `Gmail-…`.
      authProvider: AUTH_PROVIDER,
    });
    // NOTHING FROM THE STATUS REPLY TRAVELS. It carries a live provider access token.
    expect(JSON.stringify(events[0]?.payload)).not.toContain(LIVE_TOKEN);
    expect(JSON.stringify(events[0]?.payload)).not.toContain("vendor.example");

    expect(await attemptRow()).toMatchObject({ outcome: "completed" });

    /*
     * AND THE INDEX NOW DRAWS IT, as the row the completion wrote rather than merely as an id:
     * `verified` is what the consent earned and `probe` is what nothing was spent on, and a page
     * reading one as the other is the pair `brokeredConnectionsFor` exists to keep apart.
     */
    const { connections: listed } = (await (
      await api("/connections")
    ).json()) as {
      connections: { serverId: string; holder: string; verified: boolean }[];
    };
    expect(
      listed.filter((row) => [MAIL_ROW, DIARY_ROW].includes(row.serverId)),
    ).toMatchObject([{ serverId: MAIL_ROW, holder: "person", verified: true }]);

    // AND THE ACCOUNT PAGE NOW READS THE CONSENT BACK OFF THE VENDOR, under this identity.
    const { actions } = (await (
      await api(`/servers/${MAIL_ROW}/grants`)
    ).json()) as { actions: { action: string; state: string }[] };
    expect(new Set(actions.map((entry) => entry.state))).toEqual(
      new Set(["authorized"]),
    );
  });

  test("a call goes out as the identity this deployment resolved", async () => {
    await database.insert(pluginGrants).values({
      kind: "mcp",
      ref: `${MAIL_ROW}/${SEND}`,
      agentId: BOT,
      grantedBy: ADMIN,
    });

    const response = await send("POST", "/call", {
      ref: `${MAIL_ROW}/${SEND}`,
      agentId: BOT,
      args: { q: "hello" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ isError: false });

    expect(executeCalls).toEqual([
      { tool_name: SEND, input: { q: "hello" }, user_id: ADMIN },
    ]);
  });

  test("a second app on the same identity is its own connection", async () => {
    const response = await (await consent(DIARY_ROW, DELETE_EVENT)).returning();
    expect(response.status).toBe(303);

    const diary = await connectionsOf(DIARY);
    expect(diary.length).toBe(1);
    expect(diary[0]).toMatchObject({
      provider: "arcade",
      holder: "person",
      vendorUserId: ADMIN,
    });
    // One identity, one auth provider: the vendor holds ONE connection serving both apps.
    expect(vendorConnections.map((row) => row.user_id)).toEqual([ADMIN]);
  });

  test("disconnecting ends every app that revocation ends, and says so on the trail", async () => {
    // The warning an administrator is shown before the press, from the store and never derived here.
    const preview = await api(`/servers/${MAIL_ROW}/connection/siblings`);
    expect(await preview.json()).toEqual({ siblings: [DIARY], unanswered: 0 });

    const response = await api(`/servers/${MAIL_ROW}/connection`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ vendorRevocationRequested: true });

    // EVERY LOCAL ROW ENDED. A row left for the diary would claim an account the vendor no longer
    // holds, which is the other way to lie.
    expect(await connectionsOf(MAIL)).toEqual([]);
    expect(await connectionsOf(DIARY)).toEqual([]);
    expect(vendorConnections).toEqual([]);
    // THE `ac_…` connection_id, never the `at_…` id the listing prints first.
    expect(deleted).toEqual(["ac_1"]);

    const mailEvents = await eventsOn(MAIL, "mcp.account_disconnected");
    const diaryEvents = await eventsOn(DIARY, "mcp.account_disconnected");
    expect(mailEvents.length).toBe(1);
    expect(diaryEvents.length).toBe(1);
    expect(mailEvents[0]?.payload).toMatchObject({
      server: MAIL,
      owner: ADMIN,
      reason: "self",
      vendorRevocationRequested: true,
      unansweredSiblings: 0,
    });
    // The sibling's row names the app whose disconnect ended it.
    expect(diaryEvents[0]?.payload).toMatchObject({
      server: DIARY,
      endedWith: MAIL,
    });

    // AND THE INDEX CLAIMS NEITHER OF THEM ANY MORE, which is where somebody would otherwise be
    // shown a Connected row over an account Arcade no longer holds.
    const { connections } = (await (await api("/connections")).json()) as {
      connections: { serverId: string }[];
    };
    expect(
      connections.filter((row) => [MAIL_ROW, DIARY_ROW].includes(row.serverId)),
    ).toEqual([]);
  });
});

/**
 * THE MERGE GATE.
 *
 * Two apps, both Shared, both under ONE auth provider at the vendor. The only thing keeping their
 * accounts apart is that each app holds its OWN minted identity, and the test of that is the
 * product: what the mint was sent, what the rows say, what the sibling preview answers, and what
 * survives a disconnect.
 */
describe("two separately-shared apps", () => {
  let mailIdentity = "";
  let diaryIdentity = "";

  test("each gets its own deployment identity when it is switched to Shared", async () => {
    for (const rowId of [MAIL_ROW, DIARY_ROW]) {
      const response = await send("PUT", `/servers/${rowId}/account-mode`, {
        mode: "shared",
        confirm: true,
      });
      expect([response.status, rowId]).toEqual([200, rowId]);
      expect(await response.json()).toMatchObject({ changed: true });
    }

    mailIdentity = (await serverRow(MAIL_ROW))?.sharedVendorUserId ?? "";
    diaryIdentity = (await serverRow(DIARY_ROW))?.sharedVendorUserId ?? "";

    expect(mailIdentity).toStartWith(`openbot-deployment:acme-${suite}:`);
    expect(diaryIdentity).toStartWith(`openbot-deployment:acme-${suite}:`);
    // SEPARATE. A shared identity here is the defect this whole describe exists to catch.
    expect(mailIdentity).not.toBe(diaryIdentity);

    // And the index draws a Shared app whether or not anything is connected to it yet.
    const { connections } = (await (await api("/connections")).json()) as {
      connections: { serverId: string; holder: string; connected: boolean }[];
    };
    expect(
      connections.filter((row) => [MAIL_ROW, DIARY_ROW].includes(row.serverId)),
    ).toMatchObject([
      { serverId: MAIL_ROW, holder: "deployment", connected: false },
      { serverId: DIARY_ROW, holder: "deployment", connected: false },
    ]);
  });

  test("each app's consent is minted and recorded under its own identity", async () => {
    authorizeCalls = [];

    for (const [rowId, actionName, identity, app] of [
      [MAIL_ROW, SEND, mailIdentity, MAIL],
      [DIARY_ROW, DELETE_EVENT, diaryIdentity, DIARY],
    ] as const) {
      const minting = await consent(rowId, actionName);
      expect(minting.minting.status).toBe(200);

      const attempt = await attemptRow();
      expect(attempt).toMatchObject({
        serverId: rowId,
        action: actionName,
        holder: "deployment",
        userId: null,
        vendorUserId: identity,
      });

      const response = await minting.returning();
      expect(response.status).toBe(303);
      /*
       * AND IT LANDS WHERE THE ACTION IS READ, which for a deployment-held account is the same
       * settings page a personal one lands on. It used to go to `/admin/plugins/:key`, the screen
       * the Authorize was pressed from — but that route reads no `?action=` and draws no grant
       * list, so the Shared-app flow ended on a page that said nothing about the consent just
       * given.
       */
      expect(response.headers.get("location")).toBe(
        `${APP_URL}/connections/${rowId}?action=${encodeURIComponent(actionName)}`,
      );

      const connections = await connectionsOf(app);
      expect(connections.length).toBe(1);
      expect(connections[0]).toMatchObject({
        provider: "arcade",
        holder: "deployment",
        userId: null,
        vendorUserId: identity,
        verified: true,
      });
    }

    // WHAT THE VENDOR WAS SENT, per app, which is where a shared identity would show first.
    expect(authorizeCalls).toEqual([
      { tool_name: SEND, user_id: mailIdentity },
      { tool_name: DELETE_EVENT, user_id: diaryIdentity },
    ]);
    // TWO CONNECTIONS AT THE VENDOR under ONE auth provider, kept apart by identity alone.
    expect(vendorConnections.map((row) => row.user_id)).toEqual([
      mailIdentity,
      diaryIdentity,
    ]);
    expect(new Set(vendorConnections.map((row) => row.provider_id)).size).toBe(
      1,
    );

    /*
     * AND THE INDEX DRAWS EACH APP'S OWN ACCOUNT, which is the merge gate at the one place it is
     * VISIBLE. Both rows stand at once, under one auth provider at the vendor, so the name beside
     * each is read through `accountName` for THAT app's identity — an account-name lookup that
     * asked by provider alone would answer both rows with the first identity's account, and
     * somebody would be shown the wrong team mailbox on a page offering to disconnect it.
     */
    const { connections } = (await (await api("/connections")).json()) as {
      connections: {
        serverId: string;
        holder: string;
        connected: boolean;
        verified: boolean;
        displayName: string | null;
      }[];
    };
    expect(
      connections.filter((row) => [MAIL_ROW, DIARY_ROW].includes(row.serverId)),
    ).toMatchObject([
      {
        serverId: MAIL_ROW,
        holder: "deployment",
        connected: true,
        verified: true,
        displayName: "Account 1",
      },
      {
        serverId: DIARY_ROW,
        holder: "deployment",
        connected: true,
        verified: true,
        displayName: "Account 2",
      },
    ]);
  });

  test("ending one leaves the other standing, and nothing says otherwise", async () => {
    // NOT SIBLINGS, though they share an auth provider: the identities differ.
    const preview = await api(`/servers/${MAIL_ROW}/connection/siblings`);
    expect(await preview.json()).toEqual({ siblings: [], unanswered: 0 });

    const before = (await eventsOn(DIARY, "mcp.account_disconnected")).length;

    const response = await api(`/servers/${MAIL_ROW}/connection`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);

    expect(await connectionsOf(MAIL)).toEqual([]);
    const diary = await connectionsOf(DIARY);
    expect(diary.length).toBe(1);
    expect(diary[0]).toMatchObject({ vendorUserId: diaryIdentity });
    expect(vendorConnections.map((row) => row.user_id)).toEqual([
      diaryIdentity,
    ]);

    // The diary was not disconnected, so nothing on the trail says it was.
    expect((await eventsOn(DIARY, "mcp.account_disconnected")).length).toBe(
      before,
    );
    const mailEvents = await eventsOn(MAIL, "mcp.account_disconnected");
    expect(mailEvents.length).toBe(2);
    expect(mailEvents.at(-1)?.payload).toMatchObject({
      server: MAIL,
      owner: "deployment",
      reason: "admin",
      unansweredSiblings: 0,
    });
  });
});

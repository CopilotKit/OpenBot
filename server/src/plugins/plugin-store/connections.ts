import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { createAuditStore, recordAuditEvent } from "../../audit";
import type { Database } from "../../db/client";
import {
  brokeredConnections,
  credentials as credentialRows,
  mcpServers,
  mcpTools,
  mcpUserCredentials,
  pendingAuthorizations,
  users,
  vendorNameOf,
} from "../../db/schema";
import { BROKERED_PROFILE, toolkitOfFor } from "../access";
import {
  BrokerRefusalError,
  BrokerUnconfiguredError,
  type Decides,
  isFieldScheme,
  type SchemeKind,
} from "../broker";
import {
  asksForArguments,
  askAction as composioAskAction,
  VERSION_ARG,
} from "../composio";
import { type AccountRef, personAccount } from "../shared-accounts";
import type { StoreContext } from "./context";
import {
  attemptNamed,
  type BrokeredProbe,
  IDENTITY_ACTION,
  iso,
  type OAuthClient,
  type PendingAuthorization,
  PluginRefusedError,
  pendingAuthorizationFromRow,
} from "./model";

/** OAuth clients and a person's connections, including every brokered (Composio) connection flow. */
export function connectionMethods(context: StoreContext) {
  const {
    options,
    database,
    auditStore,
    credentials,
    registerClient,
    broker,
    accountRow,
    swapUserCredential,
    withOAuthClientLock,
    heldOAuthClient,
    writeOAuthClient,
    recordClientRegistered,
    persistOAuthClient,
    storedOAuthClient,
    requireServer,
    brokeredAppRow,
    brokeredAppRowsAt,
    brokeredAppScheme,
    brokeredAppKind,
    brokerProvider,
    closeAuthorizationAttempt,
    resolveSiblings,
    consentRevokeReaches,
    vendorRevocationClaim,
    siblingsEndedBy,
    clearEndedSiblings,
  } = context;
  return {
    /**
     * Register the deployment's OAuth client for a `user-oauth` server.
     *
     * An administrator pasting in what they created at the vendor. The work itself is
     * {@link persistOAuthClient}, which self-registration goes through too — one path, so a client
     * this deployment issued itself is stored, revoked and recorded exactly like a pasted one.
     */
    registerOAuthClient: persistOAuthClient,

    /**
     * The client to send somebody to the vendor with, registering one first if that is this
     * vendor's way of getting one.
     *
     * A dynamically registered client is not paperwork anybody did: there is no console entry to
     * paste, so "none yet" is the ordinary state of a server nobody has connected — and the answer
     * is for the deployment to introduce itself, which is what it would have to do eventually
     * anyway. Where an administrator registers by hand instead, and where the deployment has no
     * public URL to be sent back to, the answer stays null: inventing a client at a vendor that
     * never offered to issue one, or registering a redirect URI that resolves to nothing, would
     * both leave behind a client that can never complete a consent flow.
     *
     * ONE CLIENT PER DEPLOYMENT EVEN WHEN TWO PEOPLE ASK AT ONCE. This is `requireUser`'s handler, so
     * two first connects racing is the ordinary first hour of a connector. Registering twice is not
     * merely wasteful: the loser's consent screen names a client the vault no longer holds, so that
     * person consents and their callback then redeems the code against the client that replaced it —
     * a connect that fails after the vendor already said yes. So the registration happens under
     * {@link withOAuthClientLock}, with the "do we hold one" question asked AGAIN inside it, and the
     * second caller finds the first one's client and is handed the same one.
     *
     * The lock is held across the registration request to the vendor, deliberately. It is one round
     * trip with its own timeout, and a lock released before it would serialise nothing.
     */
    async ensureOAuthClient(
      serverId: string,
      by: string,
    ): Promise<OAuthClient | null> {
      const stored = await storedOAuthClient(serverId);
      if (stored) return stored;

      const { entry } = await requireServer(serverId);
      if (
        entry?.auth.kind !== "user-oauth" ||
        entry.auth.clientRegistration !== "dynamic" ||
        !entry.auth.registrationUrl ||
        !options.redirectUri
      ) {
        return null;
      }
      // Held before the lock, because narrowing does not survive into the closure below.
      const { registrationUrl } = entry.auth;
      const { redirectUri } = options;

      const outcome = await withOAuthClientLock(
        serverId,
        async (transaction) => {
          /*
           * Asked again, under the lock. The read above was a fast path taken without one, and by now
           * the caller we were racing has committed a client of its own — which is the one this
           * deployment holds, so it is the one to consent against.
           */
          const held = await heldOAuthClient(transaction, serverId);
          if (held) return { client: held, registered: false, replaced: false };

          const registered = await registerClient({
            registrationUrl,
            redirectUri,
          });
          if (!registered) return null;

          const { replaced } = await writeOAuthClient(
            { serverId, client: registered },
            transaction,
          );
          return { client: registered, registered: true, replaced };
        },
      );

      if (!outcome) return null;
      // Only what this call actually did. A trail row for handing back somebody else's client would
      // claim a registration that never happened.
      if (outcome.registered) {
        await recordClientRegistered(
          { serverId, client: outcome.client, by },
          outcome.replaced,
        );
      }
      return outcome.client;
    },

    /**
     * Record that one person connected their own account to one server.
     *
     * The credential swap is {@link swapUserCredential}, and this is its only caller: a person
     * connecting or reconnecting is exactly when there is an older grant to revoke. Rotation writes
     * the same connection in place instead ({@link rotateConnectionToken}). What is only here is the
     * audit row: this one IS somebody's act, and the trail should say so.
     */
    async recordConnection(input: {
      serverId: string;
      userId: string;
      refreshToken: string;
      scope: string;
    }): Promise<void> {
      const { replaced } = await swapUserCredential(input);

      await recordAuditEvent(auditStore, {
        eventType: "mcp.account_connected",
        targetType: "mcp_server",
        targetId: input.serverId,
        payload: {
          actor: input.userId,
          server: input.serverId,
          // What the vendor granted, so a later refusal for want of a scope can be explained.
          scope: input.scope,
          reconnected: replaced,
        },
      });
    },

    /**
     * The deployment's OAuth client for a server, or null if none is registered.
     *
     * Reads only. {@link ensureOAuthClient} is the one that will go and get one.
     */
    oauthClientFor: storedOAuthClient,

    /** Which `user-oauth` servers this person has connected, for their own settings page. */
    async connectionsFor(userId: string): Promise<
      {
        serverId: string;
        scope: string;
        connectedAt: string;
        /**
         * Whether the credential this row points at has been withdrawn.
         *
         * THE ROW OUTLIVES THE SECRET, and until this field existed the two were impossible to tell
         * apart from outside. Revoking a credential sets `revoked_at` on the credential; it does not
         * delete the row here, which goes on pointing at it — so "this person has a row for Notion"
         * and "this person can use Notion" are different facts, and every reader of this list was
         * getting the first while asking the second. A reconnection does not settle it either: the
         * upsert moves `credential_id` and `updated_at` and leaves `connected_at` where it was, so
         * nothing in the shape this used to return changes when access comes back.
         *
         * Reported rather than filtered. A caller that wants "connected" asks for a row that is not
         * revoked; one that wants to draw every app somebody has ever connected still can, and
         * memory ingestion's existence check keeps the behaviour it had.
         */
        revoked: boolean;
      }[]
    > {
      const rows = await database
        .select({
          serverId: mcpUserCredentials.serverId,
          scope: mcpUserCredentials.scope,
          connectedAt: mcpUserCredentials.connectedAt,
          revokedAt: credentialRows.revokedAt,
        })
        .from(mcpUserCredentials)
        /*
         * Inner, and total because of the foreign key: `credential_id` is a real reference that
         * does not cascade, so a join row cannot outlive the credential it points at — a deletion
         * is refused while the row is there. That is why there is no "the credential is gone" case
         * to report here, and why a revoked credential is the only way this answer goes false.
         */
        .innerJoin(
          credentialRows,
          eq(credentialRows.id, mcpUserCredentials.credentialId),
        )
        .where(eq(mcpUserCredentials.userId, userId))
        .orderBy(asc(mcpUserCredentials.serverId));

      return rows.map((row) => ({
        serverId: row.serverId,
        scope: row.scope,
        connectedAt: iso(row.connectedAt) ?? "",
        revoked: row.revokedAt !== null,
      }));
    },

    /**
     * Which brokered apps this person has connected, for the same settings page.
     *
     * A SECOND METHOD RATHER THAN A WIDER {@link connectionsFor}, because the two answer out of
     * different tables for a reason the schema is built on: a `user-oauth` connection is a pointer
     * into the vault, and a brokered one holds no secret at all because Composio keeps the account
     * (see {@link brokeredConnection}). Reading only the vault side is what left a brokered
     * connection invisible to the browser, so the settings screen could not honestly say whether
     * somebody was connected.
     *
     * THE SERVER ID IS JOINED, NOT SPELLED. `addBrokeredApp` writes the app into the url, and every
     * later call resolves against that url — so matching on it asks the row what it is, where
     * composing `composio-${toolkit}` by hand would re-derive the id from a convention nothing
     * holds it to. It is the reasoning the directory route already uses when it reads a row's
     * toolkit off its url rather than off its id. An app this deployment has since removed
     * therefore drops out of the answer, which is the honest result: there is no server row left
     * for a page to name.
     *
     * `scope` IS EMPTY for the reason {@link confirmBrokeredConnection} sets out: Composio grants
     * none that it tells us about, and the field exists to record what the vendor said it granted
     * rather than what we suppose. It is returned all the same, so the fields this shares with
     * {@link connectionsFor} — `serverId`, `scope`, `connectedAt` — line up and one screen can draw
     * both kinds of row. What comes back here is a SUPERSET of that shape rather than the same one:
     * `verified` and `verifiedAt` ride along too, and only on a brokered row, because only a
     * brokered row is a thing this deployment can re-check.
     *
     * `verified` AND `verifiedAt` COME ALONG BECAUSE "connected" IS NOT A PRESENT TENSE HERE.
     * Composio never re-checks a key somebody typed in: it answers ACTIVE for as long as the row
     * exists, whatever the vendor on the other side now thinks of that credential. So a page drawn
     * off `connectedAt` alone would assert something this deployment has not known since the day it
     * was written. These two fields are what lets it say when the claim was last earned instead —
     * "connected with a key you provided, last checked 13 Sep". What the pair separates is a
     * CHECKED key connection from an unchecked one, and nothing more: which KIND of connection a
     * row is comes from the app's recorded {@link ServerRecord.authScheme}, which the page branches
     * on first, and not from anything answered here.
     *
     * `probe` IS THE ACTION THE LAST CHECK SPENT, READ OUT OF THE ROW. The pair above says whether a
     * key connection was ever checked; it cannot say WHY one was not, and three different
     * situations share the one word `false`. Until this field, only the answer to a connect or a
     * re-check could tell them apart — so a page reload lost the distinction, and the worst of the
     * three degraded into the mildest: a row saying the key was accepted without being checked, over
     * an account whose key the vendor had actually REFUSED.
     *
     * IT IS STORED BECAUSE IT IS A FACT ABOUT A MOMENT, NOT ABOUT TODAY'S METADATA. This field was
     * once derived here, by asking {@link probeActionFor} which action this deployment WOULD check
     * the app with; the argument for that was that the chooser holds every condition the probe
     * itself runs on, so the two could not disagree. They cannot disagree AT AN INSTANT, and that is
     * all it establishes. `verified` records a check made against the app's action listing as it
     * stood THEN, and the chooser answers from the listing as it stands NOW — and `POST
     * /servers/:id/refresh` is a generic administrator's route keyed on a server id, of which
     * `composio-<slug>` is one, so an ordinary press of Refresh moves the second without touching
     * the first. It is the very press the Composio transport tells an operator to make when an
     * action appears or gains the version that makes it callable. So: somebody connects a key to an
     * app that publishes nothing safe to try it on, and the row honestly says the key was accepted
     * unchecked. An administrator presses Refresh. From that page load on, the derivation named an
     * action, and the row drew the sentence written for a REFUSED key — your key was checked against
     * this app and rejected, the account it was checked in still stands, so disconnect it. Every
     * clause of that is false for somebody whose key was never tried, it tells them to take down a
     * connection that works, and it persists: it is what every page load says until they press
     * Re-check.
     *
     * SO THE WRITER RECORDS WHAT IT SPENT AND THIS READS IT BACK. {@link recordBrokeredConnection}
     * is the single writer, every path into it knows the action it spent or that it spent none, and
     * {@link composioConnections.probeAction} is where that goes. Read together with `verified`, the
     * column tells four states apart, and no inference is made in any of them:
     *
     *   no probe, not verified   — nothing was tried: at the time of the check the app published
     *                              nothing safe to spend a key on. A fact about the app, not the
     *                              key. A key row written before the column existed reads this way
     *                              too, for the reason that column gives.
     *   no probe, verified       — a CONSENT connection. The vendor's own yes at its own screen is
     *                              the evidence, no call was ever made against the account, and so
     *                              there is no action to name.
     *   a probe, verified        — it ran in this person's account and the vendor took the key.
     *   a probe, NOT verified    — it ran and the vendor refused the key, and the account it ran in
     *                              is still standing. A live account with a bad key behind it.
     *
     * AND THE LAST LINE IS A RECORD RATHER THAN AN INFERENCE, which is the whole of what changed.
     * The caveat that stood here used to argue the state into existence: a key connection is ALWAYS
     * probed at connect time, a probe that fails withdraws the account it just made, so an
     * unverified row under an app that HAS a probe must be a refusal whose withdrawal failed — or
     * else a re-check the vendor refused, which leaves the person's own older account alone. That
     * reasoning was sound about the rows it described and said nothing about the row a refresh had
     * quietly moved underneath it. What the row now warrants, it warrants by having been written:
     * the check ran, it spent this action, and the vendor refused.
     *
     * WHICH PATH WROTE IT IS STILL NOT RECOVERABLE, and a reader must not invent one. The column
     * records what was spent, not who spent it, and the two writers of that pair end differently: a
     * connect withdraws the account it had just made and only leaves the row where Composio refused
     * to take it back, while a re-check never withdraws anything, because the account predates the
     * press and is the person's own. So a page may say the key was refused and the account stands;
     * a page that goes on to blame a failed withdrawal is right on the connect path and FALSE on the
     * re-check, where nothing ever tried to remove anything.
     *
     * `checkable` IS THE OTHER QUESTION, AND IT TRAVELS SEPARATELY BECAUSE COLLAPSING THE TWO IS
     * WHAT DEADLOCKED THE SETTINGS SCREEN. "What did the check SPEND" is a fact about the past, and
     * `probe` answers it. "Does this app have anything to check with TODAY" is a fact about the
     * present, and this answers that — out of {@link probeActionFor}, asked of the APP rather than
     * of the connection. The two agreed for as long as `probe` was derived: one field, one moment,
     * two questions nobody ever had to tell apart. They part company the instant it became a
     * record, which is the same instant it started being right about the past.
     *
     * THE DEADLOCK IN FULL, BECAUSE IT DOES NOT SELF-HEAL. The page gates its Re-check button on
     * whether there is anything to check with, and it read `probe` for that. Somebody connects a
     * key to an app that publishes nothing safe to spend it on: the check spends nothing, the row
     * records null, and both of those are correct and permanent. An administrator presses Refresh,
     * the app gains a safe versioned read, and the button is STILL withheld — because the record
     * still says, truthfully, that nothing was spent. And pressing that button is the only thing in
     * this product that can ever put an action into the record. The state is stable, wrong, and
     * unreachable from inside itself: the single act that would end it is the act being withheld.
     *
     * SO A CALLER TAKES THE PAST FROM ONE AND THE PRESENT FROM THE OTHER, and must take neither out
     * of the other one. A screen drawing its SENTENCE off `checkable` would accuse a key nobody
     * tried, which is the defect the recorded column was made for; a screen gating its BUTTON on
     * `probe` is the deadlock above. Neither field is a weaker spelling of the other, and the
     * moment one is asked to answer both questions the two failures simply trade places.
     *
     * WHICH COSTS ONE QUERY PER CONNECTED APP, AND THAT IS THE RIGHT PRICE. Making `probe` a stored
     * column took the per-row call out and left a listing that was one query; this puts it back —
     * on top of the two the rows themselves now take, which the body below says why.
     * The alternative is to fold the chooser's rule into the join — vendor-labelled read, not
     * destructive, no required inputs, a recorded version — and that rule has no honest spelling in
     * SQL: `required` is the vendor's own JSON Schema stored unchanged, and deciding whether it is
     * a non-empty list of names is a thing JavaScript does and a `json` operator does badly. So
     * folding it in means writing the rule a SECOND time, in a second language, over the same rows,
     * and this file already records what a rule in two places costs: while the version condition
     * sat in one of them, an app whose chosen action had no version connected honestly as "nothing
     * was tried" and reloaded as "your key was checked and rejected". {@link probeActionFor} is the
     * one authority on what can be checked, and a listing that asks it N times cannot disagree with
     * the probe that asks it once. N is the apps ONE person has connected — a handful of indexed
     * reads by server id, made in parallel — behind a settings page and not on any hot path.
     *
     * `verifiedAt` STAYS NULL WHERE IT IS NULL, unlike `connectedAt`, which collapses to `""`
     * because a row cannot exist without one and the fallback is unreachable. Null here is
     * reachable and it means something: never checked. Folding it into `""` would hand the page a
     * row that was checked at a time nobody recorded, which is a different fact and not one this
     * table ever holds. Note also what {@link composioConnections.verified} sets out about the rows
     * migration 0038 backfilled: their `verifiedAt` is the moment of consent, not the moment of a
     * probe, so a caller must not read every timestamp here as "this connection answered then".
     */
    async brokeredConnectionsFor(userId: string): Promise<
      {
        serverId: string;
        scope: string;
        connectedAt: string;
        verified: boolean;
        verifiedAt: string | null;
        probe: string | null;
        checkable: boolean;
      }[]
    > {
      /*
       * THIS PERSON'S OWN ACCOUNTS AND NOTHING ELSE. `holder = 'person'` is said out loud rather
       * than left to the user id, because a settings page listing "your connections" must never
       * draw the deployment's shared account as one of them — a deployment row has no `user_id`,
       * and the filter keeps that a fact this query states rather than one it happens to rely on.
       */
      /*
       * NO PROVIDER PREDICATE HERE, DELIBERATELY, AND THAT IS NOT AN OVERSIGHT. Each row is resolved
       * below at the ACTIVE provider's canonical url, so another provider's row would be silently
       * dropped from the page. What keeps that unreachable is the startup activation refusal
       * (`assertActivatable`, called from `server/src/index.ts`): it will not boot when the
       * configured provider differs from the one on the existing rows. No flow relaxes that refusal
       * today; whoever builds one must add the `brokerProvider` predicate here.
       */
      const connections = await database
        .select({
          toolkit: brokeredConnections.app,
          connectedAt: brokeredConnections.connectedAt,
          verified: brokeredConnections.verified,
          verifiedAt: brokeredConnections.verifiedAt,
          probeAction: brokeredConnections.probeAction,
        })
        .from(brokeredConnections)
        .where(
          and(
            eq(brokeredConnections.holder, "person"),
            eq(brokeredConnections.userId, userId),
          ),
        );

      /*
       * THE APP IS RESOLVED PER CONNECTION, NOT JOINED TO IT, BECAUSE THE URL IS NOT A KEY.
       *
       * CRITERION. One connection is one row out of here, whatever `mcp_servers` holds.
       *
       * REASON. This read used to be an inner join on `mcp_servers.url = 'composio://' || toolkit`,
       * and nothing in the schema makes that column unique — the one `uniqueIndex` in
       * `db/schema/plugins.ts` is `skills_slug_key` on `skills.slug`. A join answers one row per
       * PAIR, so a second row at an app's url listed the same account twice: two rows on the
       * settings page saying the same app under two different server ids, each offering to
       * disconnect the single connection standing behind both. And it is not an exotic state — it
       * is what any database looks like the moment a row at `gmail` sits beside the
       * `composio-gmail` an administrator really added, which is how a development database
       * routinely looks.
       *
       * A UNIQUE INDEX WOULD BE THE OTHER FIX AND IS THE WRONG ONE. Two rows at one address is a
       * state this product means to allow — a deployment holding two accounts at one vendor adds
       * the same URL twice under two ids with two credentials, and `addCustomServer` refuses only a
       * re-add that MOVES an existing id's address. Constraining the column would forbid that for
       * everybody to tidy a display defect, and the migration that added it would fail outright on
       * any deployment already holding a duplicate, taking the whole boot with it.
       *
       * SO THE LOWER ID ANSWERS FOR THE APP, and it is a rule rather than whatever the scan met
       * first: a page that redrew under a different `serverId` each load would be offering buttons
       * keyed on a value moving underneath it. The same rule decides the scheme reads — see
       * {@link brokeredAppScheme} — so nothing in this file can name one row for an app while
       * something else names another.
       *
       * AND "LOWER" IS THE DATABASE'S OWN WORD FOR IT, WHICH IS WHY THE ORDER IS IN THE QUERY. This
       * read took its rows unordered and picked the smallest with a JavaScript `<`, which compares
       * UTF-16 code units and nothing else, while {@link brokeredAppRow} asks for `order by id`
       * under whatever collation the deployment's database runs. Those two agree for ASCII on a `C`
       * database and are free to disagree everywhere else — a linguistic collation reorders case and
       * punctuation, and byte order and code-unit order part company above the BMP. One rule spelled
       * in two languages is two rules, and where they parted the page drew an app under one server
       * id while the Re-check button beside it, the probe behind that button and the scheme that
       * decides whether the button appears at all were about the other row: the same defect the
       * single read was written to end, reached through the collation instead of through the query.
       * So the resolution is {@link brokeredAppRowsAt} and not a rule spelled again here: it is the
       * same function {@link brokeredAppRow} answers one app out of, which is what makes the row
       * this page draws an app under the row every read behind its buttons is about.
       *
       * A CONNECTION WITH NO ROW AT ITS URL IS STILL LISTED BY NOTHING, which is what the inner
       * join answered and what the missing `serverId` below drops. A person can hold an account at
       * an app this deployment has since removed, and the settings page has no row to draw for it.
       */
      /*
       * AT THE ACTIVE BROKER'S SCHEME, which is the one {@link brokeredAppRow} resolves every other
       * url against. Spelled `composio://` here, this read answered an empty map on any other
       * broker — every `serverId` undefined, every connection dropped, and the connected-accounts
       * page drawn empty for somebody holding accounts. Fail-closed and visible, and total.
       */
      const canonical = (toolkit: string) =>
        `${BROKERED_PROFILE[brokerProvider].scheme}${toolkit}`;
      const named = await brokeredAppRowsAt(
        connections.map((row) => canonical(row.toolkit)),
      );

      const rows = connections
        .flatMap((row) => {
          const serverId = named.get(canonical(row.toolkit))?.id;
          return serverId === undefined ? [] : [{ ...row, serverId }];
        })
        // By server id, as the join's own `order by` was, so this read and `connectionsFor` hand the
        // route two lists ordered alike. Compared as plain strings rather than through a collation,
        // for the reason the route gives where it merges them: the order only has to be the same
        // one every time.
        .sort((left, right) => {
          if (left.serverId < right.serverId) return -1;
          return left.serverId > right.serverId ? 1 : 0;
        });

      return await Promise.all(
        rows.map(async (row) => ({
          serverId: row.serverId,
          scope: "",
          connectedAt: iso(row.connectedAt) ?? "",
          verified: row.verified,
          verifiedAt: iso(row.verifiedAt),
          // The name alone, because that is what the four states are told apart by; the version the
          // check was made at is the caller-of-the-call's business, and this read makes none.
          probe: row.probeAction,
          /*
           * WHETHER, NOT WHICH. The chooser names an action and this keeps only the yes or no,
           * because the yes or no is the whole of the question being asked: is there anything to
           * spend a key on. Carrying the name would put a second action name on a row that already
           * has one, inches from the field that records what was actually spent — and the first
           * reader to draw a sentence off the wrong one re-opens the defect that made `probe` a
           * record. A boolean cannot be mistaken for a record of anything.
           */
          checkable: (await this.probeActionFor(row.serverId)) !== null,
        })),
      );
    },

    /**
     * The deployment's one account at a brokered app, as the admin page draws it; null where none
     * is connected, and null for a server that is not brokered at all.
     *
     * `connectedBy` IS THE ADMINISTRATOR'S EMAIL, because an id is not something a page can show
     * anybody. It falls back to the stored id when that person has since been removed, so the row
     * still says somebody connected it rather than claiming nobody did.
     *
     * `displayName` IS ASKED OF THE BROKER AND NEVER FAILS THE READ. It is the vendor's name for
     * the account — the one thing that tells an administrator WHICH team account is behind the app
     * — and a vendor that will not say is a page missing a label, not a page that cannot load.
     */
    async deploymentConnectionFor(serverId: string): Promise<{
      connectedAt: string;
      connectedBy: string | null;
      verified: boolean;
      verifiedAt: string | null;
      probe: string | null;
      displayName: string | null;
    } | null> {
      const [server] = await database
        .select({ url: mcpServers.url })
        .from(mcpServers)
        .where(eq(mcpServers.id, serverId))
        .limit(1);
      const toolkit = server ? toolkitOfFor(brokerProvider, server.url) : null;
      if (!toolkit) return null;

      const [row] = await database
        .select({
          vendorUserId: brokeredConnections.vendorUserId,
          connectedBy: brokeredConnections.connectedBy,
          connectedByEmail: users.email,
          connectedAt: brokeredConnections.connectedAt,
          verified: brokeredConnections.verified,
          verifiedAt: brokeredConnections.verifiedAt,
          probeAction: brokeredConnections.probeAction,
        })
        .from(brokeredConnections)
        .leftJoin(users, eq(users.id, brokeredConnections.connectedBy))
        .where(
          and(
            eq(brokeredConnections.provider, brokerProvider),
            eq(brokeredConnections.app, toolkit),
            eq(brokeredConnections.holder, "deployment"),
          ),
        )
        .limit(1);
      if (!row) return null;

      const displayName = broker
        ? await broker
            .accountName({
              account: { holder: "deployment", vendorUserId: row.vendorUserId },
              toolkit,
            })
            .catch(() => null)
        : null;

      return {
        connectedAt: iso(row.connectedAt) ?? "",
        connectedBy: row.connectedByEmail ?? row.connectedBy,
        verified: row.verified,
        verifiedAt: iso(row.verifiedAt),
        probe: row.probeAction,
        displayName,
      };
    },

    /**
     * Every Shared app, connected or not, as `GET /connections` lists it beside a person's own.
     *
     * A SHARED APP WITH NOTHING CONNECTED IS STILL LISTED, as `connected: false`. Its absence would
     * read as "this app needs nothing", when it is the one state an administrator has to act on —
     * the page offers its Connect action off exactly this entry.
     *
     * `checkable` IS TRUE ONLY WHEN AN ACCOUNT IS CONNECTED AND THE APP IS A KEY APP WITH A PROBE
     * ACTION, because a re-check spends a key on a safe read and there is no key to spend without
     * a connected account, nor on a consent app, which has no key at all. Where it is a connected
     * key app the answer is {@link probeActionFor}'s, asked of the app, for the reason
     * {@link brokeredConnectionsFor} gives for keeping `checkable` apart from `probe`.
     */
    async sharedConnections(): Promise<
      {
        serverId: string;
        scope: "";
        holder: "deployment";
        connected: boolean;
        connectedAt: string | null;
        connectedBy: string | null;
        verified: boolean;
        verifiedAt: string | null;
        probe: string | null;
        checkable: boolean;
        displayName: string | null;
      }[]
    > {
      /*
       * ONE ENTRY PER SHARED APP, under the row that answers for it. A row marked `shared` that is
       * a duplicate at some app's url is not the app — the app is Shared only if its answering row
       * says so — and listing it would offer a Connect for an account no call would use.
       */
      const marked = await database
        .select({ id: mcpServers.id, url: mcpServers.url })
        .from(mcpServers)
        .where(eq(mcpServers.accountMode, "shared"))
        .orderBy(asc(mcpServers.id));
      const answering = await brokeredAppRowsAt(
        marked
          .filter((row) => toolkitOfFor(brokerProvider, row.url) !== null)
          .map((row) => row.url),
      );
      const shared = marked.filter(
        (row) => answering.get(row.url)?.id === row.id,
      );

      return await Promise.all(
        shared.map(async (server) => {
          const toolkit = toolkitOfFor(brokerProvider, server.url);
          const [connection, kind] = await Promise.all([
            this.deploymentConnectionFor(server.id),
            toolkit ? brokeredAppKind(toolkit) : null,
          ]);
          return {
            serverId: server.id,
            scope: "" as const,
            holder: "deployment" as const,
            connected: connection !== null,
            connectedAt: connection?.connectedAt ?? null,
            connectedBy: connection?.connectedBy ?? null,
            verified: connection?.verified ?? false,
            verifiedAt: connection?.verifiedAt ?? null,
            probe: connection?.probe ?? null,
            checkable:
              connection !== null &&
              kind === "key" &&
              (await this.probeActionFor(server.id)) !== null,
            displayName: connection?.displayName ?? null,
          };
        }),
      );
    },

    /**
     * Whether this person has one brokered app connected, and since when.
     *
     * THE ROW IS A CACHE OF COMPOSIO'S ANSWER, not a record of a flow this deployment watched
     * finish. Nothing here holds a secret for a brokered app: the vendor keeps the account, and
     * what {@link brokeredConnections} holds is the sentence "Composio said yes when we asked",
     * written down so that every later call can be gated without a round trip. That makes drift
     * possible by construction — somebody can end the connection in Composio's own dashboard, and
     * this row would go on saying yes — and it is why {@link confirmBrokeredConnection} asks the
     * vendor again rather than trusting what is here. Calling confirm on any page load is
     * therefore how a row that drifted heals.
     *
     * Read by the pair, because the pair is what the partial unique indexes enforce one row per:
     * (provider, app) among deployment rows and (provider, app, user_id) among person rows —
     * `holder` is each partial index's WHERE predicate, not a key column, so an ON CONFLICT
     * target must name exactly those columns with the matching WHERE. An app has many people's
     * connections and a person has many apps, and the only question anybody asks is about one of
     * each.
     */
    async brokeredConnection(input: {
      toolkit: string;
      account: AccountRef;
    }): Promise<{ connectedAt: string } | null> {
      const [row] = await database
        .select({ connectedAt: brokeredConnections.connectedAt })
        .from(brokeredConnections)
        .where(accountRow(input.toolkit, input.account))
        .limit(1);

      if (!row) return null;
      return { connectedAt: iso(row.connectedAt) ?? "" };
    },

    /**
     * The action a key verification should call against this app, and the version to call it at.
     *
     * THIS CHOOSES THE ONE ACTION THAT WILL BE CALLED WITH SOMEBODY'S JUST-TYPED API KEY, which is
     * what makes it the most dangerous line in the verification: whatever comes back from here runs
     * against a stranger's account, once, purely to find out whether their key works. So the two
     * safety conditions below are BOTH non-negotiable, and neither is a stricter spelling of the
     * other.
     *
     * READ EFFECT, because a probe must not change anything. The label is the vendor's own and not
     * a guess of ours: `effectOf` answers `read` only where Composio sent `readOnlyHint`, and
     * everything unlabelled was already recorded as a write, so `read` here means Stripe or Linear
     * or Notion said so. `destructive` is checked beside it rather than trusted to be implied — the
     * two are separate columns precisely so a vendor can say both things, and a row that somehow
     * says read AND destructive is a row this deployment has no business calling unasked.
     *
     * ZERO REQUIRED INPUTS, because there is nothing to invent an argument from. A probe happens
     * before this deployment knows anything about the account beyond the key, so a required customer
     * id or query has no honest value to carry, and a made-up one turns "is this key good" into
     * "does this identifier exist" — which fails for a perfectly good key.
     *
     * BOTH, NEVER EITHER, and the live catalogue is why this sentence is here rather than a comment
     * saying the checks are belt-and-braces. The first argument-less action on Stripe's own list is
     * `STRIPE_CREATE_BILLING_METER_EVENT_SESSION`. A probe chosen on "takes no arguments" alone —
     * the condition that looks sufficient, because it is the one that makes a call possible at all —
     * would therefore write to somebody's account to find out whether their key works. The read
     * effect is the whole of what stands between those two names.
     *
     * AND A RECORDED VERSION, WHICH IS PART OF "CAN THIS BE CALLED AT ALL" AND NOT A DETAIL OF THE
     * CALLER. Composio refuses an execution without a specific version and rejects `latest`, so the
     * transport refuses before dialling where none travels with the call — and Composio publishes
     * some actions with no version at all. An action this deployment recorded without one is
     * therefore an action nothing here can spend a key on, which is the same kind of fact as a
     * required input: not unsafe, just not callable. The version is SELECTED AND RETURNED for the
     * caller that has to send it, so the choice and the call cannot come apart.
     *
     * THE CONDITION LIVES IN THE FILTER RATHER THAN AFTER THE CHOICE, so there is ONE predicate for
     * one question. While it sat downstream — read by the probe, unknown to everything else — there
     * were two, and the weaker of them was what the connections listing derived its `probe` field
     * from: an app whose chosen action had no version connected honestly as "nothing was tried",
     * then reloaded as "your key was checked and rejected". That listing no longer derives that
     * field from here — {@link brokeredConnectionsFor} reads what the check RECORDED, because no
     * derivation from today's metadata can be right about yesterday's check. It still asks this
     * function a question, but a present-tense one: whether the app has anything to check with now,
     * kept as a yes or no beside the record. A split predicate would therefore no longer put a
     * false sentence on a settings page; it would show up in two worse places — a probe that chose
     * an action it then refused to send, and a button offered over an app nothing can be spent on.
     * A filter also lets the search CONTINUE: a versionless
     * candidate is passed over for the next safe read rather than short-circuiting the whole app to
     * "nothing to try", so an app that can be checked is.
     *
     * NULL IS AN ANSWER AND NOT A FAILURE. Of fifteen key-based apps sampled, most publish some safe
     * argument-less read and PostHog publishes none at all, so an app that cannot be probed is an
     * ordinary app rather than a broken one. What a caller does about it — and running the probe at
     * all — belongs to the verification path; this function only chooses.
     */
    async probeActionFor(
      serverId: string,
    ): Promise<{ name: string; version: string } | null> {
      // Ordered, because the fallback below is "the first candidate" and Postgres promises no order
      // without one: an unordered read would make which action gets called with somebody's key a
      // property of whichever plan the server happened to pick.
      const actions = await database
        .select({
          /*
           * THE VENDOR'S SPELLING, BECAUSE THIS NAME IS CALLED RATHER THAN DISPLAYED. The pair this
           * answers goes to the transport directly (see `probeConnection`), and a transport answers
           * only to the name its own listing gave. {@link IDENTITY_ACTION} is written in that same
           * vocabulary — `_GET_ME`, `_WHOAMI` — so it is matched against this for the same reason.
           * Identical to `name` on every transport this path actually reaches. See
           * {@link mcpTools.vendorName}.
           */
          name: vendorNameOf(),
          inputSchema: mcpTools.inputSchema,
          effect: mcpTools.effect,
          destructive: mcpTools.destructive,
          version: mcpTools.version,
        })
        .from(mcpTools)
        .where(eq(mcpTools.serverId, serverId))
        .orderBy(asc(mcpTools.name));

      // One pass, and it yields the pair rather than the row: an action that survives every
      // condition below has a version by definition, and building the answer here is what carries
      // that fact into the type instead of leaving the caller to re-check it.
      const safe = actions.flatMap((action) => {
        if (action.effect !== "read" || action.destructive) return [];
        // Null in the column and blank in the data are the same nothing, and neither is a version
        // the transport can put on a call.
        const version = action.version?.trim();
        if (!version) return [];
        /*
         * THE WHOLE SCHEMA IS ASKED, NOT ITS TOP-LEVEL `required`. This read `schema?.required` and
         * passed over the action only for a non-empty list there — so an action whose required
         * arguments are published under `allOf`/`anyOf`/`$ref`, which is how a generated toolkit
         * ordinarily writes them, was selected as argument-less, called with `{}`, and answered with
         * the vendor's validation error. That arrives at `probeConnection` as `answered: true,
         * isError: true`, which is the `refused` verdict — a valid key declared bad, and on connect
         * the account created seconds earlier deleted behind it. See {@link asksForArguments} for
         * which keywords bear on an empty object and why the unreadable shapes answer yes.
         */
        if (asksForArguments(action.inputSchema)) return [];
        return [{ name: action.name, version }];
      });

      const identity = safe.find((action) => IDENTITY_ACTION.test(action.name));
      return identity ?? safe[0] ?? null;
    },

    /**
     * Write down that this person holds this brokered app, and how well that is known.
     *
     * ONE WRITER SO THE VERIFIED AND UNVERIFIED PATHS CANNOT DRIFT INTO TWO ROW SHAPES. What says
     * how well a connection is known is a SET of fields and not a column: `verified` is meaningless
     * without the moment it was earned, and `verified_at` without the flag is a date on a claim
     * nobody made. Every path that records a connection therefore comes through here rather than
     * spelling that set for itself — {@link confirmBrokeredConnection} with `true` today, and the
     * verify path, which is the caller `false` exists for, when a probe against a key connection
     * comes back unanswered. Two call sites each writing the set by hand is how one of them comes
     * to set the flag and leave the timestamp null, or to move `connected_at` on a confirm that
     * healed a row nothing changed; spelled once, a reader asking what shape a connection row takes
     * has one answer and every path takes it.
     *
     * `verified` IS THE CALLER'S CLAIM AND `verifiedAt` FOLLOWS FROM IT, never the other way round.
     * True means the caller has evidence as of now — the vendor's own yes at the end of a consent
     * screen, or a call that went out and came back — so the timestamp is stamped here rather than
     * passed in, and it is the moment of the write because that is the moment the evidence was in
     * hand. False takes the timestamp back to null rather than leaving the old one standing: a row
     * that has stopped being verified must not keep a date saying when it last was, because the one
     * sentence the page builds out of the pair — "last checked 13 Sep" — would then be drawn for a
     * connection this deployment is no longer claiming anything about.
     *
     * `connected_at` IS LEFT ALONE, which is the whole reason this is an upsert with an explicit
     * `set` rather than a delete and an insert. The person connected when they connected; a write
     * that moved it would make every page load look like a fresh connection on their own settings
     * page, and would erase the one date the row holds that nothing else in this deployment knows.
     *
     * AND THE STAMP IT WROTE IS WHAT IT ANSWERS, for the same reason the caller does not pass one
     * in. A caller that needs the moment — {@link recheckBrokeredConnection}, which hands it to the
     * browser as the date the row's sentence is drawn from — would otherwise have to read the row
     * back and hope it was reading its own write. The timestamp is still this writer's; what
     * changed is that it is no longer thrown away.
     *
     * `only` IS WHETHER THIS WRITE MAY CREATE A CONNECTION, AND ONE CALLER MUST SAY NO.
     *
     * CRITERION. With `only: "a row that is still there"` this method never inserts. It updates a
     * row that exists and answers `wrote: false` for one that does not, and the caller decides what
     * to do about that.
     *
     * REASON. {@link recheckBrokeredConnection} reads the row first, deliberately, "because the
     * writer below is an upsert, so a re-check that probed first would INSERT a connection for
     * somebody who has none". That read and this write straddle a LIVE VENDOR CALL of several
     * seconds, and nothing held the row still across it. A person pressing Re-check and then
     * Disconnect in another tab — or a concurrent {@link confirmBrokeredConnection} getting `false`
     * from Composio and deleting the row — had the revoke complete at Composio and the row deleted,
     * and then this in-flight upsert PUT IT BACK. `brokered_connections` is the whole of the
     * permission a brokered call is decided on, so what the re-insert restores is access to an
     * account the person has just disconnected, drawn on every screen as connected.
     *
     * THE GUARD IS ON THE WRITE RATHER THAN A LOCK ACROSS THE CALL, because the call is somebody
     * else's and may take as long as it likes. A connection this write did not find is one nothing
     * happened to: the probe's answer is about an account the person no longer has here.
     *
     * `probeAction` IS PASSED IN, UNLIKE THE TIMESTAMP, BECAUSE ONLY THE CALLER KNOWS IT. It is the
     * action this check SPENT — the probe's name, or null where none was spent — and it is required
     * rather than optional so that a new path cannot record a connection while staying silent about
     * what it tried. Every existing caller knows the answer without looking anything up: a consent
     * confirm spent nothing and passes null, and both probing paths pass the name the probe returned
     * them, which is null there too when the app published nothing safe to call.
     *
     * IT IS PART OF THE SAME SET AS THE FLAG AND THE STAMP, which is the reason it is written here
     * and nowhere else. `verified` alone says a check did not pass and cannot say what it was; this
     * column is what separates "the app published nothing to try" from "it ran and the vendor said
     * no", and a row carrying one of the three without the others is a shape no reader downstream
     * has reasoned about. It used to be derived on read instead, from the app's action listing as
     * that listing stood at the moment of the read — see {@link brokeredConnectionsFor}, where the
     * refresh that broke the derivation is written out.
     */
    async recordBrokeredConnection(input: {
      toolkit: string;
      account: AccountRef;
      connectedBy?: string;
      verified: boolean;
      probeAction: string | null;
      /** See the paragraph on `only` above. Absent is the ordinary upsert. */
      only?: "a row that is still there";
    }): Promise<{ verifiedAt: Date | null; wrote: boolean }> {
      const verifiedAt = input.verified ? new Date() : null;
      // The one set, spelled once, so the conditional write below and the upsert cannot drift into
      // two row shapes. `probeAction` is overwritten rather than left standing, for `verifiedAt`'s
      // reason: the pair describes ONE check, and a row keeping the action an earlier check spent
      // beside the verdict of a later one would name a call this row's own state did not come from.
      const set = {
        verified: input.verified,
        verifiedAt,
        probeAction: input.probeAction,
        updatedAt: new Date(),
      };

      if (input.only === "a row that is still there") {
        /*
         * AN UPDATE AND NEVER AN INSERT, and `returning` is how "there was a row" is ANSWERED rather
         * than assumed. An update that matches nothing is not a failure — it is the row having been
         * deleted while the vendor was being asked — and the caller has a sentence for that.
         *
         * `vendor_user_id` IS DELIBERATELY NOT IN THIS `set`. This branch records a CHECK of a
         * connection that already exists, never a connection; it may not re-point the row at a
         * different vendor identity, because only a connect or a confirm (the upsert below) is
         * evidence of a grant held under the identity it names.
         */
        const written = await database
          .update(brokeredConnections)
          .set(set)
          .where(accountRow(input.toolkit, input.account))
          .returning({ vendorUserId: brokeredConnections.vendorUserId });
        return { verifiedAt, wrote: written.length > 0 };
      }

      /*
       * THE VENDOR IDENTITY THIS WRITE'S EVIDENCE IS ABOUT, WRITTEN ON BOTH BRANCHES OF THE UPSERT.
       *
       * CRITERION. After this upsert the row names `input.account.vendorUserId`, whatever it named
       * before.
       *
       * REASON. Every caller of the upsert has just heard from the vendor about the account held
       * under THIS id — a consent, or the vendor confirming it holds an account — and
       * `connectionTokenFor` sends calls out under the ROW's `vendor_user_id`, never a recomputed
       * one. A conflict arm that rewrote `verified`/`verified_at` and left the old id standing
       * wrote a verdict about one account onto a row naming another, and every later call landed
       * in the account the evidence was not about. The insert always set it; the arms did not.
       */
      const connectedAs = input.account.vendorUserId;
      await database
        .insert(brokeredConnections)
        .values({
          /*
           * THE BROKER THIS ROW WAS ACTUALLY MINTED AT, which is this store's own, because this
           * insert only ever runs behind a connection just made at the broker this store holds.
           *
           * CRITERION. A row inserted here carries the provider whose grant it stands for, so the
           * reads keyed on `provider` above find exactly the rows this writer wrote.
           *
           * REASON. The literal `composio` here was the one line that could not fail loudly. An
           * Arcade deployment writing it would read its own rows back through a `composio` filter
           * and APPEAR TO WORK, while the refusal that is supposed to fire when the other provider
           * holds rows never fired — nothing would ever be filed under the other name — and the
           * offboarding sweep, keyed the same way, would sweep a slice of the table that was not
           * this deployment's. Every symptom of that is silence.
           */
          provider: brokerProvider,
          app: input.toolkit,
          holder: input.account.holder,
          userId:
            input.account.holder === "person" ? input.account.userId : null,
          vendorUserId: input.account.vendorUserId,
          connectedBy:
            input.account.holder === "deployment"
              ? (input.connectedBy ?? null)
              : null,
          verified: input.verified,
          verifiedAt,
          probeAction: input.probeAction,
        })
        .onConflictDoUpdate(
          input.account.holder === "person"
            ? {
                target: [
                  brokeredConnections.provider,
                  brokeredConnections.app,
                  brokeredConnections.userId,
                ],
                targetWhere: sql`${brokeredConnections.holder} = 'person'`,
                set: { ...set, vendorUserId: connectedAs },
              }
            : {
                target: [brokeredConnections.provider, brokeredConnections.app],
                targetWhere: sql`${brokeredConnections.holder} = 'deployment'`,
                // WHO CONNECTED IT MEANS THE LATEST CONNECTION. A deployment account is
                // shared, so a second administrator reconnecting it supersedes the first —
                // which `set` otherwise never said, leaving the row crediting whoever
                // connected it the first time. Added only when this call names a
                // `connectedBy` at all, so a re-check or a confirm that passes none does not
                // blank out the administrator an earlier connect already recorded. That
                // condition is the point: do NOT make this unconditional.
                set: input.connectedBy
                  ? {
                      ...set,
                      vendorUserId: connectedAs,
                      connectedBy: input.connectedBy,
                    }
                  : { ...set, vendorUserId: connectedAs },
              },
        );
      return { verifiedAt, wrote: true };
    },

    /**
     * The other apps this deployment holds a connection for that share THIS app's connection: the
     * apps on the same vendor identity AND the same AUTH PROVIDER, never the provider alone. The
     * reason is written out on {@link connectionSiblings}; this is that computation over the rows
     * this deployment actually holds under the active provider.
     *
     * THE BROKER THIS STORE WAS BUILT WITH ANSWERS IT, AND NO CALLER SUPPLIES A RESOLVER. The auth
     * provider is the vendor's fact and this store keeps no copy of it, so it is asked for — of
     * {@link ConnectedAppBroker.authProviderOf}, which both providers implement. A resolver taken as
     * a parameter would be a question every caller had to answer identically or see a different
     * sibling set; with the store calling its own broker there is ONE answer by construction and
     * nothing to keep in step. A deployment with no broker answers `[]` — a presence test on a
     * declared value, and correct, because such a deployment holds no brokered rows at all.
     *
     * THE SCAN IS PRE-FILTERED ON THE ASKING IDENTITY, IN THE `WHERE`. Resolving the auth provider
     * is a vendor call per app, on a screen somebody is waiting on; resolving it for every brokered
     * row of the whole deployment and only then discarding the rows on other identities is unbounded
     * in the one dimension that grows. `vendor_user_id` is a column, so the filter is free — and
     * semantically identical, because {@link connectionSiblings} discards exactly those rows.
     *
     * An app the broker cannot answer for (`null`) is left out rather than guessed at: claiming a
     * sibling that is not one is the failure D26 exists to prevent. If the asking app itself is
     * unanswered the list is empty.
     *
     * `unanswered` IS HOW MANY OTHER APPS ON THE ASKING IDENTITY WERE LEFT OUT FOR THAT REASON — an
     * integer, never names; see {@link resolveSiblings} for why it is surfaced.
     *
     * IT ANSWERS A FACT AND ACTS ON NOTHING: no revocation, no deletion, no audit write. Returns the
     * sibling toolkits, sorted, never including `toolkit`, and the unanswered count.
     */
    async siblingApps(input: {
      toolkit: string;
      account: AccountRef;
    }): Promise<{ siblings: string[]; unanswered: number }> {
      return resolveSiblings(input);
    },

    /**
     * Start an Arcade authorization attempt for one person: take the key if it is free, expired or
     * completed, and refuse if a LIVE attempt holds it. ONE STATEMENT.
     *
     * `actorId` IS THE SESSION SUBJECT (`users.id`), NEVER `credentialActorId`. This file reads
     * `input.credentialActorId ?? input.actorId`, and on a Team Bot those differ, and neither is the
     * person holding the browser. The verifier finds the attempt from the returning browser's
     * session, so any other key writes attempts a browser can never match.
     *
     * ONE STATEMENT BECAUSE A READ-THEN-WRITE LETS TWO REQUESTS BOTH SEE "NO LIVE ATTEMPT" AND BOTH
     * INSERT. The conditional `ON CONFLICT ... DO UPDATE ... WHERE` is what makes the claim atomic:
     * the second request waits on the first's row and then evaluates the WHERE against it. The
     * live row is answered by the same statement, in a branch that only produces rows when the
     * claim produced none. It can be null: a rival that committed after this statement took its
     * snapshot is live but not yet visible to it, and the caller's 409 then names nothing.
     *
     * `created_at` is truncated to milliseconds so the `Date` handed back names the stored value
     * exactly — a microsecond no `Date` can carry would otherwise sit in the row unreachable.
     * {@link recordAuthorizationMint} and {@link discardAuthorizationAttempt} do not RELY on that:
     * they truncate the column in the comparison too, so a row written by anything else — the
     * column's own `defaultNow()`, say — is still reachable. See {@link attemptNamed}.
     */
    async claimAuthorizationAttempt(input: {
      actorId: string;
      serverId: string;
      action: string;
      account: AccountRef;
    }): Promise<
      | { claimed: true; attempt: PendingAuthorization }
      | { claimed: false; live: PendingAuthorization | null }
    > {
      const rows = await database.execute(sql`
        WITH claimed AS (
          INSERT INTO pending_authorizations
            (actor_id, server_id, action, holder, user_id, vendor_user_id, created_at)
          VALUES (
            ${input.actorId}, ${input.serverId}, ${input.action}, ${input.account.holder},
            ${input.account.holder === "person" ? input.account.userId : null},
            ${input.account.vendorUserId}, date_trunc('milliseconds', now())
          )
          ON CONFLICT (actor_id) DO UPDATE SET
            server_id = EXCLUDED.server_id,
            action = EXCLUDED.action,
            holder = EXCLUDED.holder,
            user_id = EXCLUDED.user_id,
            vendor_user_id = EXCLUDED.vendor_user_id,
            auth_id = NULL,
            created_at = EXCLUDED.created_at,
            completed_at = NULL,
            outcome = NULL
          WHERE pending_authorizations.created_at < now() - interval '15 minutes'
            OR pending_authorizations.completed_at IS NOT NULL
          RETURNING *
        )
        SELECT true AS claimed, claimed.* FROM claimed
        UNION ALL
        SELECT false AS claimed, p.* FROM pending_authorizations p
        WHERE p.actor_id = ${input.actorId}
          AND NOT EXISTS (SELECT 1 FROM claimed)
      `);
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) return { claimed: false, live: null };
      const attempt = pendingAuthorizationFromRow(row);
      return row.claimed === true
        ? { claimed: true, attempt }
        : { claimed: false, live: attempt };
    },

    /**
     * Write the `ar_...` the vendor minted onto the attempt, matched on `(actor_id, created_at)`
     * through {@link attemptNamed}, which is where the precision of that match is argued.
     *
     * WRITE-ONCE, AND NEVER AFTER SETTLEMENT: the UPDATE also requires `auth_id IS NULL` and
     * `completed_at IS NULL`. `auth_id` is what binds the attempt to the authorization the person
     * was actually sent to consent to, and both conditions are needed to keep that binding fixed.
     *
     * `completed_at IS NULL` is {@link closeAuthorizationAttempt}'s rule, for the same reason: a
     * settled attempt is a record, not a draft. Without it, a late or duplicated mint rewrote a
     * completed attempt's `ar_...`, even to NULL, and the row no longer named the authorization
     * the person consented to.
     *
     * `auth_id IS NULL` is needed because `completed_at IS NULL` alone still lets a duplicated mint
     * rebind a LIVE attempt. Once the person has the first id's consent URL, writing a second id
     * (or NULL) makes their return leg match nothing. A NULL `auth_id` is never valid after
     * settlement: every settling write (`completeAuthorizationAttempt` and the three verdicts
     * through `closeAuthorizationAttempt`) matches `auth_id = $1`, which NULL never satisfies.
     * So `auth_id IS NULL` alone would already rule out any row the store settled. `completed_at
     * IS NULL` is kept anyway, so the guard does not depend on every future writer settling
     * through those paths.
     *
     * The first write is the only one, and it can be NULL: a vendor that answered with no id
     * leaves the attempt null, and it expires. Answers whether it wrote. False means the attempt
     * was discarded, replaced, already minted or already settled. The authorize route acts on it:
     * on false it does not hand out the consent url, because nothing here records that flow.
     */
    async recordAuthorizationMint(input: {
      actorId: string;
      /** A `Date`, or the ISO string one becomes through JSON; see {@link attemptInstant}. */
      createdAt: Date | string;
      /** Null when the vendor answered with no id: the attempt then can never complete. */
      authId: string | null;
    }): Promise<boolean> {
      const written = await database
        .update(pendingAuthorizations)
        .set({ authId: input.authId })
        .where(
          and(
            attemptNamed(input.actorId, input.createdAt),
            isNull(pendingAuthorizations.authId),
            isNull(pendingAuthorizations.completedAt),
          ),
        )
        .returning({ actorId: pendingAuthorizations.actorId });
      return written.length > 0;
    },

    /**
     * Delete one attempt, matched on `(actor_id, created_at)` SO IT CAN NEVER DELETE A NEWER
     * ATTEMPT BY THE SAME ACTOR. Matching on `auth_id` would be wrong: an attempt whose mint never
     * completed has none, and that is exactly the one most worth cancelling.
     *
     * CONDITIONAL ON `completed_at IS NULL`, THE SAME RULE {@link closeAuthorizationAttempt} AND
     * THE COMPLETION HOLD, BECAUSE A SETTLED ATTEMPT IS A RECORD AND NOT A DRAFT. `(actor_id,
     * created_at)` does not stop naming a row when the row settles, and every caller of this reads
     * the attempt FIRST and deletes it AFTER. Unconditional, a completion committing in that gap
     * was erased outright — the one row saying this person's consent went through, with the grant
     * live at the vendor, the `brokered_connections` row written and `mcp.account_connected` on
     * the trail — and the cancel route then answered `{ cancelled: true }` for a consent that had
     * succeeded. The DELETE waits on the completion's row lock and re-evaluates this condition
     * against the committed row, so the guard holds under the race and not merely before it.
     *
     * `false` therefore means one of three things — no row under that key, a row under a different
     * `created_at`, or a row that has settled — and all three are "nothing was discarded". A caller
     * that must tell the third apart asks {@link settledAuthorizationOutcome}.
     */
    async discardAuthorizationAttempt(input: {
      actorId: string;
      /** A `Date`, or the ISO string one becomes through JSON; see {@link attemptInstant}. */
      createdAt: Date | string;
    }): Promise<boolean> {
      const deleted = await database
        .delete(pendingAuthorizations)
        .where(
          and(
            attemptNamed(input.actorId, input.createdAt),
            isNull(pendingAuthorizations.completedAt),
          ),
        )
        .returning({ actorId: pendingAuthorizations.actorId });
      return deleted.length > 0;
    },

    /**
     * How the attempt named by `(actor_id, created_at)` ended, or null while it has not ended, or
     * when no row carries that key.
     *
     * FOR THE ONE CALLER THAT HAS TO SAY WHY A DISCARD REFUSED: the cancel route, which must not
     * answer a person whose consent COMPLETED while they were cancelling it as though nothing had
     * happened. Named through {@link attemptNamed} like the discard it explains, so it can only
     * report the attempt that discard was aimed at and never a newer one by the same actor. Once
     * settled, a row keeps that `created_at` until a new claim takes the key and rewrites it, so a
     * reading after the refused DELETE answers for the same attempt the DELETE refused.
     */
    async settledAuthorizationOutcome(input: {
      actorId: string;
      createdAt: Date | string;
    }): Promise<PendingAuthorization["outcome"]> {
      const [row] = await database
        .select({ outcome: pendingAuthorizations.outcome })
        .from(pendingAuthorizations)
        .where(attemptNamed(input.actorId, input.createdAt));
      return row?.outcome ?? null;
    },

    /**
     * Finish one Arcade authorization: consume the attempt, record the connection and file the
     * trail, ALL THREE IN ONE TRANSACTION OR NONE OF THEM.
     *
     * THE ATTEMPT ROW IS THE SERIALIZATION POINT AND THE DATABASE ENFORCES IT. The first statement
     * is a conditional `UPDATE ... WHERE actor_id = $1 AND auth_id = $2 AND completed_at IS NULL
     * RETURNING`, and it is what makes completion happen exactly once. A read of the attempt
     * followed by a write would not: two callbacks can both read the row before either consumes it,
     * and both would then write a connection and a second `mcp.account_connected`. The second
     * caller's UPDATE instead waits on the first's row lock, re-evaluates `completed_at IS NULL`
     * against the committed row, and matches nothing.
     *
     * AN `auth_id` IN AN AUDIT PAYLOAD ENFORCES NOTHING, which is the shape this replaces.
     * {@link auditEvents.id} is `uuid().defaultRandom()`, so the trail has no key a second callback
     * could collide with — it would simply hold two rows for one connection, and the connection
     * upsert would have run twice on the way there.
     *
     * ZERO ROWS MEANS STOP, AND THE CALLER IS TOLD SO: `{ claimed: false }`, with nothing written.
     * It is still not an error — a replayed callback is a no-op rather than something somebody has
     * to explain — but it is no longer silent, because zero rows is not one fact. It is somebody
     * else completing this attempt first, where the account IS connected; or the attempt having
     * ended some other way underneath the caller — most sharply the person's own Cancel, whose
     * DELETE can land after the vendor confirmed the return and before this UPDATE, leaving a grant
     * live at the vendor that the person asked not to have. This used to answer the same for all
     * of them, and the verifier then told a person who had just cancelled that they were
     * connected. Which one it was is not this method's to decide: a caller holding `false` asks
     * {@link authorizationAttemptCompleted} whether the row says `completed`.
     *
     * THE CONNECTION AND THE AUDIT ROW ARE IN THE SAME TRANSACTION AS THAT UPDATE and not merely
     * after it. A failure between them used to leave the attempt consumed and nothing recording
     * what it was consumed FOR: the person's account is live at the vendor, this deployment holds
     * no `brokered_connections` row — which is the whole of the permission a brokered call is
     * decided on — and the attempt can never be completed again. The audit insert is bound to the
     * transaction for the same reason, through {@link createAuditStore} over the transaction handle
     * rather than the store's own `auditStore`, which holds the pool and would commit on its own.
     *
     * `scopes` IS WHAT THE VENDOR GRANTED, AND IT IS THE ONLY THING FROM THAT ANSWER THAT IS
     * WRITTEN ANYWHERE. Arcade's `auth.status` carries a live provider access token and an
     * authorization URL beside it; neither reaches this row, this method's arguments, a log line or
     * an error. What the trail gets is the action the attempt was for and the scopes that came
     * back, which is exactly what is needed later to explain a tool call refused for want of a
     * scope — the question {@link mcpUserCredentials.scope} exists to answer for a `user-oauth`
     * grant. `authProvider` is the authorization provider this deployment ASKED for (`google`, say, as
     * distinct from the broker, `brokered_connections.provider`). The caller resolves it from the
     * app's own row at freshness-revalidation time and passes it in; the attempt row has no
     * provider column to carry it. It is never read back out of a vendor reply, and the narrowed
     * `status` return of D31 makes that structurally impossible.
     */
    async completeAuthorizationAttempt(input: {
      actorId: string;
      authId: string;
      toolkit: string;
      account: AccountRef;
      action: string;
      scopes: string[];
      authProvider: string;
    }): Promise<{ claimed: boolean }> {
      return await database.transaction(async (transaction) => {
        /*
         * ONE STATEMENT, AND THE FIRST ONE. `completed_at` is truncated to milliseconds for the
         * reason `claimAuthorizationAttempt` truncates `created_at`: a `Date` carries only
         * milliseconds, and a column this deployment writes at microsecond precision is one no
         * later `Date`-valued filter can ever match. Nothing matches on this column today; writing
         * it the same way is what keeps that true if something does.
         */
        const claimed = await transaction.execute(sql`
          UPDATE pending_authorizations
             SET completed_at = date_trunc('milliseconds', now()),
                 outcome = 'completed'
           WHERE actor_id = ${input.actorId}
             AND auth_id = ${input.authId}
             AND completed_at IS NULL
          RETURNING actor_id
        `);
        if (claimed.length === 0) return { claimed: false };

        // Read inside the transaction, under the attempt's lock, so the answer the audit row
        // carries is the one this very write acted on rather than one a rival moved underneath it.
        const [existing] = await transaction
          .select({ app: brokeredConnections.app })
          .from(brokeredConnections)
          .where(accountRow(input.toolkit, input.account));

        const verifiedAt = new Date();
        const set = {
          verified: true,
          verifiedAt,
          // NOTHING WAS SPENT TO EARN THAT FLAG. A consent screen is the vendor's own yes, and no
          // action of the app's is ever called against it; see `confirmBrokeredConnection`, which
          // writes the same pair for the same reason.
          probeAction: null,
          updatedAt: verifiedAt,
        };
        /*
         * WHO CONNECTED THE TEAM ACCOUNT, WRITTEN HERE FOR THE SAME REASON EVERY OTHER WRITER
         * WRITES IT. `connectedBy` is only ever a deployment-held row's column — a person's row is
         * attributed by `user_id` already — and for a Shared app it is the attribution an
         * administrator reads off `deploymentConnectionFor` to decide whether a team connection is
         * legitimate and who to ask about it. This writer held `actorId`, the session subject
         * (`users.id`) the attempt is keyed on and the id the admin read joins `users` on, and
         * recorded none of it: an Arcade-consented Shared app's row was permanently null, and the
         * page then said nobody connected it. The null is a real state for rows written before
         * this, which is why both readers keep answering `null` rather than inventing a name.
         *
         * AND THE RE-CONSENT SUPERSEDES, which is `recordBrokeredConnection`'s rule spelled the
         * same way: a deployment account is shared, so the administrator who most recently
         * completed a consent for it is the one the row credits. Unconditional here, unlike there,
         * because this path always holds an actor — there is no caller that passes none.
         */
        const connectedBy =
          input.account.holder === "deployment" ? input.actorId : null;
        await transaction
          .insert(brokeredConnections)
          .values({
            // The broker this row was actually minted at, which is this store's own — never a
            // literal, for the reason `recordBrokeredConnection` sets out at length.
            provider: brokerProvider,
            app: input.toolkit,
            holder: input.account.holder,
            userId:
              input.account.holder === "person" ? input.account.userId : null,
            vendorUserId: input.account.vendorUserId,
            connectedBy,
            ...set,
          })
          .onConflictDoUpdate(
            input.account.holder === "person"
              ? {
                  target: [
                    brokeredConnections.provider,
                    brokeredConnections.app,
                    brokeredConnections.userId,
                  ],
                  targetWhere: sql`${brokeredConnections.holder} = 'person'`,
                  // The identity the grant was just made under, for `recordBrokeredConnection`'s
                  // reason: calls go out under the row's id, so a re-consent that left the old one
                  // standing sent them to an account this consent says nothing about.
                  set: { ...set, vendorUserId: input.account.vendorUserId },
                }
              : {
                  target: [
                    brokeredConnections.provider,
                    brokeredConnections.app,
                  ],
                  targetWhere: sql`${brokeredConnections.holder} = 'deployment'`,
                  set: {
                    ...set,
                    vendorUserId: input.account.vendorUserId,
                    connectedBy,
                  },
                },
          );

        await recordAuditEvent(
          createAuditStore(transaction as unknown as Database),
          {
            eventType: "mcp.account_connected",
            targetType: "mcp_server",
            // The app, the id every other writer of this event files a brokered connection under,
            // so one query answers what happened to one person's access to one app however it
            // began and however it ended.
            targetId: input.toolkit,
            payload: {
              actor: input.actorId,
              server: input.toolkit,
              /*
               * WHAT THE VENDOR GRANTED, WHICH A BROKERED ROW HAS NEVER BEEN ABLE TO SAY BEFORE.
               * Both Composio writers carry `""` because Composio holds the grant and never tells
               * this deployment what it covers; Arcade does tell us, on the key all four writers
               * already agree on, so the same query reads both.
               */
              scope: input.scopes.join(" "),
              // The action the attempt was for: what this grant was obtained in order to call.
              action: input.action,
              authProvider: input.authProvider,
              reconnected: Boolean(existing),
              holder: input.account.holder,
            },
          },
        );
        return { claimed: true };
      });
    },

    /**
     * Close an attempt as `failed` or `unreconciled`, matched on `(actor_id, auth_id)`.
     *
     * ON THE PAIR AND NOT ON `created_at`, unlike {@link recordAuthorizationMint} and
     * {@link discardAuthorizationAttempt}, because the caller here is the returning callback and
     * all it holds is the `ar_...`. An attempt with no `auth_id` matches nothing, which is correct:
     * no callback can be about an attempt that never minted one.
     *
     * CONDITIONAL ON `completed_at IS NULL`, exactly as the completion above is: an attempt that
     * has settled — completed, failed, unreconciled or withdrawn — is not reopened by a later
     * callback, and `false` says so. See {@link closeAuthorizationAttempt} for what the asymmetry
     * used to be and what it cost.
     */
    async failAuthorizationAttempt(input: {
      actorId: string;
      authId: string;
    }): Promise<boolean> {
      return await closeAuthorizationAttempt(input, "failed");
    },

    /**
     * Mark an attempt whose outcome this deployment could not settle — the vendor answered, and
     * what it answered could not be reconciled with the attempt. Kept apart from `failed` so an
     * operator can tell "the person declined" from "we do not know what happened".
     */
    async markAuthorizationUnreconciled(input: {
      actorId: string;
      authId: string;
    }): Promise<boolean> {
      return await closeAuthorizationAttempt(input, "unreconciled");
    },

    /**
     * Mark an attempt whose consent completed at the vendor and which this deployment then refused
     * and ended by withdrawing the grant — neither a decline nor an unknown. An operator seeing a
     * run of these is seeing apps whose mode is being switched inside a consent window, which is a
     * different problem from people declining.
     */
    async markAuthorizationWithdrawn(input: {
      actorId: string;
      authId: string;
    }): Promise<boolean> {
      return await closeAuthorizationAttempt(input, "withdrawn");
    },

    /**
     * The live attempt for a session subject (`users.id`, never `credentialActorId`), or null when
     * there is none, it is past the 15-minute TTL, or it has completed.
     */
    /**
     * Whether this attempt's completion COMMITTED — asked of the row the transaction serializes on.
     *
     * FOR ONE CALLER AND ONE QUESTION: `/arcade/verify`'s completion rejected, and "the call threw"
     * is not "the work rolled back". A connection lost on the way back from a COMMIT the server had
     * already applied rejects at the client over a grant that is written down, and the verifier
     * telling that person `not-recorded` sends them to mint a second consent at the vendor against
     * a connection they already hold. The attempt row is the one place that can say which happened:
     * {@link createPluginStore}'s `completeAuthorizationAttempt` stamps `outcome = 'completed'` in
     * the first statement of the transaction, so the stamp exists exactly when the transaction did.
     *
     * NOT {@link authorizationAttemptFor}, which cannot answer this. It filters on `completed_at IS
     * NULL` AND on the fifteen-minute TTL, so it answers `null` for a completed attempt and for an
     * expired one alike — and a verifier that read "no live attempt" as "it committed" would
     * report a grant that is not there for any completion that ran long enough to age out.
     *
     * MATCHED ON `(actor_id, auth_id)` like the closers above and never on `created_at`, because
     * what the caller holds at this point is the `ar_...`. A rival callback having completed the
     * same attempt first answers `true` here, which is correct: the grant is recorded either way,
     * and this deployment has never been able or willing to tell the winner from the loser.
     */
    async authorizationAttemptCompleted(input: {
      actorId: string;
      authId: string;
    }): Promise<boolean> {
      const [row] = await database
        .select({ actorId: pendingAuthorizations.actorId })
        .from(pendingAuthorizations)
        .where(
          and(
            eq(pendingAuthorizations.actorId, input.actorId),
            eq(pendingAuthorizations.authId, input.authId),
            eq(pendingAuthorizations.outcome, "completed"),
          ),
        );
      return row !== undefined;
    },

    async authorizationAttemptFor(
      actorId: string,
    ): Promise<PendingAuthorization | null> {
      const [row] = await database
        .select()
        .from(pendingAuthorizations)
        .where(
          and(
            eq(pendingAuthorizations.actorId, actorId),
            isNull(pendingAuthorizations.completedAt),
            sql`${pendingAuthorizations.createdAt} >= now() - interval '15 minutes'`,
          ),
        );
      return row ?? null;
    },

    /**
     * File `mcp.authorization_cancelled` for an attempt its own person has just retracted.
     *
     * CALLED ONLY AFTER {@link discardAuthorizationAttempt} ANSWERED TRUE, by the cancel route and by
     * nothing else. The same deletion also tidies up after a refused or unrecorded mint, and those
     * are this deployment cleaning up after itself, not a person withdrawing consent — so the row is
     * filed here, for the one caller whose act it describes, and not inside the deletion.
     *
     * TARGETED AT THE APP'S SLUG, read off the attempt's server row with {@link toolkitOfFor}, which
     * is the id `mcp.account_connected` and `mcp.account_disconnected` file a brokered app under, so
     * one query on the target answers every ending of one app's consent. An attempt OUTLIVES what
     * its row's url says — an administrator can re-point the row while a consent is in flight, and
     * the cancel route deliberately still lets the person retract it — and once the url names no
     * app the row's own id is the only name left for what was cancelled, so that is what the row is
     * filed under; `serverId` is in the payload either way.
     *
     * WHO DID IT GOES IN THE PAYLOAD, as on every writer here, never in `actorUserId`. And the
     * payload carries NEITHER the consent url NOR the attempt's `auth_id`: the attempt row never held
     * the url, and the vendor's handle is not needed to say what a person withdrew. `minted` is
     * whether a flow had been started at the vendor at all.
     */
    async recordAuthorizationCancelled(input: {
      actorId: string;
      attempt: PendingAuthorization;
    }): Promise<void> {
      const [row] = await database
        .select({ url: mcpServers.url })
        .from(mcpServers)
        .where(eq(mcpServers.id, input.attempt.serverId))
        .limit(1);
      const toolkit = row ? toolkitOfFor(brokerProvider, row.url) : null;
      await recordAuditEvent(auditStore, {
        eventType: "mcp.authorization_cancelled",
        targetType: "mcp_server",
        targetId: toolkit ?? input.attempt.serverId,
        payload: {
          actor: input.actorId,
          server: toolkit,
          serverId: input.attempt.serverId,
          action: input.attempt.action,
          holder: input.attempt.holder,
          minted: input.attempt.authId !== null,
        },
      });
    },

    /**
     * A cancelled consent whose grant was left live at the vendor. See `mcp.cancelled_grant_left_live`.
     * Filed under the app's slug, beside the `mcp.authorization_cancelled` row the cancel filed.
     */
    async recordCancelledGrantLeftLive(input: {
      actorId: string;
      attempt: PendingAuthorization;
      toolkit: string;
      why: string;
      siblings: readonly string[];
    }): Promise<void> {
      await recordAuditEvent(auditStore, {
        eventType: "mcp.cancelled_grant_left_live",
        targetType: "mcp_server",
        targetId: input.toolkit,
        payload: {
          actor: input.actorId,
          server: input.toolkit,
          serverId: input.attempt.serverId,
          action: input.attempt.action,
          holder: input.attempt.holder,
          why: input.why,
          siblings: [...input.siblings],
        },
      });
    },

    /**
     * Spend one call on this person's key, and say what the vendor made of it.
     *
     * ONE PROBE, TWO CALLERS, AND THE ANSWER TO "WHAT DOES A FAILED PROBE MEAN" LIVES HERE ONCE.
     * {@link connectBrokeredWithFields} probes a key somebody has just typed;
     * {@link recheckBrokeredConnection} probes one this deployment has held for days. Both have to
     * choose the action the same way, send it the same way, and read the vendor's answer the same
     * way — and a second copy of that reading is how one of them comes to treat a rejected key as a
     * connection that merely could not be checked. What the two callers do NEXT is all that differs,
     * and it is all either of them keeps for itself: one withdraws the account it just made, the
     * other leaves an account it did not make alone.
     *
     * FOUR ANSWERS AND NOT A BOOLEAN, because `verified: false` means several different things
     * about somebody's key and the flag separates none of them. They are enumerated on
     * {@link BrokeredProbe}, which is where a reader should go; the one worth repeating at the call
     * this method makes is the fourth.
     *
     * A VENDOR THAT WAS NOT REACHED IS NOT A VENDOR THAT SAID NO, and this is the one place that
     * can tell. `callTool` answers with a result rather than throwing, and `isError` is true for all
     * three of the failures it documents — so read as a verdict here, a Composio outage, a socket
     * that closed, a `@composio/core` that cannot parse what came back and a run attributed to
     * nobody were every one of them "the vendor refused this key". What that cost is at the callers
     * and it was the worst thing this feature did: on connect the account somebody had just made
     * was deleted at the vendor and they were told what they entered did not work; on re-check a
     * live, working connection was stripped of its verification and marked as holding a bad key.
     * {@link ActionAnswer} is what the transport now answers beside the result, and this method
     * asks for it by calling `askAction` rather than `callTool`.
     *
     * A FAILURE IS RETURNED RATHER THAN THROWN, which is the one thing this function does not
     * decide. Its two callers end a bad key differently — one undoes an account and refuses, the
     * other writes the row unverified and refuses — so a throw here would force the undo on both or
     * neither. What it owes them is the vendor's sentence and the name of what was tried.
     *
     * NOTHING IS WRITTEN, NOTHING IS AUDITED, AND NO ACCOUNT IS TOUCHED. This is a question asked of
     * the vendor; recording the answer belongs to whoever asked it.
     */
    async probeBrokeredConnection(input: {
      toolkit: string;
      account: AccountRef;
      /**
       * THE ACCOUNT TO SPEND IT IN, where the caller has one in mind.
       *
       * {@link connectBrokeredWithFields} has just made an account and is asking about THAT key; a
       * person and an app do not name it, because one person may hold several accounts for one app
       * and the vendor picks which a call runs in. Unpinned, a bad key was verified by the person's
       * other, working account — and the same defect the other way round condemned a good key, and
       * deleted the account it made, on the strength of some other account of theirs being broken.
       *
       * ABSENT FOR A RE-CHECK, AND THAT IS A GAP RATHER THAN A CHOICE. `brokered_connections`
       * records no account id — a person's row is keyed on the person and the app, a deployment
       * row on the app alone — so a press of Re-check has nothing to pin to and asks the vendor
       * the same app-level question it always did. It is
       * the milder half: a re-check writes a verdict but takes nothing away, and its refusal tells
       * the person their key is wrong rather than removing anything they hold.
       */
      accountId?: string;
    }): Promise<BrokeredProbe> {
      /*
       * THE ONE ACTION THIS DEPLOYMENT WILL SPEND THE KEY ON, chosen from what the app published.
       *
       * Composio accepts a key without ever trying it, so "connected" at the vendor is not evidence
       * that the credential works — and a row written on that acceptance is a gate every later
       * brokered call passes for a key that cannot answer. {@link probeActionFor} is what keeps the
       * call safe: the vendor must have labelled the action a read and it must take no arguments,
       * and both matter because the first argument-less action on Stripe's own list creates a
       * billing session. It answers the VERSION beside the name, because Composio refuses an
       * execution without a specific one — so an action recorded without a version is one the
       * chooser passes over rather than one this method discovers it cannot call. Null is an
       * ordinary answer — see that method — and it is the FIRST of the three states above.
       *
       * NOTHING IS ASKED A SECOND TIME HERE, AND THAT IS THE POINT. Every condition on whether an
       * action can be spent on a key lives in the chooser, so the action this method sends is the
       * action the chooser said was sendable, whole. A version re-read here would be a second
       * predicate for one question, and the weaker of two predicates is what once had a reloaded
       * page tell somebody their untried key had been rejected — in the days when the connections
       * listing answered by asking the chooser too. It no longer does: what a page says about a
       * check is what the check recorded, and what it recorded is the name this method returns.
       *
       * AND THE APP IS RESOLVED BY ITS URL, THE WAY EVERY OTHER BROKERED LOOKUP HERE IS — through
       * {@link brokeredAppRow}, which is the one read that decides it. The url is where a brokered
       * row records which app it is; `mcp_servers.id` is a display name and nothing holds the two
       * equal — which is exactly why {@link connectBrokeredWithFields}, {@link
       * recheckBrokeredConnection} and {@link disconnectBrokered} all key on the url, and why {@link
       * brokeredConnectionsFor} resolves on it rather than spelling `composio-${toolkit}` by hand.
       * Composing it here made this method the one place that re-derived the id from a convention,
       * and it put the two halves of the `checkable`/`probe` split back into disagreement on any
       * row where they differ: the listing answered `checkable` off the app's real row while this
       * answered off an id addressing nothing, so the button was offered and the press could never
       * find anything to spend — the Re-check deadlock the split exists to prevent, reached from
       * the other end. Worse where the composed id DID hit something: a row called `composio-gmail`
       * at `composio://slack` would have this choose a stranger's probe off another app's listing
       * and spend their key on it. A row this deployment has since removed drops out here as null,
       * which is the same honest answer the listing gives for it: there is no app left to check.
       *
       * AND THE SHARED READ RATHER THAN A URL QUERY OF ITS OWN, because `mcp_servers.url` has no
       * unique index and an unordered `limit(1)` over it is not an answer. A second row at the app's
       * url — the ordinary state of any database where a fixture sits beside the `composio-` row an
       * administrator really added — had this resolve to whichever row the scan met first while the
       * listing named the app by the lower id, which is the SAME deadlock one step along: Re-check
       * offered off the app's own row, and the press landing on a row that publishes no action and
       * reporting there was nothing to try. One function decides which row answers for an app, so
       * nothing here can name one row while something else names another.
       */
      const app = await brokeredAppRow(input.toolkit);

      const candidate = app ? await this.probeActionFor(app.id) : null;
      if (candidate === null) {
        return { outcome: "nothing", probe: null };
      }

      /*
       * THE TRANSPORT DIRECTLY, AND NOT `callTool` ABOVE. This deployment's own `callTool` checks a
       * grant, evaluates the policy and writes an `mcp.call_*` row, and there is no Bot here to
       * check a grant for, no policy context to evaluate and no Bot to attribute a row to. What
       * holds this narrow is structural rather than disciplinary: no endpoint, no arguments, and an
       * action chosen from recorded metadata rather than from anything a request said. See
       * `mcp.connection_verified` in `./audit`, which records the same three properties as the
       * reason this call may skip the checks the ordinary path cannot — and which names both of
       * this function's callers as the whole of who may make it.
       *
       * THE VERSION IS NOT AN ARGUMENT. It travels under the transport's reserved key, which the
       * Composio transport strips before anything reaches the vendor and asserts that it did, so
       * what Composio is handed is the action and an empty argument object.
       */
      /*
       * AND ON ANY OTHER BROKER THIS REFUSES RATHER THAN DIALS, because `composioAskAction` is
       * Composio's own `askAction` and no counterpart has been written for a second broker.
       *
       * CRITERION. A deployment whose broker is not Composio gets a stated refusal here, and no
       * request leaves this process.
       *
       * REASON. The url this used to compose was `composio://<toolkit>` whatever the broker was, so
       * an Arcade deployment's check was sent to Composio with a Composio-shaped url. On a
       * deployment holding no Composio key that fails at a vendor it has no business talking to and
       * the person is told their connection could not be checked — an outage reported where there
       * was none. Where a Composio key IS present it is worse: the slug is a plain app name, so the
       * call lands on an UNRELATED app of the same name at the wrong vendor and succeeds, and the
       * row records a verified check of an account nobody holds.
       *
       * `unreachable` IS THE HONEST OUTCOME, not `nothing`. Nothing was learned about the key and
       * nothing is recorded about it — `probe` is null, so {@link _ProbeOutcomeLeaves} leaves the
       * row untouched and `probe_action` unwritten — and `attempted` is what WOULD have been spent,
       * which is the fact about this deployment's intent that field exists to carry. The sentence
       * names the state rather than blaming the connection, because the gap is ours.
       *
       * TODO: delete this once a probe is designed for the second broker. Until then a refusal that
       * says so is the only answer that is not a claim about somebody's account.
       */
      if (brokerProvider !== "composio") {
        return {
          outcome: "unreachable",
          probe: null,
          attempted: candidate.name,
          sentence: `This deployment brokers its apps through ${BROKERED_PROFILE[brokerProvider].vendor}, and the only connection check this deployment knows how to make is Composio's. Nothing was asked about this connection, so nothing is recorded about it.`,
        };
      }

      const { result, answered } = await composioAskAction(
        {
          url: `${BROKERED_PROFILE.composio.scheme}${input.toolkit}`,
          actorId: input.account.vendorUserId,
          // Spread rather than passed as `undefined`, so "any account of theirs" reaches the wire
          // as a body with no such key. See {@link ComposioActions.execute}.
          ...(input.accountId === undefined
            ? {}
            : { accountId: input.accountId }),
        },
        candidate.name,
        { [VERSION_ARG]: candidate.version },
      );

      /*
       * THE READING, AND IT IS THE WHOLE OF WHAT THIS METHOD DECIDES. `answered` is the transport's
       * own statement that Composio ran the action in the account and said how it went; `isError`
       * then says what it said. Anything else is an outage or an answer this deployment could not
       * read, and neither is evidence about a key — so the action's NAME is withheld from those,
       * because the name beside `verified: false` is the accusation and only a call that can be
       * shown to have run may make it.
       */
      if (!answered) {
        return {
          outcome: "unreachable",
          probe: null,
          attempted: candidate.name,
          sentence: result.text,
        };
      }

      /*
       * AND `isError` SAYS THAT THE CALL WENT BADLY, NOT THAT THE KEY IS BAD. The envelope this is
       * read out of is `{ data, error, successful }` and nothing more: a 429, a scope this one
       * action needs and the key legitimately lacks, and a 404 for a resource the read action names
       * all arrive here identically to a credential the vendor rejected. So the outcome is named
       * for what was observed — the app complained — and the two readings that treated it as a
       * verdict about the credential are gone from both callers. See {@link BrokeredProbe}.
       */
      return result.isError
        ? {
            outcome: "complained",
            probe: candidate.name,
            sentence: result.text,
          }
        : { outcome: "answered", probe: candidate.name };
    },

    /**
     * Ask Composio whether this person's account is really attached, and write down the answer.
     *
     * THE VENDOR IS ASKED, NOT THE BROWSER. The return trip from a consent screen is an ordinary
     * redirect carrying nothing signed, so a person arriving back on the page is not evidence that
     * they finished the flow, nor that the account they finished it with is the one a row would
     * claim. A confirm that wrote a row because somebody came back would hand every later brokered
     * call a gate that passes for an account nobody has — and the first anyone would hear of it is
     * the vendor's own error about a connection it cannot find, at the moment a Bot was asked to do
     * something.
     *
     * SO THE ANSWER NO LEAVES NO ROW BEHIND. `false` from {@link ComposioBroker.isConnected} is a
     * positive claim that there is no account, and the honest local state for that claim is an
     * absence — so a row already sitting here is deleted rather than left standing. Leaving it
     * would have the settings list go on drawing "Connected" for an account nobody has, and would
     * go on passing the gate every later brokered call is decided on, while the app's own detail
     * page asks the vendor and says the opposite.
     *
     * AND THAT DELETION FILES NO TRAIL ENTRY. Nobody disconnected anything here: the grant ended
     * somewhere else, and this is our record catching up with a fact. {@link disconnectBrokered}
     * owns `mcp.account_disconnected` and files it for the act it performed; a second filer here
     * would have the trail claim an act that did not happen, credited to whichever page load
     * happened to notice.
     *
     * UPSERT RATHER THAN INSERT, keyed on the pair the table itself is keyed on. This is safe to
     * call repeatedly and is meant to be: because the row is only a cache of the vendor's answer
     * (see {@link brokeredConnection}), a row that drifted out of step — an account ended in
     * Composio's own dashboard, a connect this deployment missed the callback for — is healed by
     * the next confirm on any page load, in whichever direction it drifted: by the upsert here
     * where the vendor says yes, and by the delete above where it says no.
     *
     * AND THE YES WRITES A VERDICT ONLY WHERE CONSENT IS THE CHECK, which is the one thing a reader
     * of this method has to carry away. `verified: true` beside a null `probeAction` is not a
     * neutral heal: it is a NAMED one of the four states {@link composioConnections.probeAction}
     * enumerates — the consent state — and this method runs from an effect on mount, so writing it
     * unconditionally meant every page load restated it over whatever a real check had recorded.
     * For a key connection that erased the record, worst of all over "a named probe beside
     * `verified: false`", the live account with a bad key behind it that is the one state somebody
     * must act on; and it re-dated `verified_at` to the page load, so the row claimed a check on a
     * day nothing was checked. The yes itself does not bear on a key: {@link
     * ComposioBroker.isConnected} says an account is attached, Composio takes a key when it is
     * typed and never tests it again, so for a key app that answer is what the row's existence
     * already said. The branch is on the scheme recorded on the app's row, classified through {@link
     * brokeredAppKind} as {@link connectBrokeredWithFields} and {@link recheckBrokeredConnection}
     * classify theirs, and a key row already here is left untouched — the evidence about a key is a
     * call, and those two are the only writers of this row's verdict. A key app the vendor holds an
     * account for with no row here still gets one, written UNCHECKED, because the row is the gate
     * every later brokered call passes through and the only thing Disconnect works off.
     *
     * AND THE FLAG IS WRITTEN FOR A CONSENT APP RATHER THAN FOR ANYTHING THAT IS NOT A KEY APP. A
     * scheme this deployment cannot read — a null, or a literal nothing here writes — is neither
     * kind, and it takes the key app's treatment: nothing recorded is overwritten, and a person the
     * vendor holds an account for still gets the row that is their permission. See {@link
     * SchemeKind} for why that third answer has to travel rather than be flattened into the second.
     *
     * `scope` IS EMPTY BECAUSE COMPOSIO GRANTS NONE THAT IT TELLS US ABOUT. The field exists so a
     * later refusal for want of a permission can be explained by what the vendor actually granted,
     * and Composio's connection answer is a boolean with no scope in it. Writing a plausible claim
     * there — the app's full access, say — would put words in the vendor's mouth in the one field
     * whose whole job is to say what it said.
     *
     * `reconnected` IS FALSE FOR THE SAME REASON, and trivially so. The flag distinguishes somebody
     * replacing a grant from somebody making one, and the only confirms that reach the trail are
     * the ones that found no row at all — so there was nothing here to replace.
     *
     * AND THE EVENT IS WRITTEN ONLY WHERE THE ROW IS NEW. This method runs on every page load
     * rather than only when a person acts, so an event per yes from the vendor would file ten
     * "account connected" rows for somebody who opened the connector page ten times having
     * connected once. A confirm that heals a row nothing changed is a read, and the trail records
     * acts: where a row was already there the connection has been recorded once already, by the
     * confirm that first found none.
     */
    async confirmBrokeredConnection(input: {
      toolkit: string;
      account: AccountRef;
      by: string;
    }): Promise<{ connected: boolean }> {
      // Before anything, and for the reason `addBrokeredApp` says it first too: a deployment with
      // no key has no broker to have connected anybody at, so there is nothing here to ask.
      if (!broker) throw new BrokerUnconfiguredError(brokerProvider, "person");

      const connected = await broker.isConnected({
        account: input.account,
        toolkit: input.toolkit,
      });
      if (!connected) {
        // Deleted rather than left alone, because the row is only the vendor's last answer: an
        // account ended in Composio's own dashboard reaches this deployment as the no above and
        // as nothing else, and a row that outlived it would go on saying yes about an account the
        // vendor has just denied.
        await database
          .delete(brokeredConnections)
          .where(accountRow(input.toolkit, input.account));
        return { connected: false };
      }

      /*
       * READ BEFORE THE WRITE, because the upsert leaves nothing behind that tells the two cases
       * apart, and whether a row was already here is the whole of what decides if anybody acted.
       *
       * AND THE VERDICT IS READ BESIDE THE ROW'S EXISTENCE, which is the consent arm's business.
       * `verified` here is the difference between "this deployment has already recorded the
       * vendor's yes" and "it has not", and the write below is conditioned on it so that a mount
       * cannot re-date a consent that was recorded days ago. The column is read directly rather
       * than through {@link brokeredConnection}, which answers with the connection date alone.
       */
      const [held] = await database
        .select({ verified: brokeredConnections.verified })
        .from(brokeredConnections)
        .where(accountRow(input.toolkit, input.account))
        .limit(1);
      const existing = held !== undefined;

      /*
       * THE SCHEME ON THE APP'S ROW, WHICH IS WHAT DECIDES WHETHER THE YES ABOVE IS A CHECK.
       *
       * Keyed on the url and on the one row that answers for it — see {@link brokeredAppRow} — which
       * is the read {@link connectBrokeredWithFields} and {@link recheckBrokeredConnection} both
       * make: `mcp_servers.id` is a display name and nothing holds the two equal, so a row called
       * `gmail` at `composio://slack` would decide a Slack confirm on Gmail's scheme, and a second
       * row at the app's own url would have this confirm branch on a scheme the re-check beside it
       * disagrees with. Asked through {@link brokeredAppKind} rather than compared as a string, so
       * the schemes this branches on cannot drift from the schemes that have a key behind them.
       *
       * AND THE QUESTION IS "IS THIS A CONSENT APP", NOT "IS THIS NOT A KEY APP", which are the same
       * question only if the column can always be read.
       *
       * CRITERION. `verified: true` is written here for an app this deployment KNOWS connects by
       * consent, and for no other.
       *
       * REASON. This branched on {@link isFieldScheme} alone, so every other answer — a consent
       * scheme, a literal from a deployment that knew other names, a NULL — fell into the consent
       * arm by elimination. A null is not a consent app: it is a column this deployment cannot read,
       * which {@link mcpServers.authScheme} calls a row that is not brokered and which the row that
       * ANSWERS for an app is perfectly free to carry — no unique index stands behind that url, so
       * the row an enable wrote its scheme onto is not always the row found here. Confirm runs from
       * an effect on mount, so the elimination wrote `verified: true` with a fresh `verified_at` and
       * a null probe over that row on every page load: a verdict about evidence nobody has, dated to
       * the day somebody opened a page, over whatever a real check had recorded. The other two
       * readers of this column already fail closed on the null — {@link recheckBrokeredConnection}
       * refuses the press, {@link disconnectBrokered} claims no revocation — so the one caller that
       * could not survive being wrong was the only one failing open.
       *
       * SO AN UNREADABLE SCHEME IS TREATED AS A KEY APP IS, and that is the cautious half in both
       * directions: nothing already recorded is overwritten, and the row that is the gate is still
       * written where the vendor holds an account nothing here has a row for.
       */
      const kind = await brokeredAppKind(input.toolkit);

      /**
       * WHAT THIS CONFIRM ANSWERS FOR EACH KIND OF APP, WRITTEN DOWN BECAUSE THE CHAIN CANNOT BE.
       *
       * Type-only and erased; see {@link Decides}. The chain below tests ONE member and then tests
       * something else — `kind === "none"`, `kind === "consent"`, then `!existing` — so there is no
       * position where the compiler has this vocabulary narrowed away and nothing here would fail
       * for a fifth member.
       * This is the caller that WRITES, and it is the one that could not survive being wrong: it
       * runs from an effect on mount, so whatever it decides for a member nobody named is decided
       * again on every page load.
       *
       * EVERY CELL IS NOW ASSERTED RATHER THAN DECLARED. `consent` used to be written as what the
       * code did rather than as what it should do — the re-stamp of `verified_at` on an
       * already-consented row was a live finding — and `none` did not exist as a member at all, so
       * a no-auth app was classified `consent` and got that same write on every mount. See the
       * table in `tests/composio-connection-kinds.test.ts`, which drives each of these four against
       * the running code.
       */
      type _ConfirmDecides = Decides<
        SchemeKind,
        {
          key: "leaves an existing row exactly as it is; records a new one as unchecked";
          consent: "records the vendor's yes as a verification the first time, and leaves an already-consented row alone";
          none: "writes nothing and files nothing — there is no account here for a row to be about";
          unreadable: "treated as a key app is — nothing already recorded is overwritten";
        }
      >;

      /*
       * AND THE CONSENT WRITE HAPPENS ONCE, WHICH IS THE OTHER HALF OF "A MOUNT DOES NOT RE-DECIDE".
       *
       * CRITERION. `verified: true` is written for a consent app only where this deployment has not
       * already recorded it. A row already carrying that verdict is left exactly as it is, its
       * `verified_at` included.
       *
       * REASON. The arm was unconditional, and this method runs from an effect on mount — so every
       * page load re-stamped `verified_at` to the moment of the load. The flag never changed, so
       * nothing looked wrong; what was destroyed was the DATE, which for a consent connection is
       * the day somebody finished at the vendor's own screen and is a fact nothing else in this
       * deployment records. The row's own sentence, "last checked 1 Sep", became "last checked
       * today" on a day nothing was checked, and the real date could not be recovered from anywhere.
       * {@link recheckBrokeredConnection} refuses to probe a consent app in order to protect exactly
       * that date; a confirm that re-stamped it on every mount destroyed from the inside what that
       * refusal protects from the outside. Two earlier fixes made this arm conditional for the key
       * case and then for the unreadable case and left the consent case — the one the arm is
       * actually FOR — writing on every load.
       *
       * AND A ROW NOT YET CARRYING THE VERDICT IS STILL HEALED, once. A consent app whose row was
       * written by some other path — a key-era connect, an enable that changed the app's scheme
       * afterwards — reads `false` with a null date, which is the pair "nobody has checked" and is
       * not true of a consented account. The vendor's yes above is the check for this kind of app,
       * so it is recorded, with the stamp of the moment it was first recorded here, and the next
       * mount finds the verdict already present and writes nothing.
       */
      /*
       * AN APP THERE IS NOTHING TO CONNECT TO GETS NO ROW, WHICH IS THE OTHER TABLE'S RULE APPLIED
       * HERE FOR THE FIRST TIME.
       *
       * CRITERION. Nothing is written and nothing is filed for a `none` app, whatever the vendor
       * answered about it.
       *
       * REASON. `NO_AUTH` used to be a member of the CONSENT list, so the classifier called it
       * consent and the arm below wrote `verified: true` with a fresh `verified_at` for it — on
       * every page load, because this runs from an effect on mount. That is precisely the row the
       * connect route refuses to create for these apps and the row the per-person gate is written to
       * do without: `composio_connections` is the whole of the permission for a brokered call, and
       * every row in it means one thing, that this person granted this deployment access to their
       * account at this app. There is no account — Composio refuses even to hold an authorization
       * config for a no-auth toolkit — and there is no grant, so a year on, offboarding, the trail
       * and the Disconnect button could not tell those rows from ones somebody really made.
       *
       * THE NEGATIVE HEAL ABOVE STILL RAN, and deliberately: a row left behind by the version that
       * wrote them is removed by the first mount that finds the vendor holding no account, which is
       * every mount for an app like this.
       */
      if (kind === "none") return { connected: true };

      if (kind === "consent" && !held?.verified) {
        // VERIFIED, BECAUSE A CONSENT SCREEN IS A VERIFICATION AND NOT A LESSER KIND OF ONE. The
        // vendor has just answered that this person's account is attached, which is the same
        // question a probe goes and asks; that the evidence arrived through a consent flow rather
        // than through a call this deployment made does not make it weaker. Writing on the column
        // defaults instead left every consent connection reading `false` with a null `verified_at` —
        // the pair a key somebody typed in and nobody ever checked reads — so the settings page could
        // not tell the two apart. Written through the single writer above rather than here, so this
        // path and the verify path cannot come to write two different row shapes; see
        // {@link composioConnections.verified}.
        await this.recordBrokeredConnection({
          toolkit: input.toolkit,
          account: input.account,
          connectedBy: input.by,
          verified: true,
          // NOTHING WAS SPENT TO EARN THAT FLAG, and that is what the null records rather than an
          // absence of information. A consent connection is verified by the vendor's own yes at its
          // own screen; no action of the app's is ever called against it, here or later, so there is
          // no name to write and there never will be. The derived field could not say so — it
          // answered with whatever the app happened to publish — and a consent row was listed as
          // having been checked with an action nothing had called.
          probeAction: null,
        });
      } else if (kind !== "consent" && !existing) {
        /*
         * A KEY APP THE VENDOR HOLDS AN ACCOUNT FOR AND NOTHING HERE HAS A ROW FOR: recorded as
         * UNCHECKED, which is the honest one of the four states for it. The account was made
         * somewhere this deployment did not watch — in Composio's own dashboard, or by a connect
         * whose row was lost — so no key of theirs has ever been tried from here, and null beside
         * `false` is exactly "nothing was spent". The row still has to exist: it is the gate every
         * later brokered call passes through, and the only thing Disconnect works off.
         *
         * AND AN APP WHOSE SCHEME CANNOT BE READ IS WRITTEN THE SAME WAY, for the same sentence
         * one word weaker: nothing here has ever checked this account, and nothing here knows what
         * checking it would even mean. `false` beside a null claims neither a check nor a refusal,
         * which is the only pair that is true of it — and the row is still the permission, so a
         * person whose account Composio holds does not lose their access to a column nobody wrote.
         */
        await this.recordBrokeredConnection({
          toolkit: input.toolkit,
          account: input.account,
          connectedBy: input.by,
          verified: false,
          probeAction: null,
        });
      }
      /*
       * AND AN EXISTING KEY ROW IS LEFT EXACTLY AS IT IS, which is the whole of what this branch
       * does and the reason there is a branch at all.
       *
       * THIS RUNS FROM AN EFFECT ON MOUNT. Both brokered account screens confirm on every page
       * load, so whatever is written here is written again every time somebody opens the page —
       * and `verified: true` beside a null `probeAction` is not a neutral heal. It is one of the
       * four states {@link composioConnections.probeAction} enumerates, and specifically the
       * CONSENT one: "the vendor's own yes is the evidence and no call was ever made against the
       * account". Written over a key row it erased the record of the last check and replaced it
       * with that sentence, including over the worst state this feature has — a named probe beside
       * `verified: false`, "it ran, the vendor refused the key, and the account is still standing"
       * — which is the one state an operator has to act on. It also moved `verified_at` to the
       * moment of the page load, so the row's own sentence, "last checked 13 Sep", named a day on
       * which nothing was checked.
       *
       * BECAUSE THE YES IS NOT EVIDENCE ABOUT A KEY. {@link ComposioBroker.isConnected} answers
       * that an account is attached, which for a key app is what the row's existence already said:
       * Composio takes a key when it is typed and never tests it again — the whole reason the probe
       * exists — so nothing in that answer bears on whether the key still works. Consent is the one
       * scheme where the vendor's yes IS the check, and it earns the flag above for that reason
       * alone. The evidence about a key is a call, and the two places that make one — {@link
       * connectBrokeredWithFields} and {@link recheckBrokeredConnection} — are the only writers of
       * this row's verdict. This one records what it learned by not writing.
       *
       * THE NEGATIVE HEAL IS UNTOUCHED, for all three kinds. A vendor answering NO still deletes the
       * row above, which is what a confirm on a key app is still worth running for.
       *
       * AND AN EXISTING ROW UNDER AN UNREADABLE SCHEME IS LEFT ALONE FOR A STRICTLY WIDER REASON.
       * For a key app the yes is not evidence; for an app whose scheme nothing here can read, it is
       * not known WHAT the yes is evidence of. Both answers are the same act — write nothing — and
       * it is the only act available that cannot claim more than was learned.
       */

      if (!existing) {
        await recordAuditEvent(auditStore, {
          eventType: "mcp.account_connected",
          targetType: "mcp_server",
          // The app, which is all a brokered connection is keyed on — the same id
          // `retireConnectionsFor` files its rows under, so one query answers what happened to one
          // person's access to one app however it ended.
          targetId: input.toolkit,
          payload: {
            actor: input.by,
            server: input.toolkit,
            scope: "",
            reconnected: false,
            holder: input.account.holder,
          },
        });
      }

      return { connected: true };
    },

    /**
     * Connect this person with the secret they typed, and write down everything except the secret.
     *
     * THE VALUES TRAVEL IN ONE DIRECTION AND THE WHOLE METHOD IS BUILT AROUND THAT. They arrive on
     * the request, they are handed to {@link ComposioBroker.connectWithFields}, and they reach
     * Composio. Nothing else here is given them: not the row, not the audit payload, not a log
     * line, not a thrown error — the broker's own doc comment is where that promise is kept on the
     * far side, and it is the one call in this tree that rethrows with no `cause` precisely because
     * the vendor's error object holds the key. Every other participant in this method is a
     * long-lived, widely-readable record, so a credential landing in one is not a leak somebody can
     * clean up afterwards; it is a leak with a retention schedule.
     *
     * THE SCHEME IS THE ONE RECORDED ON THE APP'S ROW, never a fresh read of the catalogue and
     * never a value a caller passed. It is what this deployment's authorization config was created
     * AS, and a connection is attached to that config: a second derivation is a second answer — a
     * key sent as `BASIC` against a config made for `API_KEY` — which is the reasoning {@link
     * ComposioBroker.connectionFields} gives for taking the scheme rather than resolving it, one
     * step earlier in the same flow.
     *
     * AND AN APP WHOSE SCHEME IS NOT A FIELD SCHEME IS REFUSED BEFORE THE KEY TRAVELS. A consent
     * app, a `NO_AUTH` app and an app this deployment could not resolve at all have no form and
     * nothing to attach typed values to, so sending them on would spend somebody's credential on a
     * config that cannot hold it — and would do it having already taken the secret out of the
     * request. {@link isFieldScheme} is asked rather than the string compared, for the reason it
     * exists: one list, read by the guard and by the type, so the schemes this admits cannot come
     * apart from the schemes the broker's signature takes.
     *
     * `connected` IS THE LITERAL `true` BECAUSE THERE IS NO OTHER WAY OUT OF HERE. Unlike {@link
     * confirmBrokeredConnection}, which asks a question the vendor may answer no to, this performs
     * an act: it either made the connection or it threw. A `boolean` would invite a caller to
     * branch on a `false` this method cannot produce.
     *
     * `probe` IS RETURNED BESIDE `verified` BECAUSE THE FLAG ALONE NOW MEANS THREE DIFFERENT THINGS,
     * AND THE BROWSER READS THIS FIELD TO CHOOSE ITS SENTENCE. While the row was written `false`
     * unconditionally the flag had one meaning — nobody has checked — and a screen could say so from
     * the flag alone. With a probe that can fail there are three states, and two of them share the
     * flag:
     *
     *   null probe, `verified: false`   — nothing was tried, so nothing is known about the key.
     *                                     Either this app publishes nothing safe to call, or the
     *                                     check could not be made — Composio unreachable, or an
     *                                     answer this deployment could not read. "It was accepted
     *                                     without being checked" is true of both, which is why
     *                                     they share the state; `checkable` on the listing is what
     *                                     tells the person whether pressing Re-check can ever help,
     *                                     and the trail carries the outage under `unreachable`.
     *   named probe, `verified: true`   — the action ran in this person's account and answered.
     *   named probe, `verified: false`  — it ran, the vendor said no, and the account could not be
     *                                     withdrawn. The key is BAD and the row exists anyway.
     *
     * That last one is the worst state this feature has, and under the old wording a person in it
     * would be told their key was never checked — when it was checked, the vendor rejected it, and
     * this deployment failed to undo the account it made. INFERRING THE STATE CLIENT-SIDE FROM
     * `verified` IS EXACTLY WHAT THIS FIELD EXISTS TO PREVENT: there is nothing in the flag that
     * separates "nothing to try" from "tried and failed", so a browser deriving a sentence from it
     * would tell one of those two people the opposite of what happened. The audit row carries the
     * same distinction under `action`, for a reader of the trail rather than of the screen.
     */
    async connectBrokeredWithFields(input: {
      toolkit: string;
      account: AccountRef;
      by: string;
      values: Record<string, string>;
    }): Promise<{ connected: true; verified: boolean; probe: string | null }> {
      // First, and for `confirmBrokeredConnection`'s reason: a deployment with no key has nobody to
      // connect anybody at, and the refusal must happen before the values are touched at all.
      if (!broker) throw new BrokerUnconfiguredError(brokerProvider, "person");

      // Keyed on the url and on the one row that answers for it — see `brokeredAppScheme`. It is
      // the same reasoning the connection gate in `connectionTokenFor` is keyed on, and for the
      // sharper version of the same stake: a row called `gmail` at `composio://slack` would have
      // somebody's Slack key attached to a scheme read off Gmail's row.
      /**
       * WHAT THIS CONNECT ANSWERS FOR EACH KIND OF APP, AND FOR EACH OUTCOME OF ITS OWN CHECK.
       *
       * Type-only and erased; see {@link Decides}. Two vocabularies meet in this one method — the
       * scheme decides whether it will run at all, and {@link BrokeredProbe} decides what the run
       * leaves behind — and each is read here by an equality test that a new member would sail
       * past. `isFieldScheme` is asked rather than {@link schemeKind}, so the two answers that are
       * not `key` reach one refusal by elimination; the roster is what says so out loud.
       */
      type _ConnectWithFieldsDecides = Decides<
        SchemeKind,
        {
          key: "connects, then checks the key it was just handed";
          consent: "refuses — not an app this deployment connects with values somebody types";
          none: "the same refusal — an app that needs no credential has nowhere to put one";
          unreadable: "the same refusal, reached by elimination rather than by decision";
        }
      >;
      type _ConnectWithFieldsRecords = Decides<
        BrokeredProbe["outcome"],
        {
          nothing: "the account stands, recorded unchecked with a null probe";
          answered: "the account stands, recorded verified under the probe's name";
          complained: "the account stands, recorded unchecked under the probe's name, and the press reports what the app said";
          unreachable: "the account stands, recorded unchecked, with the attempt on the trail";
        }
      >;
      const authScheme = await brokeredAppScheme(input.toolkit);
      if (!isFieldScheme(authScheme)) {
        throw new BrokerRefusalError(
          `${input.toolkit} is not an app this deployment connects with values somebody types, so nothing was sent. Open the app on the Plugins page and connect it the way it asks for; if it is not listed there at all, an administrator has to enable it first.`,
        );
      }

      const { accountId } = await broker.connectWithFields({
        account: input.account,
        toolkit: input.toolkit,
        authScheme,
        values: input.values,
      });

      /*
       * THE CHECK, WHICH IS THE SAME ONE A RE-CHECK MAKES AND IS SPELLED ONCE FOR THAT REASON.
       *
       * {@link probeBrokeredConnection} chooses the action out of what the app published — with the
       * version the listing recorded for it, which is part of what makes it choosable — calls it
       * with no arguments and reads what came back.
       * What belongs to THIS path and to no other is what happens next: an account this call has
       * just made, which a key the vendor rejects must not be allowed to leave standing. A re-check
       * runs the identical probe against an account that already existed and leaves it alone, and
       * those two undo behaviours are exactly why the shared part stops where it does.
       *
       * `probe: null` IS THE FIRST OF THE THREE STATES THIS METHOD REPORTS — the app published
       * nothing safe to call, or nothing at a version this deployment recorded, so the key was
       * never tried. It is an ordinary answer and not a failure; see that method.
       */
      const probed = await this.probeBrokeredConnection({
        toolkit: input.toolkit,
        account: input.account,
        /*
         * THE ACCOUNT THIS CALL JUST MADE, which is the only account this check is about. A person
         * and an app do not name one: Composio takes an account per key, somebody may hold several
         * for one app, and the vendor picks which a call runs in. So an unpinned probe verified a
         * key that does not work against the person's OTHER account — writing `verified` on the
         * strength of a call the new key never touched — and, the same defect pointing the other
         * way, condemned a perfectly good key and deleted the account it had just made because
         * some older account of theirs was broken. The undo below has always been keyed on this id;
         * this is what makes the check about the same account as the withdrawal.
         */
        accountId,
      });

      // Read before the write, for `confirmBrokeredConnection`'s reason: the record below is an
      // upsert, so it leaves nothing behind that tells a first key from a replacement, and whether
      // a row was already here is the whole of what `reconnected` says. The route that reaches
      // this today refuses a second account for the same app, which makes a constant `false`
      // accidentally true — but the guard lives in another file and this method is callable
      // without it, so the trail would be claiming, on that guard's word, something it never
      // checked.
      const existing = await this.brokeredConnection({
        toolkit: input.toolkit,
        account: input.account,
      });

      /*
       * THE CONNECT IS ON THE TRAIL BEFORE THE OUTCOME IS READ, AND THAT IS WHAT MOVING IT BUYS.
       *
       * The account exists by this line — `connectWithFields` above either made it or threw — and
       * from here the method has four ways out, one of which is the throw in the branch below.
       * Filed after that branch, this row was written on three of the four: a `complained` check
       * left a live account at Composio, a `composio_connections` row, and an
       * `mcp.connection_verified` row saying a check did not come back clean, with NOTHING saying
       * the account had ever been connected. `complained` is the ordinary outcome of a rate limit
       * or of one refused scope rather than an exotic one, so the trail lost the connect on the
       * path most likely to be walked — and the `mcp.account_disconnected` row filed when that
       * person later presses Disconnect had no counterpart to pair against.
       *
       * ABOVE `recordBrokeredConnection` RATHER THAN BELOW IT, because what this row asserts is
       * that the ACCOUNT was made, which the broker call above has already established, and not
       * that this deployment finished writing its own row about it. The two arms below disagree
       * about what that row says and agree about this.
       */
      await recordAuditEvent(auditStore, {
        eventType: "mcp.account_connected",
        targetType: "mcp_server",
        // The app, the same id `confirmBrokeredConnection` and `retireConnectionsFor` file under,
        // so one query answers what happened to one person's access to one app however it began
        // and however it ended.
        targetId: input.toolkit,
        payload: {
          actor: input.by,
          server: input.toolkit,
          /*
           * EMPTY, AND PRESENT, which is the whole of what this field does on a brokered row.
           *
           * All three writers of `mcp.account_connected` now agree on the key. {@link
           * recordConnection} carries what a vendor granted a `user-oauth` grant, and both brokered
           * writers carry `""` — a brokered connection has no scopes at all, because Composio holds
           * the grant and never tells this deployment what it covers.
           *
           * WRITING NOTHING IS NOT THE SAME AS WRITING THAT. This one wrote no key, so the same app
           * connected by two people came back as `''` from {@link confirmBrokeredConnection} and as
           * NULL from here, in a table whose entire purpose is being queried — and with nothing in
           * either row saying which writer made it, a reader cannot tell an absent scope from an
           * empty one, or either from a row written before the field existed.
           */
          scope: "",
          reconnected: existing !== null,
          holder: input.account.holder,
          /*
           * THE NAMES AND NEVER THE VALUES. What a reader of the trail needs is which app somebody
           * connected and what it asked them for; the values are the credential itself, and an
           * audit row is exactly the kind of long-lived, widely-readable record they must never
           * reach.
           */
          fields: Object.keys(input.values).sort(),
        },
      });

      if (probed.outcome === "complained") {
        /*
         * THE ACCOUNT THIS CALL MADE IS LEFT STANDING, AND THAT REVERSES WHAT THIS BRANCH USED TO DO.
         *
         * It read the outcome as "the vendor refused the key" and acted on it: `revokeAccount` on
         * the id just created, then a refusal telling the person what they entered did not work.
         * The premise was that nothing should be left behind on a key that does not work — which is
         * a good rule for the fact it names and was being applied to a fact nobody had established.
         * A complaint is Composio saying the CALL failed, out of an envelope with no status and no
         * error code in it (see {@link BrokeredProbe}), so a 429 on the identity read, a scope this
         * one action wants, or a 404 for a resource it names all arrived here as "your key is wrong"
         * and destroyed a connection that had just been made correctly.
         *
         * THE TWO MISTAKES DO NOT COST THE SAME, WHICH IS WHAT SETTLES IT. Keeping the account of a
         * genuinely bad key leaves a live row at Composio that can do nothing, that every screen
         * here draws as unverified with the app's own words beside it, and that Disconnect ends in
         * one press. Deleting the account of a good key costs the person the key itself: it is gone
         * from Composio, it was never stored here, and getting back is fetching it from the vendor
         * and typing it again. One is a press, the other is an errand — so the recoverable mistake
         * is the one this branch is willing to make.
         *
         * SO THE STATE THIS WRITES IS THE ONE THE `probe` FIELD WAS ADDED FOR, reached now by the
         * ordinary path rather than only by a failed undo: the row exists, it is unverified, it
         * names the action the check was spent on, and the sentence carries what the app said. What
         * it no longer carries is a verdict about the credential, here or on any screen that draws
         * it.
         */
        await this.recordBrokeredConnection({
          toolkit: input.toolkit,
          account: input.account,
          connectedBy: input.by,
          verified: false,
          // THE ACTION THAT WAS TRIED, which is the half of this state the flag cannot hold. It is
          // the whole of what separates this row on a later page load from a key nobody ever tried,
          // and it is the same name the audit row below carries under `action`, for a reader of the
          // trail rather than of a screen.
          probeAction: probed.probe,
        });

        /*
         * AND THE TRAIL SAYS SO TOO, WHICH IS THE HALF THE SENTENCE BELOW CANNOT REACH. The refusal
         * is told to one person in one moment; what outlives it is an unverified row and a live
         * account at the vendor, and the person who most needs to know both exist is an operator
         * reading this trail a week later. Filed BEFORE the throw for the only reason that matters
         * here: every way out of this branch is that throw, so a row written after it is a row
         * never written.
         *
         * `action` IS THE PROBE THAT WAS TRIED, and it is what tells this row from the unchecked
         * one. Both say `verified: false`; only the name separates "this app published nothing safe
         * to call" from "it ran and the app answered with a failure".
         */
        await recordAuditEvent(auditStore, {
          eventType: "mcp.connection_verified",
          targetType: "mcp_server",
          targetId: input.toolkit,
          payload: {
            actor: input.by,
            holder: input.account.holder,
            action: probed.probe,
            verified: false,
          },
        });

        /*
         * AND THE SENTENCE REPORTS RATHER THAN ACCUSES. It said "what you entered did not work",
         * which is the one thing this branch cannot know. What it can say is all true: a check was
         * spent, here is what the app answered, the account is still there, and here are the two
         * presses that end it either way.
         */
        throw new PluginRefusedError(
          `${input.toolkit} was connected, and the check this deployment then ran against it did not come back clean: ${probed.sentence} That may be the key, and it may be the app — what came back does not say which — so the account is left standing and recorded as unchecked. Re-check it on the Plugins page once, and if it still will not answer, disconnect it and connect it again with a fresh key.`,
          null,
        );
      }

      /*
       * ONE OUTCOME EARNS THE FLAG AND THE OTHER TWO REACHING HERE DO NOT, which is the whole of
       * what is decided below. A probe that ran and answered is evidence the key works, exactly as
       * the vendor's yes at the end of a consent screen is evidence for {@link
       * confirmBrokeredConnection}. An app that published nothing safe to call is the honest
       * unchecked state {@link composioConnections.verified} documents. And a vendor that could
       * not be reached is the SAME unchecked state, arrived at a different way — which is the one
       * thing a reader of this branch has to take away, so it is written out rather than left to
       * the union.
       *
       * AN OUTAGE IS AN ABSENCE OF EVIDENCE AND THE ROW HAS A STATE FOR THAT. It is not a fourth
       * thing to store: `probe_action` records the action a check SPENT, and a call that reached
       * nobody spent none, so null beside `verified: false` says exactly what is true — this key
       * has not been checked. What it must never become is the other `verified: false`, the one
       * with a name beside it, because that pair is the accusation "it ran and the vendor refused
       * your key" and the settings page draws it as such. {@link BrokeredProbe} withholds the name
       * from this outcome so the writer below cannot record it even by accident.
       *
       * AND THE ACCOUNT STAYS, which is the half the person would not get back. The undo above is
       * for a key the vendor REFUSED; a key nobody could ask about is very probably fine, and
       * deleting somebody's account because Composio was down destroys the thing they just made to
       * tell them something that was never established. The Re-check button is what settles it
       * afterwards — the app publishes an action, so the settings page offers one — and this is why
       * the connect answers rather than refusing: nothing went wrong with what they typed.
       *
       * Written through the single writer below rather than spelled here, so this path and the
       * confirm path cannot drift into two row shapes — `verified_at` follows from the flag there
       * and is not passed in.
       */
      const probe = probed.probe;
      const verified = probed.outcome === "answered";

      await this.recordBrokeredConnection({
        toolkit: input.toolkit,
        account: input.account,
        connectedBy: input.by,
        verified,
        // What was spent, which is the name on a probe that ran and the null that IS the first of
        // the three states: this app published nothing safe to try the key on. `verified` is
        // derived from this same value a few lines above, so the row cannot claim a check with an
        // action beside a flag that says nothing checked it, or the other way about.
        probeAction: probe,
      });

      /*
       * THE CHECK ITSELF, ON THE TRAIL, WHETHER OR NOT ONE HAPPENED.
       *
       * Filed on every connection rather than only where a probe ran, because "this app published
       * nothing safe to call, so the key was never tried" is the fact a reader most needs and the
       * one nothing else records. `action` is the null the response field is: it separates an
       * unchecked connection from a checked one, which `verified: false` alone cannot.
       *
       * THE FAILED UNDO ABOVE FILES THE SAME ROW BEFORE IT THROWS, so the worst state this feature
       * has — a live account, an unverified row, and a withdrawal the vendor refused — is no longer
       * named only in a sentence one person read once. The clean undo files nothing, and the reason
       * is written out at that branch: this trail records state that persists, and a row there
       * would cost the failed-undo row the one meaning that makes it worth reading.
       *
       * UNDER THE APP SLUG, which is the id `mcp.account_connected` above, {@link
       * confirmBrokeredConnection}, {@link disconnectBrokered} and {@link retireConnectionsFor} all
       * file under — so the two rows this method can write about one person's access to one app
       * come back in ONE query, however that access began and however it ended. This row was filed
       * under the SERVER row's id instead, on the reasoning that it is about an ACTION of a server
       * rather than about access; that is true and it cost the reader the only question anybody
       * asks this trail, which was answered half by one id and half by the other. Nothing goes with
       * the change: the server id is `composio-` and the slug, and the action is in the payload.
       *
       * AND THE OUTAGE IS NAMED HERE BECAUSE THE ROW CANNOT NAME IT. Two different things leave
       * this method with a null `action` — an app that publishes nothing safe to call, and a check
       * that could not be made — and on `composio_connections` they are one state, correctly: both
       * mean the key is unchecked, and neither says anything about the key. A reader of the TRAIL
       * is asking a different question, "was a check attempted and what became of it", and
       * `unreachable` is the whole of the difference, in Composio's own words. Present only on the
       * outage, so its absence is as informative as its value.
       *
       * AND CAPPED WHERE EVERY OTHER QUOTED FOREIGN STRING IN THIS FILE IS CAPPED, which this one
       * alone was not. `passableSentence` decides whether a candidate is worth repeating and says
       * nothing whatever about length; `askAction` then caps at `MAX_RESULT_CHARS`, which is 20_000
       * and is a bound written for a model's context window rather than for a row. So the sentence
       * arriving here can be fifty times what `refreshTools`' two `lastError` writes, the failed
       * undo's own reason a hundred lines up, and `callTool`'s two `failure` fields each allow
       * themselves — and `@composio/client` builds an `APIError` message out of an entire response
       * body, so a multi-kilobyte one is the ordinary arrival and not a contrived one.
       *
       * WHY THIS ROW AND NOT ANOTHER. `audit_events` is append-only by trigger, it is exported, and
       * it is kept for the deployment's whole retention window: a `lastError` written too long is
       * overwritten by the next refresh, and this is not. Whatever lands here cannot be cleaned up
       * afterwards, which makes the one uncapped write in the file the one that could least afford
       * to be.
       */
      await recordAuditEvent(auditStore, {
        eventType: "mcp.connection_verified",
        targetType: "mcp_server",
        targetId: input.toolkit,
        payload: {
          actor: input.by,
          holder: input.account.holder,
          action: probe,
          verified,
          ...(probed.outcome === "unreachable"
            ? { unreachable: probed.sentence.slice(0, 400) }
            : {}),
        },
      });

      return { connected: true, verified, probe };
    },

    /**
     * Try a key this deployment already holds, because somebody pressed the button that asks.
     *
     * A BUTTON, AND NEVER A PAGE-LOAD EFFECT. Composio never re-checks a key: it accepts one when it
     * is typed and says nothing about it again, so a row that was verified in March goes on saying
     * so after the key behind it was rotated, revoked or let expire. Nothing but this can correct
     * that — which is exactly the argument somebody will use for calling it from an effect when the
     * settings page mounts, and it is the wrong conclusion. The call this makes is spent against the
     * PERSON'S OWN rate limit at the vendor, on their account, so verifying on every render would
     * burn somebody's quota at Linear to redraw one word on a page they were only passing through.
     * {@link confirmBrokeredConnection} is the one that runs on mount, and it asks Composio a
     * question about its own records; this one goes out to the app.
     *
     * A RE-CHECK IS NOT A CONNECT, AND THE DIFFERENCE IS THE WHOLE METHOD. It runs against an
     * account that already exists: it must not create one, it must not withdraw one when the probe
     * fails — the person's account stays, it is their KEY that is wrong — and it must change
     * nothing here but the verification and its timestamp. {@link connectBrokeredWithFields} does
     * undo its account on a bad key, and it is right to: the account is a thing it had just made,
     * seconds earlier, for a key that turned out not to work. Here the account predates the press by
     * days, the person asked to have it CHECKED, and taking it away to tell them their key is wrong
     * would destroy the thing they are trying to repair. The shared probe stops short of both
     * behaviours for that reason.
     *
     * A PROBE THAT RAN AND FAILED RAISES, AND DOES NOT COME BACK AS `verified: false`. Those two
     * answers are not different spellings of one outcome. `false` is also what an app that publishes
     * nothing safe to call produces, and a row handed the flag alone cannot tell "the vendor
     * rejected your key" from "there was nothing here to try" — so it would draw the unchecked
     * sentence, and drop the Re-check button, for the one person who most needs it: somebody who has
     * just fixed their key and pressed it. The refusal carries Composio's own sentence, which is the
     * whole of what they can act on. The ONLY legitimate `verified: false` from here is the one that
     * arrives with `probe: null` saying there was nothing to check with.
     *
     * NOTHING TO PROBE WRITES NOTHING AT ALL, and answers with the row as it stands. A check that
     * could try nothing has learned nothing, and writing `false` on that would take the date off a
     * connection verified at a consent screen — a fact nothing else in this deployment records,
     * erased by a button that claims to check one. So the answer is what the row says after the
     * press, and `probe` is what says whether the press was able to try anything.
     *
     * THE ROW IS READ BEFORE THE VENDOR IS CALLED, and its absence is a refusal. The writer below is
     * an upsert, so a re-check that probed first and recorded the answer would INSERT a connection
     * for somebody who has none — the row that is the whole of the gate every later brokered call
     * passes through, created by a button that only asks a question. The probe itself would be spent
     * on an account the vendor does not hold, and would come back "no connected account found": this
     * deployment's own state, shown to somebody as though their key had been rejected.
     *
     * NO BROKER IS REFUSED BEFORE ANY OF IT, though nothing here calls the broker. The broker and the
     * transport are built from the same key, so a deployment without one has neither — and the probe
     * would come back as the transport's "Composio is not configured for this deployment", which
     * this method would otherwise report as the vendor rejecting a perfectly good key, and would
     * write the row unverified on the strength of it.
     *
     * AND A CONNECTION WITH NO KEY BEHIND IT IS REFUSED HERE RATHER THAN IN THE BROWSER. There is
     * nothing to re-check on a consent connection: the person authenticated at the vendor's own
     * screen, this deployment holds no credential of theirs, and the row's `verified_at` is the
     * date that screen earned — a fact nothing else here records. A probe spent on it would be a
     * call against their account that this method then reads as evidence about a key that does not
     * exist, and the likely failure would write `verified: false` with a null timestamp: a button
     * that claims to CHECK a connection, destroying the only record that one was ever checked. That
     * is precisely what the nothing-to-probe branch above is written to protect, and an app that
     * happens to publish a safe action walks straight past it. The screen does not offer the button
     * for a consent app, but a route takes POSTs and not only button presses, so the refusal
     * belongs where {@link connectBrokeredWithFields} puts its own: on the SCHEME RECORDED ON THE
     * APP'S ROW, asked through {@link isFieldScheme} so the schemes this admits cannot drift from
     * the schemes that have a key to admit.
     */
    async recheckBrokeredConnection(input: {
      toolkit: string;
      account: AccountRef;
      by: string;
    }): Promise<{
      verified: boolean;
      verifiedAt: string | null;
      probe: string | null;
    }> {
      if (!broker) throw new BrokerUnconfiguredError(brokerProvider, "person");

      // Keyed on the url and on the one row that answers for it — see `brokeredAppKind`. It is the
      // read `connectBrokeredWithFields`, `confirmBrokeredConnection` and `disconnectBrokered` all
      // make, for the same stake: a row called `gmail` at `composio://slack` would decide a Slack
      // re-check on Gmail's scheme. Anything but a key refuses, a scheme nothing here can read
      // included — there is no key recorded to re-check, and the sentence below is the same one
      // either way.
      /**
       * WHAT THIS RE-CHECK ANSWERS FOR EACH KIND OF APP, AND FOR EACH OUTCOME OF THE CHECK.
       *
       * Type-only and erased; see {@link Decides}. `!== "key"` is a boolean read of a three-member
       * vocabulary: it happens to fail closed for both of the other two today, which is why nothing
       * has gone wrong here yet and also why a fourth member would inherit that answer without
       * anybody choosing it. The probe roster below is the vocabulary this method reads FOUR ways,
       * and it is the one that has already been added to once.
       */
      type _RecheckDecides = Decides<
        SchemeKind,
        {
          key: "spends a call against the key this deployment holds";
          consent: "refuses — there is no key here to re-check";
          none: "the same refusal — there is no account, let alone a key, to check";
          unreadable: "the same refusal, which is the closed direction";
        }
      >;
      type _RecheckRecords = Decides<
        BrokeredProbe["outcome"],
        {
          nothing: "writes nothing and files nothing; answers the held row beside a null probe";
          answered: "records verified under the probe's name, and files the check";
          complained: "records unchecked under the probe's name, files the check, then reports what the app said";
          unreachable: "writes nothing and files nothing; refuses with Composio's own sentence";
        }
      >;
      if ((await brokeredAppKind(input.toolkit)) !== "key") {
        throw new PluginRefusedError(
          `${input.toolkit} is not an app this deployment holds a key for, so there is nothing here to re-check. It was connected at ${input.toolkit}'s own sign-in screen, and if it has stopped working, disconnecting it on the Plugins page and connecting it again is what fixes it.`,
          null,
        );
      }

      const [held] = await database
        .select({
          verified: brokeredConnections.verified,
          verifiedAt: brokeredConnections.verifiedAt,
        })
        .from(brokeredConnections)
        .where(accountRow(input.toolkit, input.account))
        .limit(1);

      if (!held) {
        throw new PluginRefusedError(
          `You have no connection to ${input.toolkit} here, so there is nothing to re-check. Connect it on the Plugins page and it will be checked as it is made.`,
          null,
        );
      }

      const probed = await this.probeBrokeredConnection({
        toolkit: input.toolkit,
        account: input.account,
      });

      /*
       * THE VENDOR WAS NOT REACHED, SO THE RECORD OF THE LAST CHECK IS LEFT EXACTLY WHERE IT IS.
       *
       * This is the branch the whole four-state reading exists for on this path. A failed probe
       * used to mean one thing here — "the vendor rejected the key it is holding" — so an outage,
       * a socket that closed, or a `@composio/core` that could not parse an answer cleared
       * `verified`, dropped `verified_at` (the only record anywhere that this connection was ever
       * checked, and the date the page prints) and wrote the named probe beside the `false`, which
       * is the accusation. Every person who pressed the button while Composio was down was told
       * their key had been refused, over a row that had been verified minutes earlier.
       *
       * NOTHING IS WRITTEN, WHICH IS STRONGER THAN WRITING SOMETHING HONEST. A press that learned
       * nothing may not move a record: there is no state for "we could not ask" on the row, and
       * there should not be — the row says what is known about the key, and an outage changes
       * nothing about that. It is the same restraint as the nothing-to-probe branch below, and
       * nothing is filed on the trail for the same reason it gives.
       *
       * AND IT RAISES RATHER THAN ANSWERING, which is where it parts from that branch. Somebody
       * pressed a button and is owed the truth about what happened to their press: the check did
       * not happen, and here is Composio's own sentence about why. Answering with the held row
       * instead would report the state as though the press had confirmed it.
       */
      if (probed.outcome === "unreachable") {
        throw new PluginRefusedError(
          `${input.toolkit} could not be checked just now: ${probed.sentence} Nothing here changed — your connection is still recorded exactly as the last check left it — so pressing Re-check again when ${BROKERED_PROFILE[brokerProvider].vendor} is answering is the whole of the retry.`,
          null,
        );
      }

      /*
       * NOTHING WAS TRIED, SO NOTHING IS WRITTEN AND NOTHING IS FILED. The row keeps whatever it
       * held — a consent verification and its date, or the honest unchecked pair — and the answer
       * reports that state beside the null probe that says why this press could not improve on it.
       * `mcp.connection_verified` records an account exercised with a REAL CALL; a row filed here
       * would make the one event that means "a key was tried" also mean "somebody pressed a button".
       */
      if (probed.outcome === "nothing") {
        return {
          verified: held.verified,
          verifiedAt: iso(held.verifiedAt),
          probe: null,
        };
      }

      // What the press spent, which from here on is a name: both outcomes left are a call that ran
      // and a vendor that answered about it.
      const probe = probed.probe;

      /*
       * THE ANSWER IS WRITTEN FOR BOTH OUTCOMES, and through the single writer for its reason: the
       * flag and its timestamp are one set, and a second hand spelling that set is how one of them
       * comes to leave a date standing on a claim nobody is making any more. A key the vendor has
       * just rejected stops being verified HERE — that is the state this button exists to correct,
       * in the direction nothing else in the product can move it.
       */
      const verified = probed.outcome === "answered";
      const { verifiedAt, wrote } = await this.recordBrokeredConnection({
        toolkit: input.toolkit,
        account: input.account,
        verified,
        // The action this press spent. Never null on this path: the nothing-to-probe branch above
        // returns before reaching the writer, precisely so that a check which could try nothing
        // writes nothing at all.
        probeAction: probe,
        /*
         * AND IT MAY NOT CREATE THE CONNECTION IT IS RECORDING A CHECK OF. The read at the top of
         * this method refuses a person with no row, deliberately, because this writer is an upsert —
         * but that read and this write straddle the vendor call above, which is live and takes
         * seconds. A Disconnect landing in that window revoked the grant at Composio and deleted the
         * row, and this upsert then put the row back: `composio_connections` is the whole of the
         * permission a brokered call is decided on, so the re-insert restored access to an account
         * the person had just ended, and drew the app as connected again.
         */
        only: "a row that is still there",
      });

      /*
       * THE ROW WENT WHILE COMPOSIO WAS BEING ASKED, SO NOTHING IS RECORDED AND NOTHING IS FILED.
       *
       * The two ways here are a Disconnect in another tab and a concurrent confirm that Composio
       * answered `false` for and which deleted the row. Both are somebody or something ENDING this
       * connection, and a verification row filed afterwards would be the trail recording a check of
       * an account that no longer exists — beside `mcp.account_disconnected` for the same app, in
       * whichever order the two happened to land.
       *
       * AND IT SAYS SO RATHER THAN ANSWERING QUIETLY, for the reason the outage branch above does:
       * somebody pressed a button and is owed the truth about their press. The answer is not the
       * probe's verdict, because the thing it was a verdict about is gone.
       */
      if (!wrote) {
        throw new PluginRefusedError(
          `Your connection to ${input.toolkit} was disconnected while this check was still running, so nothing was recorded about it: what the check found is about an account you no longer have here. Connect ${input.toolkit} again on the Plugins page if that was not what you meant.`,
          null,
        );
      }

      /*
       * AND THE TRAIL CARRIES THE CHECK, whichever way it went, filed BEFORE the refusal below for
       * the reason the connect path files its own row before its throw: every way out of a failure
       * is that throw, so a row written after it is a row never written. `action` is the probe that
       * ran, which is what separates this from a connection nothing was ever tried on.
       *
       * FILED UNDER THE APP'S BARE SLUG, as every row in this family is — the same id
       * `confirmBrokeredConnection`, `connectBrokeredWithFields` and `retireConnectionsFor` file
       * under — so one query still answers what happened to one person's access to one app.
       *
       * THE ROW NAMES A PERSON AND NO BOT, because none ran: this is somebody checking their own
       * account. See `mcp.connection_verified` in `./audit`, whose safety argument names a person
       * re-checking their own connection as one of the two callers this call may ever have.
       */
      await recordAuditEvent(auditStore, {
        eventType: "mcp.connection_verified",
        targetType: "mcp_server",
        targetId: input.toolkit,
        payload: {
          actor: input.by,
          holder: input.account.holder,
          action: probe,
          verified,
        },
      });

      if (probed.outcome === "complained") {
        /*
         * THE APP'S OWN SENTENCE, AND THE TWO FACTS AROUND IT: the row here now says unchecked, and
         * their account was left exactly as it was. The second half is what makes the retry one step
         * rather than three — there is nothing to disconnect and nothing to reconnect, only this
         * button to press again once whatever the sentence names has passed.
         *
         * AND IT REPORTS WHAT CAME BACK RATHER THAN RULING ON THE KEY. This said "would not answer
         * with the key it is holding", which reads as the vendor having rejected the credential —
         * and the envelope the outcome is decided from carries no status and no error code, so a
         * rate limit and a bad key are the same answer here. See {@link BrokeredProbe}. Moving the
         * row to unchecked is still right and is still the thing this button exists to do: whatever
         * the failure was, the check did not come back clean, so a standing `verified: true` is no
         * longer supported and must not keep standing.
         */
        throw new PluginRefusedError(
          `The check this deployment ran against ${input.toolkit} did not come back clean: ${probed.sentence} That may be the key and it may be the app — what came back does not say which — so your connection here is recorded as unchecked until a check does come back clean. Nothing was disconnected: press Re-check again in a few minutes, and fix the key at ${input.toolkit} if it keeps answering the same way.`,
          null,
        );
      }

      return { verified: true, verifiedAt: iso(verifiedAt), probe };
    },

    /**
     * End this person's brokered account at the vendor, and then forget where it was.
     *
     * REVOKE BEFORE DELETE, AND THAT ORDER IS THE WHOLE METHOD. The row is the only thing in this
     * deployment that says which app this person connected: the app is read off
     * `composio_connections`, and a revoke needs it. Delete first and a revoke that then fails
     * leaves a live grant on somebody's mailbox that no operation here can reach, because the one
     * value it would have to be revoked under is gone. The other order costs nothing by
     * comparison — a revoke that throws leaves the row standing, the person presses disconnect
     * again, and the second attempt has everything the first one had.
     *
     * WHICH ALSO MEANS THE FAILURE IS LOUD. Nothing is caught here: a broker that will not answer
     * ends this call, and no row and no trail entry claims an account was disconnected when the
     * account is still live.
     *
     * `vendorRevocationRequested` IS WHAT WAS ASKED FOR, NOT THAT A CALL WAS MADE — {@link
     * ComposioBroker.revoke}'s own answer, passed through. True where an account was found and its
     * withdrawal asked for, false where there was none to withdraw, and the value of the field is
     * exactly that a reader can tell an account this deployment acted on from one that outlives it
     * somewhere else.
     *
     * IT SAYS "REQUESTED" BECAUSE THE VENDOR'S ANSWER SUPPORTS NOTHING STRONGER, and the field was
     * renamed from `vendorRevoked` when that turned out to be false in the plainest way: the
     * adapter behind it was soft-deleting the account and asking for no upstream revocation at all,
     * so every row saying a grant had been withdrawn described one still live at Google. The ask is
     * now made; what a broker can promise synchronously is that the account is gone at Composio and
     * that the provider has been asked, because the withdrawal itself runs as a background job with
     * no supported way to poll it.
     *
     * EXCEPT WHERE THE APP IS ONE SOMEBODY TYPED A KEY INTO, AND THERE IT IS FALSE BY CONSTRUCTION
     * RATHER THAN BY WHAT THE VENDOR FOUND. `revoke_on_delete` asks the PROVIDER to end a grant,
     * which is a real request for a consent account — Google or Slack acts on it — and a
     * meaningless one for an API key. There is no grant behind a key to withdraw: the value is
     * still valid at the app and still works for anyone holding it, so the account ends at Composio
     * and nothing was asked of anybody else. Saying otherwise would be the one row in this trail
     * nobody could rely on, which is the failure the paragraph above describes arriving a second
     * time by a different road — a withdrawal recorded for something that was never granted. So the
     * scheme recorded on the app's row decides this field for a field connection, and the broker's
     * own answer decides it for every other.
     *
     * THE SCHEME IS THE ONE ON THE APP'S ROW, for {@link connectBrokeredWithFields}' reason: it is
     * what this deployment's authorization config was created AS and what the account was attached
     * to, and a fresh read of the catalogue is a second answer — a key connection described as
     * consent because the vendor has since started publishing managed OAuth for the app. The
     * person's half of this fact is already written on the disconnect row they are shown: their key
     * still works at the app, and rotating it there is what ends it. This is the trail's half of
     * the same sentence.
     *
     * THE VENDOR IS ASKED WHETHER OR NOT A ROW IS HERE. The row is a cache of Composio's answer
     * and never the account itself (see {@link brokeredConnection}), so its absence is not
     * evidence that the grant is gone: the confirm above deletes it on any `false` from the
     * vendor, and a person whose row was cleared that way can still be holding a live account at
     * Composio with nothing left here pointing at it. Asking anyway is the only operation in this
     * deployment that can end such a grant, and it costs nothing where there is genuinely nothing
     * to withdraw — the broker answers `false` and says so. Skipping the revoke for want of a
     * local row would make the safe half of disconnect unreachable for exactly the person who
     * needs it, on the strength of a cache we already know drifts.
     *
     * BUT THE TRAIL RECORDS ONLY A DISCONNECT THAT HAPPENED. The event is filed where something
     * actually ended — a row deleted here, or a grant withdrawn at the vendor — and not otherwise.
     * A call that found no row and withdrew no grant disconnected nothing, and an
     * `mcp.account_disconnected` row for it tells whoever reads the trail that somebody's account
     * ended at a moment when nobody's did. It is the criterion
     * {@link confirmBrokeredConnection} files its own event under, one act the other way round:
     * the trail records acts, and a call that changed nothing performed none.
     *
     * WHICH IS NOT THE SAME QUESTION AS `vendorRevocationRequested`. A row here with no grant at
     * the vendor is a disconnect — the gate this deployment decides every brokered call on was
     * open, and this call closed it — so the event is filed, saying
     * `vendorRevocationRequested: false`. A grant at the vendor
     * with no row here is a disconnect too, and the weightier of the two, because somebody's live
     * account was ended; the event is filed for that as well. Only where both are absent is there
     * no act to record, and the two cases stay legible in the trail because the field still says
     * which of them happened.
     *
     * SO THE FILING IS DECIDED ON THE BROKER'S OWN ANSWER AND NOT ON THE FIELD, because for a field
     * connection the two part company on purpose. A key account the vendor found and ended with no
     * row here is an act — somebody's live connection stopped existing — and gating the event on a
     * value that is false by construction would leave exactly that act unrecorded. The field
     * answers what was asked of the provider; `ended` answers whether anything was there.
     */
    async disconnectBrokered(input: {
      toolkit: string;
      /** Whose account ends — a person's own, or the one the deployment holds for a Shared app. */
      account: AccountRef;
      by: string;
      /**
       * Why the account ended, which is a closed set and not free text. A brokered account ends
       * in exactly four ways — the person disconnecting their own; the person being removed from
       * the People screen, which is the word {@link retireConnectionsFor} already files its own
       * rows under; an administrator disconnecting the deployment's account for a Shared app; and
       * the app being switched between Personal and Shared, which retires the accounts the old
       * mode held. A reader asking the trail which of them happened can be answered only if it is
       * the same word every time, so the type is the set rather than whatever sentence a caller
       * happened to spell.
       */
      reason: "self" | "person_removed" | "admin" | "mode_switched";
    }): Promise<{ vendorRevocationRequested: boolean }> {
      if (!broker) throw new BrokerUnconfiguredError(brokerProvider, "person");

      /*
       * Keyed on the url and on the one row that answers for it — see {@link brokeredAppKind}.
       * It is the read {@link connectBrokeredWithFields} makes, for the same stake: a row called
       * `gmail` at `composio://slack` would have this disconnect reading Gmail's scheme to describe
       * what happened to a Slack account.
       *
       * AN APP WITH NO ROW HERE IS NOT A FIELD APP, AND NEITHER IS ONE WHOSE SCHEME CANNOT BE READ.
       * A person can hold an account at Composio for an app this deployment has since removed — the
       * row is a cache and the removal takes no grant with it — and the revoke below is the one
       * operation that can still end it. Nothing names the scheme it was connected under any more,
       * so the honest reading is the broker's own answer, which is what both of those fall through
       * to: the field below is a claim that this deployment asked the vendor to withdraw something,
       * and an app it cannot say holds a key is one whose withdrawal it has to report as asked.
       */
      /**
       * WHAT THIS DISCONNECT CLAIMS ON THE TRAIL FOR THE ASKED APP, BY KIND. What it does about a
       * SIBLING of each kind is a different decision and is written down where it is made — see
       * rule 1 on {@link clearEndedSiblings}, which for a key DELETES NOTHING AND CLAIMS NOTHING
       * rather than claiming no revocation about a row it removed.
       *
       * Type-only and erased; see {@link Decides}. `=== "key"` collapses three answers into two,
       * and the collapse is deliberate here rather than accidental: the field below is a claim that
       * this deployment asked the VENDOR to withdraw something, and an app it cannot say holds a key
       * is one whose withdrawal it has to report as asked. That is a decision about `unreadable`,
       * and this roster is where it is written down as one.
       */
      type _DisconnectDecides = Decides<
        SchemeKind,
        {
          key: "claims no vendor revocation — nothing at the vendor holds this key";
          consent: "reports the vendor's own withdrawal as asked for";
          none: "reports whatever the vendor says it ended, which for an app with no account is nothing";
          unreadable: "reports it as asked for too, which is the claim that cannot be too weak";
        }
      >;
      /*
       * THE APPS THIS REVOCATION ENDS BESIDES THE ONE ASKED ABOUT, read BEFORE anything is revoked.
       * Where a connection is keyed `(identity, auth provider)` — Arcade — withdrawing one app's
       * connection ends every app that shares it, so a local row left for one of them claims an
       * account the vendor no longer holds, which is the other way to lie. Where each app is its
       * own auth provider — Composio — this is always empty and nothing below differs from a
       * disconnect of one. The question is {@link resolveSiblings}' and none of it is derived here.
       */
      const { siblings, unanswered } = await resolveSiblings({
        toolkit: input.toolkit,
        account: input.account,
      });

      /*
       * WHETHER THE ASKED APP IS ONE THIS DEPLOYMENT HOLDS A KEY FOR, which decides WHAT THE TRAIL
       * CLAIMS about it and nothing else. Its row goes either way: the person pressed Disconnect on
       * THIS app, the row is the whole of what Disconnect works off, and leaving it would be
       * refusing the act. The siblings are the opposite question — nobody asked about them — and
       * {@link clearEndedSiblings} answers it, rule 1 included.
       *
       * This was one `keyApps` set spanning the asked app and its siblings, and the set only ever
       * weakened the trail claim: a KEY sibling's row was deleted anyway, by the single OAuth
       * revoke that never ended it, leaving a live account at the vendor with no local row to
       * reach it.
       *
       * The claim is {@link vendorRevocationClaim}'s, which {@link removeServer} and
       * {@link retireConnectionsFor} make for their own asked apps: this method was the one of the
       * three that said `false` for a key, and now none of them says it for itself.
       */
      const claim = await vendorRevocationClaim(input.toolkit);

      // Whether there was an account to end at all, which is what decides if anybody was
      // disconnected. Named apart from the field below because for a key the two differ: something
      // ended, and nothing was asked of the provider.
      //
      // REVOKE BEFORE ANY LOCAL DELETE, and ONE ask: it ends the siblings with it. It THROWS on a
      // partial ask, which is the partial failure — the throw leaves this method before a single
      // row is deleted or written, every app's row standing, so pressing Disconnect again is the
      // recovery.
      const ended = await broker.revoke({
        account: input.account,
        toolkit: input.toolkit,
      });

      const asked = claim(ended);

      /*
       * THE ASKED APP FIRST, and on its own terms — this is the act, not a cascade of it.
       *
       * `deleted || ended` RATHER THAN RULE 3, deliberately and only here: a disconnect of an app
       * whose row this deployment never held is still a withdrawal the vendor made, and the trail
       * has to carry it. A SIBLING has no such act of its own to record, which is why
       * {@link clearEndedSiblings} files nothing without a row.
       *
       * `returning` because whether a row was here is half of what decides if anybody was
       * disconnected, and a delete that answered nothing would leave the two cases
       * indistinguishable.
       */
      const [deleted] = await database
        .delete(brokeredConnections)
        .where(accountRow(input.toolkit, input.account))
        .returning({ app: brokeredConnections.app });

      if (deleted || ended) {
        await recordAuditEvent(auditStore, {
          eventType: "mcp.account_disconnected",
          targetType: "mcp_server",
          targetId: input.toolkit,
          payload: {
            actor: input.by,
            server: input.toolkit,
            // Whose account this was, which is not always who ended it: an administrator
            // offboarding somebody and a person disconnecting themselves write the same shape of
            // row, and only these two fields tell them apart. The deployment's own account has
            // no person behind it, so it is named as the deployment rather than as whoever
            // pressed.
            owner:
              input.account.holder === "person"
                ? input.account.userId
                : "deployment",
            reason: input.reason,
            ...asked,
            /*
             * HOW MANY apps on this identity could not be asked about and so were left out of
             * the set below, never their names. An integer, so an operator can see that "we did
             * not know" happened; see {@link resolveSiblings}.
             */
            unansweredSiblings: unanswered,
          },
        });
      }

      // Then the apps that went with it, each naming the disconnect that ended it, by the three
      // rules that are written down once; see {@link clearEndedSiblings}.
      await clearEndedSiblings({
        siblings,
        account: input.account,
        endedWith: input.toolkit,
        revoked: ended,
        unanswered,
        by: input.by,
        reason: input.reason,
      });

      return asked;
    },

    /**
     * THE LOCAL SIDE OF A WITHDRAWAL SOMEBODY ELSE ALREADY MADE AT THE VENDOR: the rows this
     * deployment holds for an account a revoke has just ended, and the trail that says why they
     * went.
     *
     * WHO THIS IS FOR. The verifier refuses a consent whose context moved on and withdraws the
     * RETIRED identity's app at the vendor — a revoke it issues itself, outside this store,
     * because the decision is the route's and the attempt row is what records it. On Arcade that
     * one revoke ends the whole `(identity, auth provider)` connection and so every app sharing
     * it, and the rows here for those apps would otherwise be left standing: this deployment's own
     * records claiming live connections for apps the vendor has already disconnected. A person
     * then sees apps listed as connected that fail on first use, and nothing tells them otherwise.
     * This is the write that stops that, and it is a STORE method rather than route code for the
     * reason every other row write is: `brokered_connections` and the trail are this file's.
     *
     * IT ASKS NOTHING OF ANY VENDOR AND DECIDES NOTHING BUT WHAT A LOCAL ROW SAYS. The caller
     * resolved the siblings — of
     * {@link siblingApps}, BEFORE its revoke went out, which is the ordering {@link
     * disconnectBrokered} and {@link removeServer} both keep — and the caller watched its revoke
     * ANSWER TRUE. Called on anything less, it would be claiming an account gone on the strength
     * of an answer nobody got; that rule is {@link removeServer}'s and this one is its other half.
     *
     * ONLY A ROW THAT WAS ACTUALLY HERE GETS A TRAIL ROW, which is again {@link removeServer}'s
     * rule. The act itself is already recorded — on the attempt row, as `withdrawn` — so these
     * rows exist to explain why an app's connection VANISHED from this deployment's records, and
     * an app that had no row here had nothing to explain.
     *
     * THAT RULE AND THE TWO BESIDE IT NOW LIVE IN {@link clearEndedSiblings}, which this method
     * hands its siblings to and which {@link disconnectBrokered} and {@link removeServer} hand
     * their own to. They were spelled three times and the spellings disagreed about every one of
     * them.
     *
     * `reason` IS ONE WORD AND IT IS THIS ONE. "The consent's context moved on" is not any of the
     * four {@link disconnectBrokered} takes — nobody disconnected anything, nobody was offboarded,
     * and a mode switch is only one of the several ways the context can move — so the trail gets
     * its own word rather than the nearest-looking lie. Fixed in the type so there is no second
     * caller spelling it differently.
     */
    async clearWithdrawnAccount(input: {
      toolkit: string;
      account: AccountRef;
      /** The apps the caller's revoke ended besides `toolkit`; {@link siblingApps} answers it. */
      siblings: string[];
      /**
       * How many apps on this identity could not be asked about, an integer and never names, which
       * qualifies the `endedWith` claim and goes beside it and nowhere else; see
       * {@link resolveSiblings}.
       */
      unanswered: number;
      by: string;
      reason: "context_changed";
    }): Promise<{ cleared: string[] }> {
      const cleared: string[] = [];
      /*
       * THE ASKED APP FIRST, then the apps that went with it, so the trail reads in the order the
       * withdrawal happened. The asked app's own row names no other app beside it — it was ended
       * by its own ask — and a sibling's names the app that asked, which is the only thing that
       * tells a reader why a connection they never touched is gone.
       *
       * THE ASKED APP TAKES THE SAME THREE RULES, which is this method's whole difference from
       * {@link disconnectBrokered}'s asked app and is right for the same reason the rules are:
       * nobody here pressed anything about this app either. A caller's revoke ended an OAuth
       * connection for a RETIRED identity, so an app this deployment holds a key for was not in
       * it (rule 1); the caller watched that revoke answer true, which is the contract above and
       * is rule 2 discharged at the door; and a row that was not here had nothing to explain
       * (rule 3). The act itself is already recorded on the attempt row, as `withdrawn`.
       *
       * Rule 1 is asked of {@link consentRevokeReaches}, its one spelling, rather than of the kind
       * directly — this was the one site that compared the kind for itself (round 2, K5).
       */
      if (await consentRevokeReaches(input.toolkit)) {
        const [deleted] = await database
          .delete(brokeredConnections)
          .where(accountRow(input.toolkit, input.account))
          .returning({ app: brokeredConnections.app });
        if (deleted) {
          cleared.push(input.toolkit);
          await recordAuditEvent(auditStore, {
            eventType: "mcp.account_disconnected",
            targetType: "mcp_server",
            targetId: input.toolkit,
            payload: {
              actor: input.by,
              server: input.toolkit,
              owner:
                input.account.holder === "person"
                  ? input.account.userId
                  : "deployment",
              reason: input.reason,
              /*
               * TRUE FOR EVERY ROW HERE, AND IT IS NOT A GUESS: this method is reached only from a
               * revoke that answered true, and on Arcade that ask ended the siblings with the app
               * it named. `vendorRevocationRequested: false` means "no vendor was asked", which is
               * the one thing none of these rows may say.
               */
              vendorRevocationRequested: true,
            },
          });
        }
      }

      cleared.push(
        ...(await clearEndedSiblings({
          siblings: input.siblings,
          account: input.account,
          endedWith: input.toolkit,
          // The contract above: the caller watched its revoke answer true before calling this.
          revoked: true,
          unanswered: input.unanswered,
          by: input.by,
          reason: input.reason,
        })),
      );
      return { cleared };
    },

    /**
     * Retire every connector credential belonging to one person.
     *
     * WHAT THIS IS FOR. "We removed their access" has to be true of the thing that matters, which is
     * the refresh token sitting at the vendor. Removing somebody from the People screen used to end
     * their sessions and add them to the deny list, and leave their Google grant entirely intact in
     * this deployment's vault. They could not exercise it — the actor comes from a session they no
     * longer get — but the deployment still held a usable secret for a person who had been removed,
     * which is not what an administrator was told they did, and is the first thing a customer asks
     * about a per-person connector.
     *
     * LOOKED UP IN THE VAULT, NOT THROUGH THE JOIN TABLE. `mcp_user_credentials.user_id` cascades on
     * a user row being deleted, so by the time somebody is gone the join row can be gone too and the
     * credential is orphaned: unrevoked, referenced by nothing, reachable from no screen and by no
     * code path. `credentials.key_id` holds the user id for an `mcp_user_token`, so the vault can
     * still be asked directly — which makes this work for the person who was removed and for the one
     * whose row was deleted underneath it.
     *
     * The join rows go too, so the account pages stop claiming a connection this deployment can no
     * longer use.
     *
     * AND THE BROKERED CONNECTIONS, which are neither a credential nor a join row. Composio holds
     * the account, so there is no secret in the vault to find and the person's `brokered_connections`
     * row is itself the permission — the only thing deciding whether a call may go out as this person.
     * Sweeping the vault alone therefore left that gate passing for somebody who had been removed.
     *
     * NOT VENDOR-SIDE REVOCATION FOR THE VAULT HALF. That needs the OAuth client and the vendor's
     * revoke endpoint, and it belongs with disconnect. Those rows are the half that stops us
     * holding the secret; the grant at Google outlives it until somebody revokes it there. Said
     * plainly rather than implied, because the difference matters to whoever has to answer for it.
     *
     * THE BROKERED HALF DOES END IT AT THE VENDOR, because there is no secret of ours to stop
     * holding: clearing the row alone would shut the gate this deployment owns and leave the
     * mailbox attached at Composio, which is "we removed their access" being untrue of the only
     * thing that matters, for the person it matters most about. So every app this person connected
     * is revoked through the broker, exactly as {@link disconnectBrokered} revokes for one and
     * {@link removeServer} for a whole app.
     *
     * REVOKE BEFORE DELETE, ALWAYS. The row is the only thing that names which apps this person
     * had, and it outlives the `users` row precisely so offboarding can still find them — which
     * was the table's whole justification and until now was theoretical. A delete that ran first
     * would leave a failed revoke with nothing to revoke under: a live grant on a departed
     * person's mailbox that no operation in this deployment can reach. The other order costs a
     * repeat of an act nobody minds repeating. Nothing is caught around the revokes either, so a
     * broker that will not answer ends this method with the rows still standing rather than
     * letting it report an ending that did not happen.
     */
    async retireConnectionsFor(
      userId: string,
      by: string,
    ): Promise<{ retired: number }> {
      if (!userId) return { retired: 0 };

      const owned = await database
        .select({
          id: credentialRows.id,
          provider: credentialRows.provider,
          revokedAt: credentialRows.revokedAt,
        })
        .from(credentialRows)
        .where(
          and(
            eq(credentialRows.kind, "mcp_user_token"),
            eq(credentialRows.keyId, userId),
          ),
        );

      let retired = 0;
      for (const credential of owned) {
        // Already revoked is not a failure. Retiring twice is something an administrator can
        // legitimately do, and the second time should be quiet rather than an error.
        if (credential.revokedAt) continue;
        await credentials.revoke(credential.id);
        retired += 1;
        await recordAuditEvent(auditStore, {
          eventType: "mcp.account_disconnected",
          targetType: "mcp_server",
          targetId: credential.provider,
          payload: {
            actor: by,
            server: credential.provider,
            owner: userId,
            /*
             * Why, because the two reasons are not the same event to a reader. Somebody disconnecting
             * their own account is a person changing their mind; an administrator removing somebody
             * is an offboarding, and an auditor asking "what happened to their access" wants to see
             * which one this was.
             */
            reason: "person_removed",
            vendorRevocationRequested: false,
          },
        });
      }

      await database
        .delete(mcpUserCredentials)
        .where(eq(mcpUserCredentials.userId, userId));

      /*
       * Every app this person connected at the broker, where there is no secret to scan the vault
       * for.
       *
       * CRITERION. After this returns, no brokered call may go out on this person's behalf.
       *
       * REASON. A brokered connection is not a credential: Composio holds the account and this
       * deployment sends a user id, so the vault sweep above finds nothing and the person's
       * `brokered_connections` row is the entire gate. Reading only the vault therefore retired nothing for somebody whose only
       * connector was brokered, reported that as a retirement, and left the `(toolkit, user_id)` gate
       * passing for a person who no longer exists — their access outliving them, which is the first
       * thing anybody asks about a per-person connector. The table's own docblock justifies its shape
       * by this path, so the shape was carrying a promise nothing kept.
       *
       * FOUND HERE AND NOWHERE ELSE, which is what the missing foreign key buys. The row survives the
       * `users` row precisely so this can still name what the person had after they are gone — the
       * same argument the vault lookup above makes, from the side that has no vault row. It is also
       * why the guard at the top of this method is load-bearing rather than defensive: `not null`
       * admits the empty string, so a row at `(toolkit, "")` is legal, and retiring "nobody" must not
       * be what deletes it.
       *
       * COUNTED, because the number is what "we removed their access" claims. Retiring twice stays
       * quiet on its own: the rows are gone, so the second call finds none.
       *
       * READ BEFORE ANYTHING IS DELETED, because the revokes below need the apps and the rows are
       * where the apps are — the reason the docblock gives for revoking first. Sorted, so two
       * retirements of the same person revoke in the same order and write their rows in the same
       * order.
       */
      /*
       * NO PROVIDER PREDICATE HERE, DELIBERATELY, AND THAT IS NOT AN OVERSIGHT. The sweep below
       * revokes through the ACTIVE broker, so a row filed under another provider would be a
       * revocation requested at the wrong vendor, which would not recognise the connection, and an
       * audit row claiming `vendorRevocationRequested` about access that was never removed. What
       * keeps that unreachable is the startup activation refusal (`assertActivatable`, called from
       * `server/src/index.ts`): a deployment holding both providers' rows cannot boot. No flow relaxes
       * that refusal today; whoever builds one must add the `brokerProvider` predicate here.
       */
      const brokered = await database
        .select({ toolkit: brokeredConnections.app })
        .from(brokeredConnections)
        .where(
          and(
            eq(brokeredConnections.holder, "person"),
            eq(brokeredConnections.userId, userId),
          ),
        )
        .orderBy(asc(brokeredConnections.app));

      /*
       * THE APPS EACH OF THIS PERSON'S REVOCATIONS ENDS BESIDES THE ONE ASKED ABOUT, read BEFORE a
       * single revoke goes out and through {@link resolveSiblings}, the one place that answers it.
       *
       * WHY THIS LOOP NEEDS IT AT ALL, when it already asks about every app the person holds.
       * Where a connection is keyed `(identity, auth provider)` — Arcade — the FIRST app's revoke
       * ends the connection and every app sharing it, so the ask for a sibling that follows finds
       * nothing left and answers `false`. Passed through, that is `vendorRevocationRequested:
       * false` on the trail for a grant this deployment asked for and got, which is the one
       * reading of that field that must never be written: it says "no vendor was asked" about an
       * account that was withdrawn, to whoever later checks that an offboarding completed. The
       * order the rows come back in decides which app gets the truthful row and which gets the
       * false one, which is to say nothing decides it.
       *
       * Where each app is its own auth provider — Composio — every set here is empty by
       * construction, each ask stands alone, and nothing below differs from what this method
       * always did.
       *
       * RESOLVED AGAINST THE PERSON'S OWN IDENTITY, the same `account` the revokes below are asked
       * with. MEMOIZED ACROSS THE WHOLE OFFBOARDING for the reason {@link removeServer} gives:
       * `authProviderOf` is a live vendor call on Arcade, and the bound is then the number of
       * DISTINCT TOOLKITS this person holds rather than that number squared. Empty with no broker
       * configured, where nothing is asked of anybody and the `false` below is the whole truth.
       */
      const account = personAccount(userId);
      const authProviders = new Map<string, Promise<string | null>>();
      const endedBesides = new Map<
        string,
        { siblings: string[]; unanswered: number }
      >();
      if (broker) {
        for (const connection of brokered) {
          endedBesides.set(
            connection.toolkit,
            await resolveSiblings(
              { toolkit: connection.toolkit, account },
              authProviders,
            ),
          );
        }
      }

      /*
       * WHAT THE TRAIL MAY CLAIM WAS ASKED OF THE VENDOR FOR EACH APP, read before a single revoke
       * goes out, as {@link disconnectBrokered} reads its own. A KEY app's row says `false` whatever
       * the vendor answered — see {@link vendorRevocationClaim}, which all three writers of an asked
       * app's row now ask. This one used to pass the vendor's answer through for a key (round 2,
       * L5-a), the same divergence {@link removeServer} had (A5c).
       */
      const toRetire: {
        toolkit: string;
        claim: Awaited<ReturnType<typeof vendorRevocationClaim>>;
      }[] = [];
      for (const connection of brokered) {
        toRetire.push({
          toolkit: connection.toolkit,
          claim: await vendorRevocationClaim(connection.toolkit),
        });
      }

      /*
       * What the broker was actually asked for each app, kept so the trail below records the answer
       * rather than the call. False where there is no broker at all: a deployment whose key has
       * since been unset can still offboard somebody, and it could not have been calling Composio
       * either way — but nothing was asked there and the row must not claim otherwise.
       *
       * ONE APP'S REFUSAL IS ONE APP'S REFUSAL, and until now it was everybody's. A throw out of
       * `revoke` left this loop before the delete and before the trail, so three accounts already
       * withdrawn at Composio kept their rows and got no row on the trail. That was survivable while
       * repeating the act did nothing — and #574 made repeating it the documented recovery, so the
       * second pass asks again for those three, Composio answers `false` because the accounts are
       * gone, and each writes `vendorRevocationRequested: false` about a withdrawal this deployment
       * asked for and got. That field exists to tell an account we acted on from one that outlives
       * us somewhere else; those three rows say the wrong one.
       *
       * So the answer is kept per app and the refusal is held rather than thrown. Every app is still
       * asked — a later one is not punished for an earlier one — and the first refusal is rethrown
       * below, so the act still fails loudly and the administrator still gets a 500.
       */
      const withdrawn: {
        toolkit: string;
        requested: boolean;
        claim: Awaited<ReturnType<typeof vendorRevocationClaim>>;
      }[] = [];
      const refusals: unknown[] = [];
      for (const connection of toRetire) {
        try {
          withdrawn.push({
            toolkit: connection.toolkit,
            claim: connection.claim,
            requested: broker
              ? await broker.revoke({
                  /*
                   * THE PERSON'S OWN ACCOUNT, NAMED AS ONE. Offboarding somebody ends what they
                   * held and never the deployment's shared account, whoever connected it — so the
                   * holder is fixed above rather than read off anything, and the vendor id is the
                   * person's own, which is what a personal account is filed under at Composio. The
                   * SAME value the siblings were resolved against, because an answer about one
                   * identity describing a revocation on another is the whole of what that set is
                   * for.
                   */
                  account,
                  toolkit: connection.toolkit,
                })
              : false,
          });
        } catch (error) {
          /*
           * Held, and the row deliberately left standing.
           *
           * "An offboarding the vendor refuses leaves the connection standing" is the existing
           * criterion and it is unchanged: the row is the only thing naming which app this person
           * connected, repeating the act is the recovery, and repeating it is only possible while
           * the row is there. What changes is that the rule now applies to the app it is about
           * rather than to every app in the same act.
           */
          refusals.push(error);
        }
      }

      /*
       * Only the apps that answered, which is the other half of the same correction.
       *
       * Deleting by user id would take the rows of apps that were refused or never reached, and
       * those are exactly the rows the recovery needs. Deleting none — what a throw used to do —
       * leaves a row and an open `(toolkit, user_id)` gate for an account that is already gone at
       * Composio, so the table claims a connection this person does not have.
       */
      if (withdrawn.length > 0) {
        await database.delete(brokeredConnections).where(
          and(
            eq(brokeredConnections.holder, "person"),
            eq(brokeredConnections.userId, userId),
            inArray(
              brokeredConnections.app,
              withdrawn.map((entry) => entry.toolkit),
            ),
          ),
        );
      }

      /*
       * WHICH OF THIS PERSON'S APPS WERE ENDED BY ANOTHER APP'S REVOCATION, and by which one.
       *
       * Only from a revoke that ANSWERED TRUE: `false` means nothing was found to withdraw or the
       * auth provider could not be resolved, and the vendor was not shown to have ended anything,
       * so nothing is claimed on the strength of it — the rule {@link removeServer} files its
       * siblings by. The asked app is skipped in favour of its own answer, and the first ender
       * wins, which is deterministic because the rows are walked in app order.
       *
       * APPS THIS PERSON HOLDS ARE ALL THIS CAN SPEAK FOR. A sibling resolved on the same identity
       * but held by the deployment, or an app whose own revoke threw and so has no row here, is
       * left alone: this map only corrects what the loop below is already about to write.
       *
       * WHICH SIBLINGS A REVOKE ENDED IS {@link siblingsEndedBy}'S ANSWER, the one
       * {@link clearEndedSiblings} deletes on — rules 1 and 2 — and not a walk of this method's
       * own. It was one: rule 2 without rule 1, so a KEY app whose own ask answered false was filed
       * as ended by an OAuth sibling's revoke that never reached it (round 2, A5b). What differs
       * here is only what is DONE with the answer: this method deletes its own rows as its own acts
       * above, so it takes the judgement without the delete and files `endedWith` from it.
       */
      const endedWith = new Map<string, string>();
      for (const entry of withdrawn) {
        const ended = await siblingsEndedBy({
          siblings: endedBesides.get(entry.toolkit)?.siblings ?? [],
          endedWith: entry.toolkit,
          revoked: entry.requested,
        });
        for (const app of ended) {
          if (!endedWith.has(app)) endedWith.set(app, entry.toolkit);
        }
      }

      for (const connection of withdrawn) {
        retired += 1;
        /*
         * The app whose revocation ended this one, where this one's own ask came back empty
         * because that revocation had already taken it. Absent for an app that was ended by its
         * own ask, which needs no other grant named beside it.
         */
        const endedBy = connection.requested
          ? undefined
          : endedWith.get(connection.toolkit);
        const resolved = endedBesides.get(connection.toolkit);
        await recordAuditEvent(auditStore, {
          eventType: "mcp.account_disconnected",
          targetType: "mcp_server",
          // The app, which for a brokered connection is all the row records. The `mcp_servers` row
          // it belongs to may have been removed already, and the connection outlives that too.
          targetId: connection.toolkit,
          payload: {
            actor: by,
            server: connection.toolkit,
            owner: userId,
            reason: "person_removed",
            /*
             * What was asked of the vendor, not that a call was made — {@link
             * ComposioBroker.revoke}'s own answer, passed through, and the one place this half
             * differs from the vault loop above. There the grant at Google outlives our copy of
             * the secret and nothing was asked of anybody, so the field can only say false; here
             * there was no secret of ours and the account itself was deleted at Composio with its
             * withdrawal asked for, or there was nothing to ask about, or there was no broker to
             * ask. The value of the field is exactly that a reader can tell those apart, so a
             * constant here would be worse than none.
             *
             * OR WHAT WAS ASKED ABOUT THE CONNECTION THIS APP SHARES, which is the same claim
             * made about the same grant. On Arcade the ask that ended this app may have been
             * spelled with a sibling's name, and `revoke`'s `false` here then means "already
             * gone", not "nobody asked" — `endedWith` beside it names the app that asked.
             *
             * AND NEVER FOR A KEY: {@link vendorRevocationClaim} makes the claim from that
             * reading, and for a key app it is `false` whatever the vendor answered.
             */
            ...connection.claim(connection.requested || Boolean(endedBy)),
            /*
             * AND WHERE A SIBLING RELATIONSHIP IS BEING CLAIMED, HOW MANY apps on this identity
             * could not be asked about and so could not be ruled siblings either way — an
             * integer, never their names; see {@link resolveSiblings}. Beside `endedWith` and
             * nowhere else, which is where {@link removeServer} puts it and for its reason: the
             * count qualifies a claim about which apps went together, and a row making no such
             * claim would be carrying a number about nothing.
             */
            ...(endedBy
              ? {
                  endedWith: endedBy,
                  unansweredSiblings: resolved?.unanswered ?? 0,
                }
              : {}),
          },
        });
      }

      /*
       * Loud, after every app has been asked and every answer recorded.
       *
       * The first, because the route turns this into a 500 and one sentence is what reaches the
       * administrator; the rest are the same act failing more than once, and the trail above already
       * says which apps did not end. Thrown last rather than first so a refusal on one app cannot
       * cost the record of another — which is the whole of this change.
       */
      if (refusals.length > 0) throw refusals[0];

      return { retired };
    },
  };
}

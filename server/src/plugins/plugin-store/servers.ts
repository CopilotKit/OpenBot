import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { recordAuditEvent } from "../../audit";
import {
  databaseComplaint,
  isQueryFailure,
  reasonWithoutStatement,
  withoutStatement,
} from "../../db/query-failure";
import {
  brokeredConnections,
  credentials as credentialRows,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../../db/schema";
import { accessFor } from "../access";
import {
  type BrokerConnection,
  BrokerUnconfiguredError,
  type Decides,
  schemeKind,
} from "../broker";
import {
  catalogueEntry,
  classifyTool,
  customUrlRefusal,
  resolveServerUrl,
  serverCredentialKind,
  tokenHeaderFor,
} from "../catalogue";
import { toolkitOf } from "../composio";
import type { ListedTool } from "../mcp";
import type { AccountMode, AccountRef } from "../shared-accounts";
import { transportFor } from "../transport";
import type { StoreContext } from "./context";
import {
  CatalogueEntryUnknownError,
  CustomServerRefusedError,
  DEPLOYMENT_ACTOR,
  effectiveUrl,
  isDeploymentFault,
  iso,
  PluginInvariantError,
  type ServerAddress,
  type ServerRecord,
  schemeFor,
  storableTools,
  unlistedAdvertisedTools,
} from "./model";

/** Adding, removing, refreshing and listing MCP servers and brokered apps, and an app's account mode. */
export function serverMethods(context: StoreContext) {
  const {
    database,
    auditStore,
    credentials,
    broker,
    mcpGrantsForServers,
    accountRefFor,
    connectionTokenFor,
    requireCredentialOfKind,
    requireNotBrokered,
    requireServer,
    brokeredAppRow,
    brokeredAppRowsAt,
    brokeredAppScheme,
  } = context;
  return {
    accountRefFor,
    /**
     * Add a server from the catalogue.
     *
     * The URL is resolved from the catalogue rather than accepted from the caller, so the only thing
     * a person can influence is which entry and, for a per-instance vendor, their own instance
     * hostname, which is then checked against that vendor's anchored pattern before anything is
     * stored.
     */
    async addServer(input: {
      key: string;
      instanceHost?: string;
      credentialId?: string;
      by: string;
    }): Promise<ServerRecord> {
      const resolved = resolveServerUrl(input.key, input.instanceHost);
      if (!resolved) throw new CatalogueEntryUnknownError(input.key);

      /*
       * The pointer is checked here for the same reason it is on the path below: the refresh that
       * runs before this returns dereferences whatever it names.
       *
       * What that reaches is narrower on this path, because the URL is the catalogue's rather than
       * the caller's, so a credential cannot be delivered to an address somebody chose. That is a
       * property of today's catalogue rather than of this function: the one entry it holds is
       * `user-oauth`, and the catalogue's own comment invites a fork to re-add the vendors that were
       * taken out. The first `deployment-bearer` entry restores the full shape, so the check belongs
       * here now rather than in the review that re-adds one.
       */
      const credentialId = input.credentialId?.trim() || undefined;
      if (credentialId) {
        await requireCredentialOfKind(
          resolved.entry.title,
          resolved.entry.key,
          credentialId,
          serverCredentialKind(resolved.entry),
        );
      }

      /*
       * Not over a brokered row. See {@link requireNotBrokered} for what such a row would lose.
       *
       * Unreachable from the shipped product as it stands — `addBrokeredApp` mints `composio-<slug>`
       * and no catalogue entry is spelled that way — and asked anyway, because the row the check is
       * about is by definition one that arrived some other way: a hand edit, a restore, a build
       * whose catalogue named an app a past build brokered. This path writes the catalogue's url
       * over whatever is there, which is exactly the write that strands the accounts.
       */
      const [existing] = await database
        .select({
          provenance: mcpServers.provenance,
          url: mcpServers.url,
          // Part of what `accessFor` resolves a row with — see there. Nothing on this path reads
          // the answer's `reachedAs`, but the column travels with the other two so no caller has
          // to know which of the four answers the one it wants depends on.
          authScheme: mcpServers.authScheme,
        })
        .from(mcpServers)
        .where(eq(mcpServers.id, resolved.entry.key));
      requireNotBrokered(resolved.entry.key, existing);

      await database
        .insert(mcpServers)
        .values({
          id: resolved.entry.key,
          title: resolved.entry.title,
          vendor: resolved.entry.vendor,
          url: resolved.url,
          credentialId: credentialId ?? null,
          addedBy: input.by,
        })
        .onConflictDoUpdate({
          target: mcpServers.id,
          set: {
            url: resolved.url,
            /*
             * THE WHOLE IDENTITY THE CATALOGUE DECIDES, not the url alone.
             *
             * These three columns and the url are one statement — this row is that reviewed entry —
             * and an update that moved one of them and left the rest was a row describing two
             * different servers at once. `provenance` is read by `requireServer`, which refuses a
             * `first-party` row with no entry, and by `accessFor`, which reads it whenever there is
             * no entry to overrule it; `vendor` is what the first-party rule is checked against.
             * Left behind, a row that arrived by another path kept saying so at an address only the
             * catalogue chose — so every surface that asks how a server got here answered with the
             * way it USED to get here.
             *
             * The entry wins over the row everywhere else too (see `accessFor`), so this is that
             * same order written down at the one moment the row is being established rather than
             * read.
             */
            title: resolved.entry.title,
            vendor: resolved.entry.vendor,
            provenance: "first-party",
            /*
             * Left alone when the caller sends none, rather than cleared.
             *
             * `registerOAuthClient` keeps the client it minted in this column, and adding the server
             * again to change an instance host is not a statement about that client. Clearing it
             * orphaned the credential row, which nothing then revokes, and told everybody who had
             * connected that the deployment has no OAuth client registered. There is no longer a way
             * to hand it back through this call either, since a `user-oauth` entry now refuses a
             * credential id, so the pointer has to survive here.
             */
            ...(credentialId ? { credentialId } : {}),
            addedBy: input.by,
            updatedAt: new Date(),
          },
        });

      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "mcp_server",
        targetId: resolved.entry.key,
        payload: {
          actor: input.by,
          change: "mcp_server_added",
          server: resolved.entry.key,
          url: resolved.url,
        },
      });

      // Refreshed immediately so the page that added it can show what it offers, and so a bad
      // credential is reported now rather than the first time a Bot tries to use it.
      await this.refreshTools(resolved.entry.key);
      const servers = await this.listServers();
      const added = servers.find((server) => server.id === resolved.entry.key);
      if (!added) throw new CatalogueEntryUnknownError(input.key);
      return added;
    },

    /**
     * Add a server that is not in the catalogue, by URL.
     *
     * The administrator's path is different from pressing Add on a curated entry. That
     * one picks a reviewed vendor at a pinned host; this one points the deployment at an address
     * somebody typed. Both are useful and only one of them can be reviewed in advance, so this one
     * is guarded at the URL, recorded with its provenance, and every tool it offers is treated as a
     * write because nothing here knows otherwise.
     */
    async addCustomServer(input: {
      id: string;
      title: string;
      url: string;
      credentialId?: string;
      by: string;
    }): Promise<ServerRecord> {
      const refusal = customUrlRefusal(input.url);
      if (refusal) throw new CustomServerRefusedError(refusal);

      // A custom server may not take a curated entry's slug. The slug prefixes tool names and is
      // what a grant and a policy rule are written against, so allowing a shadow would let a custom
      // server inherit rules an operator wrote about the vendor.
      if (catalogueEntry(input.id)) {
        throw new CustomServerRefusedError(
          `${input.id} is the name of a server this deployment already knows. Choose another.`,
        );
      }

      /*
       * Nor may it take the name of a screen. `/admin/plugins/composio` is a static route — the app
       * directory's own page — and a static route is matched ahead of `/admin/plugins/$key`, so a
       * server sitting at this id would be listed and then open somebody else's page instead of its
       * own. Brokered servers are `composio-<slug>` and no catalogue entry is called this, which
       * leaves a hand-typed id as the only way to reach it.
       */
      if (input.id === "composio") {
        throw new CustomServerRefusedError(
          "composio is the name of this deployment's own Composio screen, so a server added there could never be opened. Choose another.",
        );
      }

      /*
       * NOR THE NAMESPACE THE BROKERED ROWS ARE MINTED IN, which is the reservation above one step
       * further out.
       *
       * CRITERION. No server added by URL may take an id beginning `composio-`, whether or not a row
       * is sitting there today.
       *
       * REASON. {@link addBrokeredApp} composes its id as `composio-<slug>` from the app an
       * administrator enabled, so that space is already spoken for by a path that writes
       * `composio://` urls into it. Unreserved, the two paths write one row: enabling an app over a
       * typed endpoint, or typing an endpoint over an app somebody is connected to. The second of
       * those is the one that cannot be undone — see {@link requireNotBrokered} — and this is what
       * stops either from arising in the first place, rather than catching them one row at a time.
       *
       * A PREFIX RATHER THAN A LOOKUP OF WHAT IS ENABLED TODAY. "Is there a brokered row at this id"
       * is a question whose answer changes: an app removed this morning frees the name, and the next
       * press of Add takes it back from whoever typed it in between. The namespace is what a reader
       * of a grant or a policy rule can rely on without asking the database what year it is.
       *
       * It is the same objection the curated-slug refusal above makes, and the same one
       * `addBrokeredApp` records for its own id: the id prefixes every tool name and is what a grant
       * and a policy rule are written against, so a row shadowing another path's namespace inherits
       * rules that were written about something else.
       */
      if (input.id.startsWith("composio-")) {
        throw new CustomServerRefusedError(
          `Names beginning composio- belong to the Composio apps this deployment enables, so ${input.id} is not a name a server added by URL can take. Choose another.`,
        );
      }
      if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(input.id)) {
        throw new CustomServerRefusedError(
          "A server name is lower-case letters, numbers and hyphens.",
        );
      }

      /*
       * The pointer is checked here because the add is what dereferences it.
       *
       * `refreshTools` runs before this method returns, and for a custom server there is no
       * catalogue entry, so `connectionTokenFor` decrypts whatever `credential_id` names and
       * `listTools` sends it to the URL from this same request. An unchecked pointer therefore is
       * not "a wrong token later", it is this call delivering that secret to an address the caller
       * chose, before any grant, policy check or Bot exists.
       *
       * `mcp` is the only kind that answers "this server's own token". A `mcp_user_token` is one
       * person's grant and a `mcp_oauth_client` identifies the deployment to a vendor; neither is
       * this deployment's bearer token for this server, and spending either here would be using a
       * credential on behalf of somebody who never agreed to it. `POST /api/admin/credentials`
       * already refuses to mint those two by hand for that reason, and its comment says so; this is
       * the same objection at the point they are referenced rather than created.
       *
       * One message for both "wrong kind" and "no such credential", deliberately. A caller who can
       * tell those apart can ask this endpoint which credential ids are real.
       */
      /*
       * A credential is spent at the address it was given to, or not spent.
       *
       * Adding a server that is already here rewrites its URL, and the refresh that follows sends
       * whatever credential it holds to the new one, in the same call. That is the same disclosure
       * as naming another server's token and it needs no trick at all: the token really does belong
       * to this server, and only the address moved. A check on whose credential it is cannot see it,
       * which is why this rule is here and not folded into that one.
       *
       * Refused rather than repaired, because the two harmless readings of the request are both
       * served by something else. Correcting a title or retrying an interrupted add sends the same
       * URL and is unaffected, and genuinely moving a server means the vendor is at a new address,
       * where the honest act is to remove it and add it again with the token that address is
       * supposed to hold.
       *
       * Only this path. A curated server's URL comes from the catalogue rather than the request, so
       * the most a caller can influence is an instance hostname, and that is matched against the
       * vendor's own anchored pattern before anything is stored. Re-adding one cannot point it at an
       * address of the caller's choosing, which is the whole of what this refuses.
       */
      const credentialId = input.credentialId?.trim() || undefined;
      const [existing] = await database
        .select({
          url: mcpServers.url,
          credentialId: mcpServers.credentialId,
          // Read for the refusal below. The namespace rule above already keeps this path away from
          // every id `addBrokeredApp` mints; this is the same rule asked of the ROW, which is what
          // covers one that arrived before the namespace was reserved, or by restore.
          provenance: mcpServers.provenance,
          // The third of what `accessFor` resolves a row with. See there.
          authScheme: mcpServers.authScheme,
        })
        .from(mcpServers)
        .where(eq(mcpServers.id, input.id));

      /*
       * Before the address rule below, because it is the stronger statement about the same write.
       *
       * That one is about a credential being carried to an address, and it lets an add through when
       * no token is involved. This one is about the address ITSELF being the only record of which
       * app a set of connections belongs to, and no absence of a credential makes that write
       * survivable. See {@link requireNotBrokered}.
       */
      requireNotBrokered(input.id, existing);

      if (
        existing &&
        existing.url !== input.url &&
        (existing.credentialId || credentialId)
      ) {
        throw new CustomServerRefusedError(
          `${input.id} is already here at a different address and holds a credential. Remove it and add it again, with the token the new address is meant to have.`,
        );
      }

      if (credentialId) {
        // Always `mcp`: a server added by URL is reached with the one token the deployment holds for
        // it, whatever the vendor is, because nothing here knows the vendor.
        await requireCredentialOfKind(
          input.title,
          input.id,
          credentialId,
          "mcp",
        );
      }

      await database
        .insert(mcpServers)
        .values({
          id: input.id,
          title: input.title,
          vendor: new URL(input.url).hostname,
          url: input.url,
          provenance: "custom",
          credentialId: credentialId ?? null,
          addedBy: input.by,
        })
        .onConflictDoUpdate({
          target: mcpServers.id,
          set: {
            title: input.title,
            url: input.url,
            /*
             * WHAT THE ROW NOW IS, written beside the address that made it that.
             *
             * `vendor` is derived from the url on the way in, so leaving it behind while the url
             * moved left the column naming a host this row no longer addresses — and it is what the
             * first-party rule is checked against, not a caption. `provenance` is the same fact one
             * level up: a row whose entry a build removed still reads `first-party`, and
             * `requireServer` refuses exactly that shape as a vendor it can no longer check a pinned
             * host for. Adding it by URL is what makes it a typed address rather than a reviewed
             * one, so this is the act that settles the column.
             *
             * The one conversion this cannot make is out of a brokered row, which is refused above
             * rather than written here: there the url is the only record of which app a set of
             * consents belongs to, so a rewrite loses them whatever else is written alongside.
             */
            vendor: new URL(input.url).hostname,
            provenance: "custom",
            /*
             * Kept when the caller names none, rather than cleared, for a reason beyond tidiness.
             *
             * Clearing it left the credential live with nothing pointing at it, and `removeServer`
             * retires a token by reading it off the row: with the pointer gone it revoked nothing
             * and deleted the server, so the token outlived the server it was minted for. It could
             * then be attached to a freshly created server at any address, because the rule above
             * compares against a row that no longer existed. Three ordinary acts, and the address
             * this server was entrusted to stopped meaning anything.
             *
             * So the pointer survives, `removeServer` finds it, and a removed server's token is
             * dead rather than loose. Detaching a token without removing the server is not a thing
             * this endpoint does, and nothing asks it to.
             */
            ...(credentialId ? { credentialId } : {}),
            addedBy: input.by,
            updatedAt: new Date(),
          },
        });

      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "mcp_server",
        targetId: input.id,
        payload: {
          actor: input.by,
          change: "mcp_server_added",
          server: input.id,
          url: input.url,
          // Named in the trail, because "who added a server nobody reviewed" is a question somebody
          // will ask and the answer should not require reading the catalogue of a past build.
          provenance: "custom",
        },
      });

      await this.refreshTools(input.id);
      const added = (await this.listServers()).find(
        (server) => server.id === input.id,
      );
      if (!added) throw new CatalogueEntryUnknownError(input.id);
      return added;
    },

    /**
     * Enable one app of the broker's catalogue, which is a third way for a server to arrive.
     *
     * NO URL IS TAKEN FROM A CALLER, WHICH IS WHY THERE IS NO HOST RULE HERE. `addCustomServer`
     * guards the address because the address is what an administrator typed and what a credential
     * would then be spent at; this one composes `composio://<slug>` itself, and a brokered row is
     * never dialled at a host at all — the transport reads the app off that url and asks Composio,
     * over the deployment's own key. So the only thing left to check about the url is that it says
     * what this call meant, and {@link toolkitOf} is what checks it: the slug goes in, the url comes
     * back out through the very function `accessFor` will read it with, and a slug those two
     * disagree about is refused rather than stored. A pattern written here instead would be a second
     * opinion about the shape of an app name, and the reading that decides which app a call runs
     * against is the one that has to be satisfied.
     *
     * THE AUTH CONFIG COMES BEFORE THE ROW, in that order and not the other. An auth config is what
     * a person's connection is then created against, so a row written first is an app an
     * administrator can see on the page, grant to a Bot and press Connect on, with nothing at the
     * vendor for any of it to attach to. Asking first is also what makes a failure leave nothing
     * behind: the broker throws, this call throws, and no row, no action and no audit entry claims
     * an app was enabled. {@link ComposioBroker.ensureAuthConfig} is idempotent precisely so that
     * enabling an app twice — two administrators, or a retried request — is allowed to do this.
     *
     * THE ID IS PREFIXED AND THE URL IS NOT. `composio-linear` is what prefixes tool names and what
     * a grant and a policy rule are written against, so it must not land on a curated entry's key —
     * which `accessFor` refuses outright as a row claiming to be two servers at once — nor on one of
     * the ids the integration suite reserves for its own fixtures: `gmail`, `notion`, `bot_helper`.
     * The prefix puts every brokered row out of reach of all of them. WHICH APP THE ROW IS still
     * comes off the url and only off the url, because that is where `accessFor` and the brokered
     * gate behind it both read it from; the id names the row and never the app, and nothing may
     * start reading one as the other.
     */
    async addBrokeredApp(input: {
      slug: string;
      title: string;
      logo?: string | null;
      by: string;
      /**
       * How this app connects, resolved from the catalogue row the administrator chose.
       *
       * Taken rather than derived here, because the caller has already read it off that row and a
       * second derivation is a second answer — the one thing {@link BrokerConnection} exists to
       * prevent. It decides what config is created at the vendor, and it is what this row records.
       */
      connection: BrokerConnection;
    }): Promise<ServerRecord> {
      // Before anything at all. A deployment with no key has no catalogue for this app to have been
      // chosen from, so there is nothing here to half-do and nothing to say but the setting.
      if (!broker) throw new BrokerUnconfiguredError();

      const url = `composio://${input.slug}`;
      if (toolkitOf(url) !== input.slug) {
        throw new CustomServerRefusedError(
          `${input.slug} is not a name a Composio app can have. An app is named in letters, numbers, underscores and hyphens, because that name is read back out of this row's url to decide which app a call is against.`,
        );
      }

      /*
       * WHAT THE ROW ALREADY SAYS, READ BEFORE ANYTHING IS WRITTEN, because after the upsert this
       * question cannot be asked any more — the insert below would have answered it.
       *
       * It is the scheme the app's ANSWERING row records, which is what every brokered reader
       * resolves and is not always the row the upsert names. See {@link brokeredAppRow}.
       */
      const recorded = await brokeredAppScheme(input.slug);

      const configured = await broker.ensureAuthConfig({
        toolkit: input.slug,
        name: input.title,
        connection: input.connection,
      });

      /*
       * THE SCHEME THIS ENABLE MAY WRITE DOWN, WHICH IS NOT ALWAYS THE ONE THE CATALOGUE RESOLVES.
       *
       * CRITERION. What this row records is what the authorization config standing at Composio was
       * created as — never what today's catalogue says the app could be connected with.
       *
       * REASON. {@link ComposioBroker.ensureAuthConfig} reuses a config of ours whatever scheme it
       * holds, and it used to say nothing about having done so, so every path here wrote the
       * catalogue's answer. An app enabled while Composio published only a key, and later given
       * managed OAuth, came out of a second press of Add recording `OAUTH2` beside a config that is
       * still `API_KEY`: `brokeredAppKind` then says `consent`, so `connectBrokeredWithFields`
       * refuses every submission while `authorize` mints consent links against a key config — the
       * exact "sent to a consent screen that had nothing to ask them for" failure that method's own
       * comment describes. And pressing Add again could never repair it, because the reuse is what
       * caused it.
       *
       * `standing` IS THEREFORE THE ONE ANSWER THAT KEEPS WHAT WAS THERE, and it falls back to the
       * catalogue only where nothing was recorded at all — a row restored without the column, or an
       * app whose config was made before this deployment recorded one. A guess is the best available
       * answer there and it is no worse than what stood before; everywhere else the recorded word
       * wins.
       *
       * AND `created` MAY WRITE FREELY, connections or no connections: the config those connections
       * were made against is gone from Composio — that is why one had to be created — so the new
       * scheme is the only true thing to record about the app.
       */
      const scheme =
        configured === "standing"
          ? (recorded ?? schemeFor(input.connection))
          : schemeFor(input.connection);

      /*
       * THE COMPOSED NAME IS SPELLED WHERE IT IS MINTED AND IS GIVEN NO BINDING TO BE REUSED FROM.
       *
       * It used to be `const id`, and everything below this statement then had a plausible-looking
       * server id to reach for — which is how four review rounds each moved one site onto the
       * resolved row and left the next one standing. See {@link _EnableNamesTheRow}: after this
       * statement there is exactly one id in scope, and it is the answering row's.
       */
      await database
        .insert(mcpServers)
        .values({
          id: `composio-${input.slug}`,
          title: input.title,
          logo: input.logo ?? null,
          // The broker, whoever publishes the app behind it. `vendor` is what the first-party rule
          // is checked against, and Composio is who this deployment is actually talking to.
          vendor: "Composio",
          url,
          provenance: "composio",
          // Nothing for the vault to hold. A brokered call runs as the person asking, on their own
          // connection at the vendor, which is a `composio_connections` row rather than a secret.
          credentialId: null,
          /*
           * What the config standing at Composio was created AS, which is the scheme every later
           * connection against it has to keep using.
           *
           * THE RESOLVED ONE AND NOT THE CATALOGUE'S, WHICH THIS BRANCH USED TO WRITE UNGUARDED.
           * The write-once rule below protects only the UPDATE, and this INSERT fires exactly when
           * no row stands at the composed id — which is not the same as no row standing for the
           * APP. In the two-rows-at-one-url state this method is built around, a restored or
           * hand-added `gmail` at `composio://gmail` holding `API_KEY` and live key connections is
           * untouched by the guard: the insert at `composio-gmail` fired, wrote `OAUTH2`, and
           * `composio-gmail` sorts first, so `brokeredAppRowsAt` made the new row the answering
           * one. `confirmBrokeredConnection` then classified the app `consent`, saw `verified:
           * false` on a key row, and wrote `verified: true, probeAction: null` over it — erasing a
           * recorded failed check on the next page load. See the derivation of `scheme` above.
           */
          authScheme: scheme,
          /*
           * PERSONAL ON A NEW ROW, AND NULL WHERE THERE IS NO ACCOUNT TO HOLD.
           *
           * A freshly enabled app is reached through each asking person's own account until an
           * administrator deliberately switches it to Shared — sharing one account across everyone
           * a Bot reaches is a decision somebody makes, never a default this method makes for them.
           * A `no-auth` app has no account at all, so it has no mode to choose between, and the
           * column says so rather than claiming one; see {@link mcpServers.accountMode}.
           *
           * WRITTEN ON THE INSERT ONLY. The update below is the branch a second press of Add takes,
           * and an app an administrator has already made Shared must not be quietly turned back
           * into Personal by it.
           */
          accountMode: input.connection.kind === "no-auth" ? null : "personal",
          addedBy: input.by,
        })
        .onConflictDoUpdate({
          target: mcpServers.id,
          set: {
            title: input.title,
            logo: input.logo ?? null,
            url,
            /*
             * WRITTEN BESIDE THE URL, BECAUSE THE TWO ARE ONE FACT AND A ROW HOLDING HALF OF IT IS
             * NOT A SERVER AT ALL.
             *
             * CRITERION. Every row this method leaves behind says `composio`, whatever it said
             * before. The url above and this column are what `accessFor` reads to answer that a call
             * is brokered and which app it is against, and no path may write one without the other.
             *
             * REASON. This branch rewrote the url and left `provenance` standing, so enabling an app
             * at an id a custom server already held produced a row reading `custom` at a
             * `composio://` address. That is not a display inconsistency: `accessFor` answers
             * `deployment-token` for it, so the transport dialled the row as an ordinary MCP
             * endpoint on the deployment's own credential while the Composio screen went on
             * attaching people's real accounts to the app its url named. The per-person gate was not
             * weakened but SKIPPED — `connectionTokenFor` only ever asks for a connection down the
             * brokered branch — which is the whole property this connector exists for. And
             * `removeServer` finds the accounts to end at the vendor through that same answer, so it
             * revoked nothing and reported the connector gone.
             *
             * A CONVERSION HERE, A REFUSAL IN THE OTHER DIRECTION, and the asymmetry is the point.
             * What this method writes IS the app — the auth config stands at Composio before the row
             * is touched, and the url names the app the connections will be keyed on — so a row it
             * lands on comes out saying exactly what it now is, with nothing lost. Going the other
             * way, the url being overwritten is the only record of which app a set of consents
             * belongs to, and no column written alongside brings it back; see
             * {@link requireNotBrokered}.
             *
             * `vendor` for the same reason one notch quieter: it is what the first-party rule is
             * checked against, and a row reached over the broker whose vendor column still names the
             * host somebody typed is answering that rule about a server this deployment no longer
             * dials.
             */
            provenance: "composio",
            vendor: "Composio",
            addedBy: input.by,
            updatedAt: new Date(),
            /*
             * `credential_id` is neither written here nor cleared here.
             *
             * Every row this method creates has none and no path in this module attaches one, so
             * there is nothing for an enable to set. Clearing it anyway would matter in the single
             * case it could apply — a pointer that arrived by hand edit or restore — because
             * `removeServer` retires a server's secret by reading it off this column, and a null
             * written over it leaves that secret live with nothing left to name it.
             */
            /*
             * `auth_scheme` is not written here either, and for a neighbouring reason.
             *
             * This is the branch a second press of Add takes, and the scheme is the one thing on
             * the row that live connections depend on rather than merely display. Rewriting it
             * here would move them; the statement below rewrites it only where there are none.
             */
          },
        });

      /*
       * WHICH ROW THIS DEPLOYMENT WILL ANSWER FOR THE APP WITH, RESOLVED ONCE AND FOR EVERYTHING
       * BELOW.
       *
       * CRITERION. After the upsert, every act of this method — the scheme it records, the actions
       * it lists, the row it files on the trail and the record it hands its caller back — is about
       * the row {@link brokeredAppRow} names for this app. The composed `composio-<slug>` is what
       * the statement above MINTS and is a stand-in for nothing.
       *
       * REASON. `mcp_servers.url` has no unique index, deliberately — see {@link brokeredAppRow} —
       * so the row this method names and the row every brokered reader resolves are allowed to be
       * different rows, and in the ordinary two-rows-at-one-url state they are. Every act keyed on
       * the composed id was then an act performed somewhere nothing looks. FOUR ROUNDS OF REVIEW
       * EACH MOVED ONE OF THEM AND LEFT THE NEXT STANDING: the probe was resolved by url, then
       * `brokeredAppRow` was introduced and the probe and the confirm routed through it, then the
       * scheme WRITE was moved here — and the actions went on being listed under the composed name
       * the whole time. That last one is the deadlock the single-row rule exists to close: the
       * chooser reads actions by server id, finds none on the answering row, so `checkable` is
       * false on every page load, the browser draws no Re-check button, and the one press that
       * could earn the app a verdict can never be made.
       *
       * THE ROW IS RE-READ RATHER THAN ASSUMED, because the upsert may have created it, found it,
       * or landed beside an older row that sorts first — and which of those happened is exactly what
       * decides the answer. The composed name is respelled as the fallback for the unreachable case
       * of a row this method has just written not being found at its own url, which would mean the
       * insert above and this read disagree about what was stored; it is respelled rather than held
       * in a binding so that nothing below can take it by mistake.
       */
      const answering =
        (await brokeredAppRow(input.slug))?.id ?? `composio-${input.slug}`;

      /**
       * WHICH ROW EACH ACT OF AN ENABLE NAMES, WRITTEN DOWN BECAUSE NOTHING ELSE CAN SAY IT.
       *
       * Type-only and erased; see {@link Decides}. Every other roster in this file is keyed on a
       * vocabulary the compiler already knows — {@link SchemeKind}, {@link BrokeredProbe} — and
       * this one is keyed on the acts of a single method, because the drift being pinned is not a
       * branch that forgot a member but a SITE that reached for the wrong name. There is no type
       * whose inhabitants are "the things an enable does", so the checklist is the union and the
       * roster is what forces an answer out of it: a sixth act added to `BrokeredEnableAct` fails
       * `tsc` here until somebody says which row it is about, and the two legal answers are a closed
       * pair rather than free text so the seam cannot drift in the direction it has drifted four
       * times.
       *
       * `minted` IS THE ANSWER FOR EXACTLY ONE ACT, and that is the whole shape of the rule. The
       * upsert has to be keyed on the composed name — it is what converts a row an administrator
       * typed at that id into the brokered app it now is, which is a property with its own test —
       * and every act after it is about the row the readers read.
       */
      type BrokeredEnableAct =
        | "upsert"
        | "scheme"
        | "actions"
        | "trail"
        | "answer";
      type _EnableNamesTheRow = Decides<
        BrokeredEnableAct,
        {
          upsert: "minted";
          scheme: "answering";
          actions: "answering";
          trail: "answering";
          answer: "answering";
        },
        "minted" | "answering"
      >;

      /*
       * WRITTEN EXACTLY WHERE A CONFIG WAS MADE TO WRITE IT ABOUT, AND NEVER OVER A STANDING ONE.
       *
       * A row's scheme is what its authorization config was created as, and every connection made
       * against that config depends on it. Re-enabling must not rewrite it underneath them: a
       * vendor that starts publishing managed OAuth for an app somebody connected by key would,
       * one press of Add later, leave this deployment minting consent links against a config full
       * of keys.
       *
       * THE GUARD WAS "NOBODY HAS CONNECTED YET" ALONE, AND THAT HALF CANNOT SETTLE IT. It reasoned
       * that with no connections there is nothing to strand, so the rewrite is safe and is how an
       * operator picks up a vendor's change without removing and re-adding the app. The second
       * clause was false, for one reason: {@link ComposioBroker.ensureAuthConfig} REUSES a config of
       * ours whatever scheme it holds and creates nothing, so a press of Add does not pick the
       * vendor's change up — it records a word beside a config that never moved. An app enabled as
       * `API_KEY` and given managed OAuth by the vendor came out of that press recording `OAUTH2`
       * against a key config, which makes `connectBrokeredWithFields` refuse every submission while
       * `authorize` mints consent links that ask for nothing — and pressing Add again can never
       * repair it, because the reuse is the cause.
       *
       * SO BOTH CLAUSES STAND, AND EACH CLOSES WHAT THE OTHER CANNOT. Nothing connected means no
       * connection is moved by the write; a config this call actually CREATED means there is a
       * config that was made as the word being written. `standing` writes nothing whatever the
       * connection count, and remove-and-re-add is then the one act that genuinely changes an app's
       * scheme, because it is the one that deletes the config.
       *
       * AND IT IS WRITTEN ON THE ROW THAT ANSWERS FOR THE APP, WHICH IS NOT ALWAYS THE ONE THE
       * UPSERT NAMED.
       *
       * CRITERION. After this call, the scheme {@link brokeredAppScheme} answers with for the app is
       * the scheme the authorization config standing at Composio was created as.
       *
       * REASON. The statement was keyed on the composed `composio-<slug>` while every reader of this
       * column finds the app by its URL. Where those are two rows the write and the reads were about
       * different rows: an app enabled with a key that every reader calls a consent app. What the
       * person then meets is the connect form refusing them in a sentence about a sign-in screen
       * that does not exist for this app, and a Re-check button that will not press. A writer keyed
       * on a composed id has not recorded the fact; it has recorded it somewhere nothing looks.
       */
      // Anyone at all, of either holder: a deployment's shared account was made against the
      // standing config exactly as a person's was, and a rewrite would strand it the same way.
      const connections = await database
        .select({ app: brokeredConnections.app })
        .from(brokeredConnections)
        .where(
          and(
            eq(brokeredConnections.provider, "composio"),
            eq(brokeredConnections.app, input.slug),
          ),
        )
        .limit(1);

      if (configured !== "standing" && connections.length === 0) {
        /*
         * MODE PICKED FOR THE PERSON ONLY WHERE THIS REWRITE IS WHAT GIVES THE APP AN ACCOUNT AT
         * ALL, AND NEVER WHERE ONE WAS ALREADY CHOSEN. A row enabled `no-auth` has `accountMode`
         * null — there was nothing to hold a mode about, see the insert above — and if this same
         * re-add is what turns it into a key or consent app, it needs the ordinary default an
         * insert would have given it, or every later read that asks "personal or shared" finds
         * null and has no answer. An administrator who already chose Shared keeps that choice.
         */
        const [current] = await database
          .select({ accountMode: mcpServers.accountMode })
          .from(mcpServers)
          .where(eq(mcpServers.id, answering))
          .limit(1);
        const bumpAccountMode =
          schemeKind(recorded) === "none" &&
          schemeKind(scheme) !== "none" &&
          (current?.accountMode ?? null) === null;

        await database
          .update(mcpServers)
          .set({
            authScheme: scheme,
            updatedAt: new Date(),
            ...(bumpAccountMode ? { accountMode: "personal" as const } : {}),
          })
          .where(eq(mcpServers.id, answering));
      }

      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "mcp_server",
        /*
         * THE ROW A READER WOULD GO AND LOOK AT, which is the one this deployment answers for the
         * app with and not the one the upsert happened to key on. Where those differ the composed
         * row exists too, so a trail naming it would send somebody to a row whose scheme, whose
         * actions and whose Re-check button are all somewhere else — and `url` below names the app
         * itself, so nothing about which app was enabled is lost by naming the answering row here.
         */
        targetId: answering,
        payload: {
          actor: input.by,
          change: "mcp_server_added",
          server: answering,
          url,
          // Named for the same reason the custom path names its own: "who enabled an app whose
          // actions nobody reviewed" is a question somebody will ask, and the answer should not
          // require knowing how ids were spelled in a past build.
          provenance: "composio",
        },
      });

      /*
       * Refreshed now for the reason the paths above are: the page that enabled the app can show
       * what it offers, and a broker that will not list it says so here rather than at first use.
       *
       * ONTO THE ANSWERING ROW, which is the site this whole block is about. `mcp_tools.server_id`
       * is what {@link probeActionFor} reads actions by and what {@link listServers} joins them on,
       * and every brokered caller hands those the id resolved above — so actions written under the
       * composed name are actions nothing in the brokered path can see.
       */
      await this.refreshTools(answering);
      const added = (await this.listServers()).find(
        (server) => server.id === answering,
      );
      if (!added) throw new CatalogueEntryUnknownError(answering);
      return added;
    },

    /**
     * Remove a server, and stop every secret it was reached with being live.
     *
     * TWO KINDS OF SECRET, and both have to go. The server's own credential is whatever
     * `mcp_servers.credential_id` names — a `mcp` bearer token an administrator added, or, for a
     * `user-oauth` vendor, the deployment's OAuth client, keyed `oauth-client-<serverId>`. Nothing
     * else revokes it, so leaving it behind means re-adding the same server meets its own abandoned
     * row on `credentials_active_key_idx`.
     *
     * The other kind is every PERSON'S grant for this server, keyed `mcp_user_token` on the server id.
     * `mcp_user_credentials` cascades on the server row, so removing the connector used to delete
     * every pointer and leave every refresh token live and unreferenced: reachable from no screen,
     * revoked by no operation, and still a usable grant at the vendor. "We removed the connector" has
     * to be true of the thing that matters, which is the token sitting at the vendor.
     *
     * Revoked rather than deleted, because the vault keeps revoked rows for audit.
     *
     * A THIRD KIND OF ACCESS THAT IS NOT A SECRET. A brokered app holds no per-person secret at all
     * — Composio keeps the accounts and the deployment sends a user id — so the only thing standing
     * between a person and their mailbox is a `composio_connections` row, and that table references
     * nothing that would cascade it. Removing the app therefore left every one of them behind, and
     * adding the app back turned them live again without anybody being asked. That row goes too —
     * and before it goes, the account it stands for is ended at Composio, because clearing the row
     * alone shuts a gate and leaves the mailbox attached. The deployment's auth config for the app
     * goes last, once nobody is connected to it any more.
     *
     * The revokes go first. These are writes on two tables and the store exposes no transaction that
     * spans both, so the order decides what a failure between them leaves: revoke-then-delete leaves
     * a server whose secrets no longer work and which removing again will finish off, while
     * delete-then-revoke leaves live secrets no server references and no operation can reach.
     */
    async removeServer(serverId: string, by: string): Promise<void> {
      const [existing] = await database
        .select({
          credentialId: mcpServers.credentialId,
          // Read so the brokered connections below can be keyed on the app the url names, which is
          // the same key the call gate uses. See there for why the row id will not do.
          provenance: mcpServers.provenance,
          url: mcpServers.url,
          // The third of what `accessFor` resolves a row with. See there.
          authScheme: mcpServers.authScheme,
        })
        .from(mcpServers)
        .where(eq(mcpServers.id, serverId));

      /**
       * Whether that token is still live, read rather than inferred from a
       * thrown error, so a token a previous attempt already revoked, or one
       * whose row is gone entirely, is skipped while a database fault still
       * propagates and leaves the server row in place to be removed again.
       *
       * Two queries rather than a join because `mcp_servers.credential_id` is
       * `text` and `credentials.id` is `uuid`, so the two columns do not
       * compare without a cast.
       */
      const [live] = existing?.credentialId
        ? await database
            .select({ id: credentialRows.id })
            .from(credentialRows)
            .where(
              and(
                eq(credentialRows.id, existing.credentialId),
                isNull(credentialRows.revokedAt),
              ),
            )
        : [];

      if (live) {
        await credentials.revoke(live.id);
        await recordAuditEvent(auditStore, {
          eventType: "credential.revoked",
          targetType: "credential",
          targetId: live.id,
          payload: {
            actor: by,
            reason: "mcp_server_removed",
            server: serverId,
          },
        });
      }

      /*
       * Every person's grant for this server, read out of the VAULT rather than through the join
       * table.
       *
       * `credentials.provider` holds the server id for an `mcp_user_token`, so the vault can be asked
       * directly — which matters because the join row is the thing about to be cascaded away, and a
       * grant whose pointer has already gone (a person removed earlier) would otherwise be invisible
       * here too. The same argument `retireConnectionsFor` makes from the other direction.
       */
      const held = await database
        .select({ id: credentialRows.id, keyId: credentialRows.keyId })
        .from(credentialRows)
        .where(
          and(
            eq(credentialRows.kind, "mcp_user_token"),
            eq(credentialRows.provider, serverId),
            isNull(credentialRows.revokedAt),
          ),
        )
        .orderBy(asc(credentialRows.keyId));

      for (const grant of held) {
        await credentials.revoke(grant.id);
        await recordAuditEvent(auditStore, {
          eventType: "mcp.account_disconnected",
          targetType: "mcp_server",
          targetId: serverId,
          payload: {
            actor: by,
            server: serverId,
            // Whose it was. `key_id` holds the user id for this kind, and it is the only place left
            // to read it from once the join row has been cascaded away.
            owner: grant.keyId,
            /*
             * Not "they disconnected" and not "they were removed": an administrator took the whole
             * connector away, and the person did nothing. An auditor asking what happened to their
             * access should see which of the three this was.
             */
            reason: "mcp_server_removed",
            vendorRevocationRequested: false,
          },
        });
      }

      /*
       * The third kind of access, which is not a secret at all: everybody's brokered connection.
       *
       * CRITERION. Removing an app must leave nobody holding brokered access to it, so that adding
       * it back again grants nothing until each person has consented afresh.
       *
       * REASON. `composio_connections` is the whole gate on a brokered call and it references
       * nothing — not `mcp_servers`, not `users` — so nothing cascaded it and removing the app left
       * every row standing. Two ordinary administrative acts, remove and add back, then restored
       * everybody's access at a url the second act chose, with nobody asked again and no screen
       * saying it had happened. Consent that reattaches by itself is not consent.
       *
       * KEYED ON THE APP THE URL NAMES, exactly as `connectionTokenFor` keys the gate. `row.id` is a
       * display key and nothing holds it equal to the slug in the url, so a delete by id would clear
       * some other app's connections, or none, for the very row shape that gate already refuses to
       * trust. `accessFor` is asked rather than the url parsed here, so this cannot drift from it.
       *
       * ASKED WITH NO ENTRY, deliberately, and that is not the entry-wins order being dodged. An
       * entry can only ever SUPPRESS this answer — `accessFor` returns a null toolkit for every row
       * that has one — so passing the entry a colliding id looks up would hide the brokered state of
       * the one row most in need of clearing, and would now refuse outright the very row this method
       * exists to get rid of, leaving the collision unremovable. Nothing is dialled here, so there is
       * no vendor for an entry to protect; the only question is which app's consent rows this row's
       * own url stands for.
       *
       * Before the server row goes, for the reason the revokes above are: what a failure between
       * two writes leaves has to be the recoverable half. A connection cleared with the app still
       * present is fixed by removing it again; an app deleted with the connections standing is
       * reachable by no operation at all, because the toolkit was only ever readable off its url.
       *
       * AND THE ACCOUNT IS ENDED AT THE VENDOR, not merely forgotten here. Deleting the row closes
       * the gate this deployment owns and does nothing whatever to the account: the person's
       * mailbox stays attached at Composio, the grant stays live, and an administrator who pressed
       * "remove" was told the connector was gone. So every connected person is revoked through the
       * broker first, exactly as {@link disconnectBrokered} revokes for one — the same
       * shape at the scale of an app.
       *
       * REVOKE BEFORE DELETE, ALWAYS, and the argument is the one that method makes. The row is the
       * only thing here that names which app this person connected, so a delete that ran first
       * would leave a failed revoke with nothing to revoke under: a live grant on somebody's
       * mailbox that no operation in this deployment can reach. The other order costs a repeat of
       * an administrative act nobody minds repeating. Dead and reachable beats live and
       * unreachable.
       *
       * WHICH MAKES THE FAILURE LOUD. Nothing is caught around the revokes: a broker that will not
       * answer ends this method with the rows still standing and the app still present, rather than
       * letting it report an ending that did not happen.
       *
       * THE AUTH CONFIG GOES LAST, after every account is dead and every row is gone, for the same
       * reasoning one step out. An orphaned auth config grants nobody anything — it is a shape this
       * deployment holds at Composio, not an account — while a live account whose config has
       * already been deleted is access that nothing left here can end.
       */
      const toolkit = existing ? accessFor(existing, null).toolkit : null;

      if (toolkit) {
        /*
         * Read before anything is deleted, because the revokes below need the people and the rows
         * are where the people are. Sorted, so two removals of the same app revoke in the same
         * order and write their trail rows in the same order.
         */
        const connected = await database
          .select({
            holder: brokeredConnections.holder,
            userId: brokeredConnections.userId,
            vendorUserId: brokeredConnections.vendorUserId,
          })
          .from(brokeredConnections)
          .where(
            and(
              eq(brokeredConnections.provider, "composio"),
              eq(brokeredConnections.app, toolkit),
            ),
          )
          .orderBy(
            asc(brokeredConnections.holder),
            asc(brokeredConnections.userId),
          );

        /*
         * BOTH HOLDERS, EACH NAMED AS WHAT IT IS. Removing an app ends every account standing for
         * it — every person's own, and the one the deployment holds if the app was ever Shared,
         * which may still be standing after a switch back that has not retired it yet. Each is
         * revoked as the account its row says it is, under the vendor id the row was filed under,
         * so the deployment's account is asked for as the deployment's and never as whoever
         * pressed "remove". A person row always carries its user id (the table's holder check),
         * so the fallback to the deployment form below is the shape a corrupt row would need, not
         * a reading anything here relies on.
         */
        const accountOf = (
          connection: (typeof connected)[number],
        ): AccountRef =>
          connection.holder === "person" && connection.userId !== null
            ? {
                holder: "person",
                userId: connection.userId,
                vendorUserId: connection.vendorUserId,
              }
            : { holder: "deployment", vendorUserId: connection.vendorUserId };

        /*
         * What the broker was actually asked for each of them, kept so the trail below records the
         * answer rather than the call. False where there is no broker at all: a deployment whose
         * key has since been unset can still remove the app, and it could not have been calling it
         * either way — but nothing was asked of Composio and the row must not claim otherwise.
         */
        const vendorRevocationRequested: boolean[] = [];
        for (const connection of connected) {
          vendorRevocationRequested.push(
            broker
              ? await broker.revoke({ account: accountOf(connection), toolkit })
              : false,
          );
        }

        await database
          .delete(brokeredConnections)
          .where(
            and(
              eq(brokeredConnections.provider, "composio"),
              eq(brokeredConnections.app, toolkit),
            ),
          );

        for (const [index, connection] of connected.entries()) {
          await recordAuditEvent(auditStore, {
            eventType: "mcp.account_disconnected",
            targetType: "mcp_server",
            /*
             * THE APP, not this row's id, and the same key `retireConnectionsFor` files under.
             *
             * CRITERION. Every `mcp.account_disconnected` row a brokered connection produces is
             * keyed on the app at the broker, whichever act produced it, so one query answers
             * what happened to one person's brokered access.
             *
             * REASON. The two acts that can end such a connection were keyed differently: this
             * one on `mcp_servers.id`, offboarding on `composio_connections.toolkit` — which is
             * all that row records and all that is left once the server row is gone. Nothing
             * holds the two strings equal, so on any renamed row half the trail is filed under a
             * name the other half never mentions, and the disagreement is invisible everywhere
             * they happen to match.
             *
             * THE APP IS WHAT WAS CONSENTED TO. The gate is `(toolkit, user_id)`, the delete
             * above is by toolkit, and the row outlives the server row entirely; the id is a
             * display key that may not exist by the time somebody asks. Which server row was
             * removed is not lost — the `configuration.changed` row written below names it.
             */
            targetId: toolkit,
            payload: {
              actor: by,
              server: toolkit,
              // Whose account this was, by the rule {@link disconnectBrokered} names it by: a
              // person's own under their id, the deployment's own as the deployment, never as
              // the administrator who removed the app.
              owner:
                connection.holder === "person" && connection.userId !== null
                  ? connection.userId
                  : "deployment",
              // The same three-way distinction the vault loop above draws, and the same answer: an
              // administrator took the whole app away and the person did nothing.
              reason: "mcp_server_removed",
              /*
               * What was asked of the vendor, not that a call was made — {@link
               * ComposioBroker.revoke}'s own answer, passed through. True where an account was
               * found and its withdrawal asked for, false where there was none to withdraw or
               * where this deployment has no broker to have asked. The value of the field is
               * exactly that a reader can tell an account this deployment acted on from one that
               * outlives it somewhere else, so a constant here would be worse than none. It says
               * "requested" because that is the strongest thing the vendor's answer supports:
               * the upstream withdrawal runs as a background job nothing here can poll.
               */
              vendorRevocationRequested:
                vendorRevocationRequested[index] ?? false,
            },
          });
        }

        // Last of all, for the reason above, and skipped entirely on a deployment with no
        // broker to have made one.
        if (broker) await broker.deleteAuthConfig(toolkit);
      }

      const released = await database.transaction(async (transaction) => {
        const removed = await transaction
          .delete(pluginGrants)
          .where(
            and(
              eq(pluginGrants.kind, "mcp"),
              eq(sql`split_part(${pluginGrants.ref}, '/', 1)`, serverId),
            ),
          )
          .returning({ ref: pluginGrants.ref, agentId: pluginGrants.agentId });
        await transaction.delete(mcpServers).where(eq(mcpServers.id, serverId));
        return removed.sort((left, right) => left.ref.localeCompare(right.ref));
      });

      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "mcp_server",
        targetId: serverId,
        payload: {
          actor: by,
          change: "mcp_server_removed",
          server: serverId,
          ...(released.length > 0
            ? {
                releasedGrants: released.map((grant) => grant.ref),
                bots: [...new Set(released.map((grant) => grant.agentId))],
              }
            : {}),
        },
      });
    },

    /**
     * Ask a server what it offers and replace what we hold.
     *
     * Replaced wholesale, never merged. A tool a vendor withdrew has to stop being offered, and a
     * merge would leave it in the list forever as a name the model will happily call.
     *
     * `actorId` is who is asking, and whether it is needed at all is the transport's answer rather
     * than an assumption here. Where listing means asking a remote server — MCP — a `user-oauth`
     * vendor has no deployment credential to ask with, so the listing runs on the grant of whoever
     * pressed refresh, and an administrator who has not connected gets a refusal that lands in
     * `lastError`. That is the honest state: until somebody has connected, this deployment genuinely
     * does not know what that server offers.
     *
     * Where the tool list is this deployment's own code, nothing is asked and no credential is
     * consulted. Requiring one anyway is what made setting Drive up a round trip through an
     * administrator's personal settings page for a token that was then discarded.
     *
     * Absent for the refresh that happens right after a server is added, where nobody can have
     * connected yet. It makes no difference to a `deployment-bearer` server, which never consults it.
     */
    async refreshTools(
      serverId: string,
      actorId = "",
    ): Promise<{ tools: number }> {
      const { row, entry, access } = await requireServer(serverId);

      /*
       * Who the trail says asked for this listing, which is not the same value as who to list AS.
       *
       * CRITERION. The two audit rows below must never name an actor of `""`.
       *
       * REASON. `actorId` does double duty: it selects the person's credential where listing needs
       * one, and it is copied into those rows. The add paths pass neither, deliberately — nobody can
       * have connected an app in the second it is added, and the comment above this method says why
       * requiring one there was wrong. So the absence is permanent and correct for the credential,
       * and meaningless for the trail, which was left writing `actor: ""` on every row an add
       * produced. The deployment refreshing on its own behalf is a real answer and `reachedAs`
       * already spells it that way; see {@link DEPLOYMENT_ACTOR}. Held separately rather than
       * defaulting the parameter, because defaulting it would hand `connectionTokenFor` a person
       * called "deployment" to look a grant up by.
       */
      const auditActor = actorId || DEPLOYMENT_ACTOR;

      // How a row is reached is resolved once, in `requireServer`. Derived from the entry here,
      // a Composio app — which has no entry — was dialled as MCP at `composio://gmail`.
      const transport = transportFor(access.transport);

      /*
       * A brokered row with no app in its url has nobody to ask, and saying so is not the transport's
       * job.
       *
       * CRITERION. A listing this deployment could not even attempt must not be committed as a
       * refresh, and must not be written down as a vendor's answer.
       *
       * REASON. `accessFor` answers `brokered` for every row whose provenance column says so, and
       * reads the app slug off the url — so `{ credential: "brokered", toolkit: null }` is a real
       * state, which a hand edit or a restored backup produces and nothing in the product does.
       * `connectionTokenFor` already refuses it, but only where listing needs a credential, and a
       * brokered listing needs none: the broker publishes an action's schema to anybody. So the gate
       * was skipped on exactly the path that reaches the vendor with no app named, and the transport
       * answered `[]` — indistinguishable, one line later, from an app that advertises nothing.
       *
       * READ AS FIELDS, not as a transport. `credential` and `toolkit` are both resolved in
       * `access.ts` and this asks nothing about which protocol is underneath: any broker reached
       * without an app named is unroutable, which is the property `toolkit` is documented to carry.
       * A `transport === "composio"` test here would put back the per-call-site derivation that
       * module exists to have removed.
       */
      if (access.credential === "brokered" && !access.toolkit) {
        throw new PluginInvariantError(
          `${row.id} resolves to a brokered credential with no app in its url, so there is nothing to ask what it offers.`,
        );
      }

      /*
       * ASKING THE VENDOR, and the only part of this method whose failure is a vendor's.
       *
       * CRITERION. What lands in `lastError` must be something a vendor, a credential or a person
       * could have caused. An invariant this deployment violated and a fault in its own database must
       * not read as a vendor misbehaving.
       *
       * REASON. This used to be one `try` around everything below as well — the wholesale replace,
       * the server-row update and both audit writes — with a `catch` that copied any message into
       * `lastError` and answered `{ tools: 0 }`. So a statement timeout, a duplicate-key refusal or an
       * `audit_events` insert that would not go in all reported a vendor that had in fact answered
       * correctly, and reported it beside actions the refresh had already committed. Narrowing that
       * by error class would be narrowing by prose; narrowing it by SHAPE is what this split does, so
       * a line added below cannot quietly acquire a vendor's excuse.
       */
      let listed: ListedTool[];
      try {
        /*
         * A credential only when listing actually needs one.
         *
         * Where it is needed, it is taken from the same selection the call path uses rather than by
         * decrypting `row.credentialId` — which is what this used to do, and which for a `user-oauth`
         * server would have sent the deployment's OAuth client secret to the vendor as somebody's
         * access token. One answer to "what token does this server get", and it cannot be a secret of
         * the wrong kind.
         *
         * Where it is NOT needed, asking anyway is not a harmless extra check. For a `user-oauth`
         * server that call refuses unless the person pressing the button has connected their own
         * account — so an administrator setting Drive up was blocked at "refresh tools" and sent to
         * their personal settings page to grant access, so that a token could be minted and handed to
         * a function that discards it. The gate outlived the reason for it.
         */
        const token = transport.listNeedsCredential
          ? (await connectionTokenFor(row, entry, actorId, access)).token
          : undefined;

        listed = await transport.listTools({
          url: effectiveUrl(row, entry),
          token,
          tokenHeader: tokenHeaderFor(entry),
        });
      } catch (error) {
        /*
         * Ours rather than a vendor's, asked as one question about the whole shelf.
         *
         * CRITERION. Nothing on the `isDeploymentFault` shelf is written into `lastError`, and
         * nothing raised from here carries a statement or a bound value.
         *
         * WHAT THIS USED TO BE, and why the difference is not cosmetic. It read `error instanceof
         * PluginInvariantError` — which was DEAD, and its own comment named two throws that cannot
         * arrive here: `connectionTokenFor` is only called when `transport.listNeedsCredential`,
         * which is false for `composio`, the only brokered transport, so the brokered narrowing
         * cannot fire inside this `try`; and the `person-oauth` narrowing is unreachable because
         * `accessFor` answers that credential only for a `user-oauth` entry. So the line could be
         * deleted with every test still green while the arrival it should have been catching —
         * a query of ours failing — went straight past it into the column below.
         *
         * A QUERY FAILURE IS THE REACHABLE ONE. `connectionTokenFor`'s vault read, its connection
         * lookup and its locked credential swap all run inside this `try` for an MCP listing, and
         * each throws a `DrizzleQueryError` whose message is the statement plus every value bound
         * to it. Recorded, that put a SQL dump in the column the Plugins page draws, under a
         * heading that says a vendor said it. Raised as an invariant of ours, with the driver's
         * complaint and none of the query.
         */
        if (isDeploymentFault(error)) {
          throw isQueryFailure(error)
            ? new PluginInvariantError(
                `${row.id}: asking this app what it offers failed on a query of this deployment's own, so nothing about the app was learned and nothing it holds was changed. ${databaseComplaint(error)}`,
              )
            : error;
        }

        /*
         * ASKED THROUGH THE ONE DOOR, like the `storableTools` catch forty lines below that writes
         * the same column.
         *
         * `McpServerError` in the old test was doing nothing — it extends `Error`, so the second arm
         * answered for it — and what the whole expression amounted to was
         * `error instanceof Error ? error.message : String(error)`, which is precisely the reflex
         * {@link reasonWithoutStatement} exists to replace: it reads `.message` directly and so walks
         * straight past {@link withoutStatement}.
         *
         * NOTHING REACHABLE CHANGES BEHAVIOUR HERE TODAY, and that is the reason to write it rather
         * than an argument against. The guard above answers every query failure before this line, so
         * the shape whose message must never travel cannot arrive by any path anybody can name. What
         * CAN arrive is a wrapper — `composio.listTools` rethrows `new Error(listingSentence(...))`,
         * and `listingSentence` falls through to the thrown message verbatim — and a wrapper carries
         * no `query` and no `params` of its own, so it is on nobody's shelf and answers to nobody's
         * check. "No thrower reachable today" was also true of the credential envelope before the
         * rotation path started writing one; the door costs nothing and does not need to be
         * rediscovered at the next site.
         */
        const message = reasonWithoutStatement(error);
        // The failure is recorded rather than thrown away, because a server with no tools and no
        // explanation reads as a server that offers nothing, and an operator would go looking in
        // the wrong place. The tools already held are left alone: a vendor being briefly
        // unreachable is not a reason to revoke what Bots are using.
        await database
          .update(mcpServers)
          .set({
            /*
             * Capped at the same 400 characters `callTool` caps its recorded failure at.
             *
             * Parts of this sentence come from a vendor, and it is drawn on the admin page — neither
             * is a promise about length, and the two paths that show a vendor's words to an operator
             * should not disagree about how much of them to keep.
             */
            lastError: message.slice(0, 400),
            updatedAt: new Date(),
          })
          .where(eq(mcpServers.id, serverId));
        return { tools: 0 };
      }

      /*
       * An empty listing never destroys what a real listing recorded.
       *
       * CRITERION ONE. An empty answer must not be committed as a healthy refresh where doing so
       * would delete actions this deployment holds, and must not clear `lastError`.
       *
       * CRITERION TWO. "This app advertises nothing" stays recordable: an app with nothing held has
       * nothing to lose, so the empty answer falls through to the replace below and commits — a
       * refresh stamp, no error, no actions.
       *
       * REASON. The replace below is a delete and an insert, so an empty answer committed here
       * deletes every `mcp_tools` row for the server, taking the recorded `effect`, `destructive`
       * and `version` with it. `version` is the one that cannot be reconstructed: `callTool` refuses
       * an action without it, so a refresh that reported success broke every subsequent call, and
       * the grants survived pointing at rows that no longer existed — absent from `listServers`, and
       * revived only by a later refresh that worked.
       *
       * WHAT USED TO REACH THIS LINE, and no longer does. `composio.listTools` once answered `[]`
       * for a url naming no app and for a deployment with no Composio client installed, neither of
       * which is a vendor's answer, and the second of those is the state of every real deployment.
       * Both throw now, so that particular arrival is closed at the seam rather than here. The guard
       * stays because its argument never depended on who sent the empty answer.
       *
       * KEPT RATHER THAN TRUSTED, and that asymmetry is the whole argument. Holding actions the vendor
       * has withdrawn is visible and reversible: the next listing replaces them. Deleting actions the
       * vendor never withdrew is neither — `mcp_tools` is shared, so it is every replica at once, and
       * only a refresh from a deployment that can actually reach the vendor puts it back. That holds
       * for any vendor that suddenly lists nothing, whatever made it do so, which is why removing
       * this would reopen the same data loss for a different reason.
       *
       * THE SEAM REQUIREMENT this leans on, and it is satisfied: a transport that could not ask
       * anybody must THROW rather than return `[]`. `composio.listTools` opens with two throws that
       * say which of the two it is — no app in the url, no client installed — and no transport has
       * an early `return []` left in it at all: `builtin-routines` answers a static list, and `mcp`
       * and `google-drive-rest` hand back only what a request returned. So an empty listing reaching
       * this line is a vendor's own answer, which is what the sentence below says. Nothing here asks
       * which transport it is talking to, and nothing has to: the requirement is met at each seam
       * rather than branched on here.
       */
      if (listed.length === 0) {
        const held = await database
          .select({ name: mcpTools.name })
          .from(mcpTools)
          .where(eq(mcpTools.serverId, serverId));

        if (held.length > 0) {
          await database
            .update(mcpServers)
            .set({
              // Named as the state it is, because "listed nothing" and "would not answer" send an
              // operator to different places, and reaching this line settles which one it was: a
              // listing that could not be made throws and lands in the `catch` above instead. So
              // this sentence must not send anybody to check their configuration — that is the
              // other state's sentence, written by the transport that refused. No
              // `toolsRefreshedAt`: that column says when this deployment last learned what the app
              // offers, and it did not learn it here.
              lastError: `This app was asked and answered with no actions at all, so the ${held.length} already recorded for it were kept rather than deleted. Check whether it still publishes them, then refresh again.`,
              updatedAt: new Date(),
            })
            .where(eq(mcpServers.id, serverId));
          // What the app advertises, which is what it advertised before: the honest count, because
          // nothing was replaced.
          return { tools: held.length };
        }
      }

      /*
       * TURNING THE VENDOR'S ANSWER INTO ROWS, which is still the vendor's answer and so is still
       * caught.
       *
       * CRITERION. Nothing a vendor can put in a listing leaves this method as an uncaught throw,
       * and nothing a vendor can put in a listing half-applies the add that called it.
       *
       * REASON. Names are deduplicated and vendor text is made storable before a transaction is
       * opened on any of it, because both of those failures used to abort the replace from inside
       * one — see {@link storableTools}. Moving the work earlier moved the THROW earlier with it,
       * to a line between the two `try` blocks and covered by neither. A schema that this could not
       * make storable then left `refreshTools` raw: the refresh route has no mapping for it, so the
       * admin page got a bodiless 500 and `lastError` kept whatever it held before; and `addServer`
       * refreshes before it answers, so the add died AFTER its server row and its audit row had
       * committed, leaving a configured app nobody had finished configuring.
       *
       * RECORDED RATHER THAN RAISED, which is the same answer the vendor `try` gives, because this
       * is the same kind of event: the app was reached, it answered, and its answer is not something
       * this deployment can write down. The actions it already holds are kept, no `toolsRefreshedAt`
       * is stamped — nothing was learned — and the add completes with the failure on the row for an
       * administrator to read.
       *
       * `withoutStatement` rather than `error.message`, so that the one shape whose message must
       * never travel cannot reach the column even from a line that should never produce one.
       */
      let storable: ReturnType<typeof storableTools>;
      try {
        storable = storableTools(serverId, listed);
      } catch (error) {
        const reason =
          error instanceof Error ? withoutStatement(error) : String(error);
        await database
          .update(mcpServers)
          .set({
            // Capped where every other quoted failure in this file is capped, and for the same
            // reason: part of this sentence comes from elsewhere and none of it is a promise about
            // length.
            lastError:
              `This app answered with an action whose schema could not be stored as it arrived, so the actions already recorded for it were kept rather than replaced. ${reason}`.slice(
                0,
                400,
              ),
            updatedAt: new Date(),
          })
          .where(eq(mcpServers.id, serverId));
        return { tools: 0 };
      }

      /*
       * COMMITTING WHAT THE VENDOR SAID. Nothing from here down is a vendor's doing, so nothing
       * from here down is recorded as one — see the criterion on the vendor `try` further up, and
       * the one on the `try` immediately above this, which is the last thing here that still is.
       *
       * ONE STEP, because the paragraph above promises the held actions are left alone.
       *
       * "The tools already held are left alone" is only true while nothing has been written yet.
       * As two auto-committed statements the delete landed on its own whenever the insert did not:
       * a pod killed mid-refresh, a dropped connection, a statement timeout — or, with no crash at
       * all, a server that answers `tools/list` with the same `name` twice, which `mcp_tools`'
       * `(server_id, name)` primary key refuses as one multi-row insert. `mcp_tools` is shared, so
       * that is every replica at once, and nothing repopulates it: `refreshTools` is only ever
       * called by `addServer`, `addCustomServer` and an administrator pressing Refresh. The
       * connector kept every grant an administrator had made and offered none of them, and
       * `grantedToolGuidance` then told the Bot outright that it holds none of that vendor's tools.
       *
       * Rolled back together, the Bots go on using what they were granted — and the fault raises
       * rather than being copied into `lastError`, because a transaction this database would not take
       * is not something the vendor did.
       */
      try {
        await database.transaction(async (transaction) => {
          await transaction
            .delete(mcpTools)
            .where(eq(mcpTools.serverId, serverId));
          if (storable.length > 0) {
            await transaction.insert(mcpTools).values(storable);
          }
        });
      } catch (error) {
        /*
         * A database failure, with the statement and its parameters left behind.
         *
         * CRITERION. Nothing raised from here carries the SQL or the values bound to it.
         *
         * REASON. drizzle wraps every failure as a `DrizzleQueryError`, whose message is
         * `Failed query:` followed by the whole statement and then every parameter — here, the
         * vendor's entire tool list. That message is what an unhandled throw puts in the logs and
         * what any caller that prints an error puts on a screen. A SQL dump on an error path is
         * the same disclosure shape as a credential leak one layer out, and it is gratuitous: the
         * driver's own complaint says what went wrong without any of it.
         *
         * RAISED, NOT RECORDED, which is what the paragraph above this transaction argues for and
         * is now true rather than merely intended: with duplicate names and unstorable text
         * removed before the statement is built, what is left is this database refusing something
         * this deployment's own schema says it will take, and `lastError` is where a VENDOR's
         * answer goes.
         */
        throw new PluginInvariantError(
          `${row.id}: the actions this app listed were not stored, so what it already had is unchanged. ${databaseComplaint(error)}`,
        );
      }

      await database
        .update(mcpServers)
        .set({
          toolsRefreshedAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(mcpServers.id, serverId));

      /*
       * A grant left pointing at nothing goes in the trail, at the moment it starts pointing at
       * nothing.
       *
       * Reporting it on a screen answers "what is true now", which somebody has to go and look at.
       * This answers "when did it stop being offered, and what was holding it" — the question asked
       * after a transport is swapped back and a name starts resolving again. Without the row, the
       * only record of the gap is its absence.
       *
       * Not a refusal and not an error, so `configuration.changed` rather than a new event type:
       * nothing was denied and the refresh succeeded. Written after the tool list is replaced, so
       * what it names is what is actually left over — and only ever after a listing that was
       * committed, because the guard above returns before this on an empty answer that would have
       * named every grant the app holds.
       */
      // The names as STORED, so a grant is compared against a row that exists: a duplicate the
      // vendor listed twice is one row, and a name is spelled here the way the insert spelled it.
      const advertised = new Set(storable.map((tool) => tool.name));
      const stranded = [...(await mcpGrantsForServers([serverId])).entries()]
        .filter(([ref]) => !advertised.has(ref.slice(serverId.length + 1)))
        .sort(([left], [right]) => left.localeCompare(right));

      if (stranded.length > 0) {
        await recordAuditEvent(auditStore, {
          eventType: "configuration.changed",
          targetType: "mcp_server",
          targetId: serverId,
          payload: {
            actor: auditActor,
            change: "grants_not_advertised",
            server: serverId,
            // The refs, because that is what a grant is keyed on and what an administrator revokes.
            refs: stranded.map(([ref]) => ref),
            bots: [...new Set(stranded.flatMap(([, agents]) => agents))],
            note: "Held by a Bot and not offered to any model, because this server no longer advertises the tool. Offered again if it starts.",
          },
        });
      }

      /*
       * Tools the vendor advertises that this deployment's write list does not name.
       *
       * The mechanical half of the reconciliation Notion's catalogue entry says is required. See
       * {@link unlistedAdvertisedTools} for why only that shape of vendor is named here: an
       * advertised tool absent from `writeTools` classifies as a READ, so an under-inclusive list
       * is silent, and for a vendor with no scope strings there is nothing else standing behind it.
       *
       * `configuration.changed` rather than a type of its own, the same as the stranded grants
       * above and for the same reason: nothing was denied and the refresh succeeded. What changed
       * is that the deployment now knows a name it had not classified.
       */
      const unlisted = unlistedAdvertisedTools(entry, [...advertised]);
      if (unlisted.length > 0) {
        await recordAuditEvent(auditStore, {
          eventType: "configuration.changed",
          targetType: "mcp_server",
          targetId: serverId,
          payload: {
            actor: auditActor,
            change: "unlisted_tools_advertised",
            server: serverId,
            tools: unlisted,
            note: "Advertised by this server and not named in its reviewed write list, so each is offered to models as a read. This vendor has no read-only scope behind that list, so anything here that writes should be added to the entry.",
          },
        });
      }

      // What was recorded, which is what "this app offers N actions" means on the page. Counting
      // the listing instead reported a duplicate the vendor named twice as two actions the
      // deployment holds, when `mcp_tools` holds one row for it.
      return { tools: storable.length };
    },

    async listServers(): Promise<ServerRecord[]> {
      const rows = await database
        .select()
        .from(mcpServers)
        .orderBy(asc(mcpServers.title));
      if (rows.length === 0) return [];

      const tools = await database
        .select()
        .from(mcpTools)
        .where(
          inArray(
            mcpTools.serverId,
            rows.map((row) => row.id),
          ),
        )
        .orderBy(asc(mcpTools.name));

      /*
       * Every grant on these servers, not only the ones matching a tool that is still advertised.
       * Asking about the advertised refs answers "who holds what is offered", which cannot report the
       * grants that are the point here — see `mcpGrantsForServers`.
       */
      const grants = await mcpGrantsForServers(rows.map((row) => row.id));
      const advertised = new Set(
        tools.map((tool) => `${tool.serverId}/${tool.name}`),
      );

      /*
       * HOW EACH APP CONNECTS, WHICH IS A FACT ABOUT THE APP AND NOT ABOUT THE ROW BESIDE IT.
       *
       * CRITERION. Every row here whose url names a Composio app reports the scheme
       * {@link brokeredAppScheme} answers for that app — so two rows at one url report one answer,
       * and it is the answer {@link connectBrokeredWithFields} will act on.
       *
       * REASON. The browser forks on this field: `brokered-account-row.tsx` draws a consent button,
       * a form or a "nothing to connect" sentence out of it, and the press then lands in a store
       * method that resolves the app by its URL. Reported off each row's own column those were two
       * readings of one fact — a form drawn from this row and a submission refused by the other
       * row's scheme, telling somebody to connect the app the way it asks for over an app they were
       * asked exactly that way. {@link serverAddress} answers the same field the same way, so the
       * page that lists an app and the route that connects it cannot come apart either.
       *
       * ONE EXTRA READ FOR THE WHOLE LIST, and none where the deployment has enabled no apps.
       */
      const brokeredApps = await brokeredAppRowsAt(
        rows.filter((row) => toolkitOf(row.url) !== null).map((row) => row.url),
      );

      /*
       * WHICH APPS THE DEPLOYMENT HOLDS AN ACCOUNT AT, IN ONE READ FOR THE WHOLE LIST. Keyed by
       * app rather than by server, because the account belongs to the app's url and not to a row:
       * two rows at one url are one Composio app with one deployment account behind it.
       */
      const deploymentHeld = new Set(
        (
          await database
            .select({ app: brokeredConnections.app })
            .from(brokeredConnections)
            .where(
              and(
                eq(brokeredConnections.provider, "composio"),
                eq(brokeredConnections.holder, "deployment"),
              ),
            )
        ).map((held) => held.app),
      );

      return rows.map((row) => {
        const entry = catalogueEntry(row.id);
        const toolkit = toolkitOf(row.url);
        return {
          id: row.id,
          title: row.title,
          logo: row.logo,
          vendor: row.vendor,
          url: effectiveUrl(row, entry),
          summary: entry?.summary ?? "",
          docsUrl: entry?.docsUrl ?? "",
          provenance: row.provenance,
          hasCredential: row.credentialId !== null,
          toolsRefreshedAt: iso(row.toolsRefreshedAt),
          lastError: row.lastError,
          addedBy: row.addedBy,
          dynamicClient:
            entry?.auth.kind === "user-oauth" &&
            entry.auth.clientRegistration === "dynamic",
          // The app's, for a row whose url names one; this row's own column for everything else,
          // which is a null on every server that is not brokered. See the read above.
          authScheme: toolkit
            ? (brokeredApps.get(row.url)?.authScheme ?? null)
            : row.authScheme,
          /*
           * The app's mode for the same reason as its scheme: a duplicate row at a Shared app's url
           * is the Shared app, and the memory ingestion decides whose account a source reads from
           * exactly these two fields.
           */
          accountMode: toolkit
            ? (brokeredApps.get(row.url)?.accountMode ?? null)
            : row.accountMode,
          sharedVendorConnected:
            toolkit !== null &&
            brokeredApps.get(row.url)?.accountMode === "shared" &&
            deploymentHeld.has(toolkit),
          tools: tools
            .filter((tool) => tool.serverId === row.id)
            .map((tool) => {
              const ref = `${tool.serverId}/${tool.name}`;
              return {
                serverId: tool.serverId,
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema as Record<string, unknown>,
                ref,
                effect: classifyTool(entry, tool.name, true, tool.effect),
                destructive: tool.destructive,
                grantedTo: grants.get(ref) ?? [],
              };
            }),
          /*
           * Sorted by ref so the list is stable between reads, which matters because this is the one
           * place a discrepancy is reported and a reader comparing two visits should see the same
           * order.
           */
          withdrawn: [...grants.entries()]
            .filter(
              ([ref]) => ref.startsWith(`${row.id}/`) && !advertised.has(ref),
            )
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([ref, grantedTo]) => ({
              ref,
              name: ref.slice(row.id.length + 1),
              grantedTo,
            })),
        };
      });
    },

    /**
     * Where one server is, by id, and nothing that hangs off it.
     *
     * WHY IT EXISTS BESIDE {@link listServers}. Three routes asked that one for a single row's url
     * — the brokered branch of connect, and the confirm and disconnect pair behind
     * `brokeredAppFor` — and it answers by running three queries and materialising every server,
     * every tool and every grant in the deployment. Confirm is the sharp end: both brokered account
     * screens call it from an effect on mount, so opening a large app's page read the whole tool and
     * grant table to ask whether one row is brokered. None of the three looks at a tool or a grant.
     *
     * THE URL IS THE ROW'S OWN, read out of the column rather than composed from the id. The whole
     * brokered feature rests on the two being allowed to differ: `addBrokeredApp` writes
     * `composio://<slug>` and names the row for it, but nothing holds them equal afterwards, and a
     * row called `gmail` at `composio://slack` is exactly the shape the connection gate was once
     * keyed on the wrong half of. The catalogue reconciliation {@link effectiveUrl} applies for
     * `listServers` is deliberately not applied here, and changes no answer: it only ever
     * substitutes the pinned host of a first-party entry, and neither reading of such a row names a
     * Composio app.
     *
     * `undefined` for an id naming no row, which is what the `.find` over the whole list answered
     * before — so a route that refused an unknown id still refuses it, in the same words.
     *
     * AND THE SCHEME IS THE APP'S, NOT THIS ROW'S, WHICH IS THE ONE FIELD HERE THAT IS NOT ABOUT A
     * ROW AT ALL.
     *
     * CRITERION. For a row whose url names a Composio app, `authScheme` is what
     * {@link brokeredAppScheme} answers for that app.
     *
     * REASON. The connect route forks on this field — a form for a key app, a consent link for a
     * consent one, a refusal for a no-auth one — and the store method that fork leads to,
     * {@link connectBrokeredWithFields}, reads the scheme off the row that answers for the APP. Two
     * rows may name one app, so those were two different reads of one fact: the page draws a form
     * off this row and the submission is refused by the other row's scheme, in a sentence telling
     * somebody to connect an app the way it asks for — over an app they were just asked exactly
     * that way. The id and the title stay this row's own, because those name the row the page
     * opened; the scheme is a fact about the app, and the app has one answer.
     *
     * `accountMode` IS THE APP'S FOR THE SAME REASON, off the same answering row and in the same
     * read, never this row's own column; a row that names no app has no mode and answers null.
     *
     * ONE EXTRA READ, AND ONLY FOR A BROKERED URL. A row that names no app takes the read it always
     * took.
     */
    async serverAddress(serverId: string): Promise<ServerAddress | undefined> {
      const [row] = await database
        .select({
          id: mcpServers.id,
          title: mcpServers.title,
          url: mcpServers.url,
          authScheme: mcpServers.authScheme,
        })
        .from(mcpServers)
        .where(eq(mcpServers.id, serverId))
        .limit(1);
      if (!row) return undefined;
      const toolkit = toolkitOf(row.url);
      if (!toolkit) return { ...row, accountMode: null };
      const app = await brokeredAppRow(toolkit);
      return {
        ...row,
        authScheme: app?.authScheme ?? null,
        accountMode: app?.accountMode ?? null,
      };
    },

    /**
     * Where every added server is, for the one caller whose question is about the whole set.
     *
     * A SECOND READ RATHER THAN {@link serverAddress} IN A LOOP, and rather than one method serving
     * both. The app directory asks which of Composio's apps are already enabled here, which has no
     * id to look up — answered a row at a time it would be one query per app in the directory. And
     * it needs strictly less than the row read hands back: the app comes off the url, so an id and
     * a title would be nothing but two fields a reader could take the app out of by mistake. The
     * directory route's own comment says why that matters — the url is where the transport reads
     * which app a call is against, and the id is a row name that happens to look similar.
     *
     * Ordered, so two readings of an unchanged deployment answer alike.
     */
    async serverUrls(): Promise<string[]> {
      const rows = await database
        .select({ url: mcpServers.url })
        .from(mcpServers)
        .orderBy(asc(mcpServers.id));
      return rows.map((row) => row.url);
    },

    /** Every account any holder has on a brokered app, as the broker would be asked to end it. */
    async accountsOn(
      serverId: string,
    ): Promise<{ toolkit: string; accounts: AccountRef[] } | null> {
      const [row] = await database
        .select({ url: mcpServers.url })
        .from(mcpServers)
        .where(eq(mcpServers.id, serverId))
        .limit(1);
      const toolkit = row ? toolkitOf(row.url) : null;
      if (!toolkit) return null;
      const held = await database
        .select({
          holder: brokeredConnections.holder,
          userId: brokeredConnections.userId,
          vendorUserId: brokeredConnections.vendorUserId,
        })
        .from(brokeredConnections)
        .where(
          and(
            eq(brokeredConnections.provider, "composio"),
            eq(brokeredConnections.app, toolkit),
          ),
        );
      return {
        toolkit,
        accounts: held.map(
          (row): AccountRef =>
            row.holder === "person"
              ? {
                  holder: "person",
                  userId: row.userId ?? "",
                  vendorUserId: row.vendorUserId,
                }
              : { holder: "deployment", vendorUserId: row.vendorUserId },
        ),
      };
    },

    /**
     * Write an app's mode and deployment identity — onto the row that ANSWERS for the app.
     *
     * Every reader takes these two columns off {@link brokeredAppRow}, so a write landing on a
     * duplicate row at the same url would be a switch nobody reads: the page would say Shared and
     * every call would go on running as it did. The id given is resolved to its url, the url to its
     * app, and the app to its answering row; a row that names no app is written as itself, which is
     * the only row there is to write.
     */
    async setAccountModeColumns(
      serverId: string,
      mode: AccountMode,
      sharedVendorUserId: string | null,
    ) {
      const [dialled] = await database
        .select({ url: mcpServers.url })
        .from(mcpServers)
        .where(eq(mcpServers.id, serverId))
        .limit(1);
      const toolkit = dialled ? toolkitOf(dialled.url) : null;
      const app = toolkit ? await brokeredAppRow(toolkit) : null;
      await database
        .update(mcpServers)
        .set({ accountMode: mode, sharedVendorUserId })
        .where(eq(mcpServers.id, app?.id ?? serverId));
    },
  };
}

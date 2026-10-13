import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { recordAuditEvent } from "../../audit";
import {
  type CredentialExecutor,
  CredentialUnusableError,
  decryptCredentialForUse,
  decryptSecret,
  encryptSecret,
} from "../../credentials";
import {
  brokeredConnections,
  credentials as credentialRows,
  mcpServers,
  mcpTools,
  mcpUserCredentials,
  pluginGrants,
  skillTools,
} from "../../db/schema";
import { accessFor, type ServerAccess } from "../access";
import { type Decides, type SchemeKind, schemeKind } from "../broker";
import { type CatalogueEntry, catalogueEntry } from "../catalogue";
import { toolkitOf } from "../composio";
import { registerDynamicClient } from "../oauth";
import {
  type AccountAnswer,
  type AccountMode,
  type AccountRef,
  accountFor,
} from "../shared-accounts";
import {
  CatalogueEntryUnknownError,
  CLIENT_REREGISTRATION_BACKOFF_MS,
  CustomServerRefusedError,
  exchangeRefreshTokenOverHttp,
  INVALID_CLIENT,
  isUsableClient,
  type OAuthClient,
  PluginInvariantError,
  type PluginKind,
  PluginRefusedError,
  type PluginStoreOptions,
  type StoredClient,
  TokenRefusedError,
  type Transaction,
} from "./model";

/**
 * What every group of plugin store methods shares: the options it was made with, and the helpers
 * and state (the token-exchange chains, the OAuth client locks) that used to live in one closure.
 * Made once per store by `createPluginStore`, so that state is still one per store.
 */
export function createStoreContext(options: PluginStoreOptions) {
  const { database, auditStore, credentials, encryptionKey } = options;
  /*
   * Held rather than resolved, because the transport is a property of the entry and is not known
   * until a call names one. An injected vendor still wins over both, which is what keeps a test able
   * to assert what a call was about to go out with.
   */
  const injectedVendor = options.callVendor;
  const exchangeRefreshToken =
    options.exchangeRefreshToken ?? exchangeRefreshTokenOverHttp;
  const registerClient = options.registerClient ?? registerDynamicClient;
  // No default, unlike the seams above: there is no real implementation in this tree to fall back
  // to, and a deployment with no Composio key is supposed to have no broker. See `./broker`.
  const broker = options.broker;

  /*
   * One exchange at a time per (server, person). A rotating vendor invalidates the refresh
   * token it was shown, so two concurrent calls that both present the old one would have the
   * second refused through no fault of anybody's. The chain serialises them; the map entry is
   * removed when the chain drains so the map cannot grow past the set of active connections.
   */
  const exchangeChains = new Map<string, Promise<unknown>>();
  function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = exchangeChains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    exchangeChains.set(key, next);
    /*
     * The refusal belongs to the caller, who is holding `next` and will see it. This branch exists
     * only to forget the key, so it swallows before it cleans up: `next.finally(…)` on its own
     * derives a SECOND rejected promise that nobody is holding, and a refused call — a withdrawn
     * credential, say — then surfaces as an unhandled rejection somewhere unrelated.
     */
    void next
      .catch(() => {})
      .finally(() => {
        if (exchangeChains.get(key) === next) exchangeChains.delete(key);
      });
    return next;
  }

  async function grantsFor(kind: PluginKind, refs: string[]) {
    if (refs.length === 0) return new Map<string, string[]>();
    const rows = await database
      .select()
      .from(pluginGrants)
      .where(and(eq(pluginGrants.kind, kind), inArray(pluginGrants.ref, refs)));
    const byRef = new Map<string, string[]>();
    for (const row of rows) {
      byRef.set(row.ref, [...(byRef.get(row.ref) ?? []), row.agentId]);
    }
    return byRef;
  }

  /**
   * Every MCP grant belonging to these servers, whether or not the tool is still advertised.
   *
   * {@link grantsFor} asks about refs somebody already has, which is the wrong question when the
   * point is to find the ones nothing else knows about: called with the advertised refs it can only
   * ever return a subset of them, so a grant on a withdrawn tool is invisible by construction.
   *
   * Matched on the server half in the query rather than by reading every grant and splitting here.
   * `split_part` rather than a `LIKE` prefix, because a server id is text a person can choose for a
   * custom server and `%` in one would silently widen the match.
   */
  async function mcpGrantsForServers(serverIds: string[]) {
    if (serverIds.length === 0) return new Map<string, string[]>();
    const rows = await database
      .select({ ref: pluginGrants.ref, agentId: pluginGrants.agentId })
      .from(pluginGrants)
      .where(
        and(
          eq(pluginGrants.kind, "mcp"),
          inArray(sql`split_part(${pluginGrants.ref}, '/', 1)`, serverIds),
        ),
      );
    const byRef = new Map<string, string[]>();
    for (const row of rows) {
      byRef.set(row.ref, [...(byRef.get(row.ref) ?? []), row.agentId]);
    }
    return byRef;
  }

  /** The refs each of these skills declares, keyed by skill id. Skills with none are absent. */
  async function toolsDeclaredBy(skillIds: string[]) {
    if (skillIds.length === 0) return new Map<string, string[]>();
    const rows = await database
      .select()
      .from(skillTools)
      .where(inArray(skillTools.skillId, skillIds))
      .orderBy(asc(skillTools.ref));
    const bySkill = new Map<string, string[]>();
    for (const row of rows) {
      bySkill.set(row.skillId, [...(bySkill.get(row.skillId) ?? []), row.ref]);
    }
    return bySkill;
  }

  /**
   * Which of these refs name a tool this deployment has actually seen.
   *
   * Asked when a skill is saved, so a typo is refused where it was written rather than becoming a
   * skill that quietly selects nothing. Not asked at run time: a refresh deletes and rewrites a
   * server's tool rows, so a ref can be legitimately absent for a moment, and a run must read that as
   * "load nothing" rather than as a failure.
   */
  async function knownToolRefs(refs: string[]) {
    if (refs.length === 0) return new Set<string>();
    // Narrowed in the query to the servers actually named, rather than reading the whole catalogue
    // and filtering here. A deployment aiming at a thousand tools should not scan all of them to
    // check three.
    const servers = [...new Set(refs.map((ref) => ref.split("/")[0] ?? ""))];
    const rows = await database
      .select({ serverId: mcpTools.serverId, name: mcpTools.name })
      .from(mcpTools)
      .where(inArray(mcpTools.serverId, servers));
    const known = new Set(rows.map((row) => `${row.serverId}/${row.name}`));
    return new Set(refs.filter((ref) => known.has(ref)));
  }

  /**
   * Who did it goes in the payload, never in `actorUserId`.
   *
   * That column is a foreign key to `users.id`, and everything here holds an email. Writing one
   * there does not fail loudly: the insert violates the constraint and the entire audit row is lost.
   */

  /**
   * A credential out of the vault, decrypted for one call and never held.
   *
   * A revoked credential is turned into a refusal rather than left as the vault's thrown error. The
   * two reach a person very differently: an error becomes "that tool could not be called", which is
   * what a vendor being down looks like, while a withdrawn grant is nobody's fault and has an
   * obvious next step. `reconnect` says which of the two to name.
   *
   * WHICH OF THE TWO IS DECIDED BY CLASS. {@link CredentialUnusableError} is the one thing the vault
   * raises that means the credential is gone, and everything else that can come out of this call is
   * a fault: a query this database refused, a connection it would not open, an envelope that would
   * not decrypt. Those are rethrown untouched, which puts a query failure on the
   * {@link isDeploymentFault} shelf where the four audiences already agree about it.
   *
   * WHAT THIS USED TO BE, and why the difference is not cosmetic. It asked whether `error.message`
   * CONTAINED "revoked" or "not found". drizzle's message for a failed query begins `Failed query:
   * select "encrypted_value", "revoked_at" from "credentials" …` — the column this very read selects
   * — so every database fault on the vault read matched the first substring and was converted into
   * `onRevoked`: a `PluginRefusedError`, which is the one class this codebase relays VERBATIM. A
   * Postgres that was down told the model the credential had been withdrawn, told a browser the same
   * through the routes that pass a refusal out as a 400, and wrote it into `mcp_servers.last_error`
   * for an operator to act on — sending somebody to re-add a credential that was never the problem
   * while the real fault was reported nowhere. The same argument {@link TokenRefusedError} carries a
   * `code` for: a decision that reads prose is one rewording away from being wrong in silence, and
   * this one did not even need the rewording.
   */
  async function secretFor(
    credentialId: string,
    onRevoked: string,
  ): Promise<string> {
    try {
      return await decryptCredentialForUse(
        encryptionKey,
        credentials,
        credentialId,
      );
    } catch (error) {
      if (error instanceof CredentialUnusableError) {
        throw new PluginRefusedError(onRevoked, null);
      }
      throw error;
    }
  }

  /**
   * The account a call, a connect or a check acts for, from the row and the person — never from a
   * request. A Shared app answers with the deployment's stored identity whoever asks.
   */
  async function accountRefFor(
    serverId: string,
    actorId: string,
  ): Promise<
    | { ref: AccountRef; title: string; mode: AccountMode; appId: string }
    | { refusal: string }
  > {
    const [dialled] = await database
      .select({
        title: mcpServers.title,
        provenance: mcpServers.provenance,
        url: mcpServers.url,
        authScheme: mcpServers.authScheme,
        accountMode: mcpServers.accountMode,
        sharedVendorUserId: mcpServers.sharedVendorUserId,
      })
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId))
      .limit(1);
    if (!dialled)
      return {
        refusal: `${serverId} is not an app this deployment has added.`,
      };
    /*
     * THE NAME IS THE DIALLED ROW'S; THE ACCOUNT IS THE APP'S.
     *
     * CRITERION. For a brokered row whose url names an app, the scheme, the mode and the deployment
     * identity are read off the row {@link brokeredAppRow} answers for that app, and `appId` names
     * that row. Only the title — the words a person is shown — comes from the row they dialled.
     *
     * REASON. The url carries no unique index, so a second row can sit at an app's url carrying
     * account columns of its own. Read off the dialled row, those columns let a duplicate decide
     * the account for the app: `personal` at a Shared app's url took a non-administrator through
     * Connect to a personal account on the team's app and took calls round the audience gate, and
     * `shared` at a Personal app's url sent a person's call out as the deployment. The connection
     * this decides is then looked up by toolkit, which is the app — so the decision has to be the
     * app's too, or its two halves are about different rows.
     *
     * A BROKERED ROW WITH NO ANSWERING ROW IS NOT AN APP ANY MORE. The dialled row sits at the url,
     * so only a removal racing this read gets here, and it is refused as the missing row is above.
     */
    const toolkit =
      dialled.provenance === "composio" ? toolkitOf(dialled.url) : null;
    const app = toolkit ? await brokeredAppRow(toolkit) : null;
    if (toolkit && !app)
      return {
        refusal: `${serverId} is not an app this deployment has added.`,
      };
    const row = app
      ? {
          title: dialled.title,
          provenance: dialled.provenance,
          authScheme: app.authScheme,
          accountMode: app.accountMode,
          sharedVendorUserId: app.sharedVendorUserId,
        }
      : dialled;
    const appId = app?.id ?? serverId;
    const answer = accountFor(row, actorId);
    type _RefDecides = Decides<
      AccountAnswer["kind"],
      {
        none: "refused here — there is no account to connect, check or end";
        person: "the actor, under their own id";
        deployment: "the deployment, under the identity minted when the app became Shared";
        ambiguous: "refused with accountFor's own sentence";
      }
    >;
    if (answer.kind === "none")
      return { refusal: `${row.title} needs no account.` };
    if (answer.kind === "ambiguous") return { refusal: answer.message };
    if (answer.kind === "person") {
      if (!actorId)
        return {
          refusal: `${row.title} runs in the account of the person asking, and this run is not attributed to anybody.`,
        };
      return {
        ref: { holder: "person", userId: actorId, vendorUserId: actorId },
        title: row.title,
        mode: "personal",
        appId,
      };
    }
    if (!row.sharedVendorUserId) {
      throw new PluginInvariantError(
        `${appId} is Shared and holds no deployment identity; switch it to Personal and back.`,
      );
    }
    return {
      ref: { holder: "deployment", vendorUserId: row.sharedVendorUserId },
      title: row.title,
      mode: "shared",
      appId,
    };
  }

  /** The WHERE clause for one account's row, by holder. */
  const accountRow = (toolkit: string, account: AccountRef) =>
    account.holder === "person"
      ? and(
          eq(brokeredConnections.provider, "composio"),
          eq(brokeredConnections.app, toolkit),
          eq(brokeredConnections.holder, "person"),
          eq(brokeredConnections.userId, account.userId),
        )
      : and(
          eq(brokeredConnections.provider, "composio"),
          eq(brokeredConnections.app, toolkit),
          eq(brokeredConnections.holder, "deployment"),
        );

  /**
   * The token one call goes out with, and whose it is — decided from `access.credential`, so that
   * this function and the audit row cannot disagree about whose account a call ran in.
   *
   * For a `deployment-token` server this is what it always was: the one credential an administrator
   * gave the server, used for everybody. A `none` server reaches the same branch and finds nothing
   * to decrypt, which is the right answer for an endpoint that takes no credential at all.
   *
   * For a `brokered` server there is no token here AT ALL. The deployment's one key belongs to the
   * transport and never travels through this function, so nothing here can leak it into a connection
   * object, an error or an audit row. What this function contributes instead is the two refusals
   * that have to happen before a call is spent at the broker: a run nobody is attributed for, and an
   * asker who has not connected the app — so a person is told their own next step rather than shown
   * the broker's error about an account it cannot find. A third refusal sits between those two, for
   * a brokered row whose url names no Composio app; nothing in the product creates such a row, so no
   * person's situation reaches it.
   *
   * For a `person-oauth` server it is the asker's own, and every branch that cannot prove it has the
   * asker's grant refuses. There is deliberately no fallback. A fallback is the one bug this design
   * exists to make impossible: answering out of whatever the deployment, or the last person to
   * connect, happened to be able to see — which returns a confident answer assembled from documents
   * the person asking cannot open, and looks exactly like a correct answer.
   *
   * Nothing is cached on any path, and only on the `person-oauth` one is that a decision. There, the
   * refresh token is exchanged for an access token per call and the access token is thrown away, so
   * there is no stored copy of anybody's access for a disconnect to have to find. That costs a round
   * trip to the vendor's token endpoint on every call, which is the price of revocation being
   * complete by construction rather than by cleanup. The other two paths have nothing to cache: a
   * `deployment-token` is decrypted out of the vault per call, and a `brokered` key is never held
   * here at all.
   */
  async function connectionTokenFor(
    row: {
      id: string;
      title: string;
      credentialId: string | null;
      /*
       * NO `authScheme` HERE, DELIBERATELY. The scheme that decides whether a brokered call needs a
       * connection row is the APP'S, read through `brokeredAppScheme` below — and this row's own
       * column is the near-miss that reading replaced. A field kept here for convenience would be
       * the wrong answer sitting in the parameter list of the function that must not use it.
       */
    },
    entry: CatalogueEntry | null,
    actorId: string,
    access: ServerAccess,
    /**
     * The mode a call's audience gate was decided about, where one was; see the check beside
     * {@link accountRefFor} below. Absent for a path with no such gate, the tool refresh.
     */
    gatedMode?: AccountMode | null,
  ): Promise<{ token?: string; vendorUserId?: string }> {
    /*
     * A brokered app, where the deployment holds one key and Composio keeps the accounts apart.
     *
     * Refused HERE rather than in the transport, for the two reasons the `user-oauth` branch below
     * is: a person gets a sentence naming the step they can take, and no call is spent at the
     * vendor finding out. The transport refuses an unattributed run again as a last line, so
     * deleting either that guard or this one has to turn a test red. The unconnected case has no
     * such twin: the transport has no notion of a connection at all, so the last line there is
     * Composio itself — which is what refusing locally earns its place for, since it turns the
     * broker's error about an account it cannot find into a sentence naming the person's own next
     * step.
     *
     * The throw between the two is a third refusal, but not one anybody can act on: it fires only
     * for a brokered row whose url names no Composio app, which nothing in the product can create.
     * It is what keeps this gate keyed on the app the url names, and its own comment says why
     * neither fallback is available.
     *
     * There is no token. The key belongs to the transport and never travels through this function, so
     * nothing here can leak it into a connection object, an error or an audit row.
     */
    if (access.credential === "brokered") {
      if (!actorId) {
        throw new PluginRefusedError(
          `${row.title} runs in the account of the person asking, and this run is not attributed to anybody.`,
          null,
        );
      }

      /*
       * Narrowing, and a refusal that is genuinely reachable.
       *
       * `access.toolkit` is the app slug read off this row's url in `access.ts`, and it is NULL
       * whenever that url does not name a Composio app — `accessFor` still answers `brokered` for
       * any row whose provenance column says composio, so `{ credential: "brokered", toolkit: null }`
       * is a state a hand-edited or restored row really produces. The test beside `accessFor`
       * asserts it, and `plugin-store.integration.test.ts` gates this branch end to end.
       *
       * A throw rather than a fallback, for the reason the `user-oauth` narrowing below throws: both
       * alternatives fail open. Falling back to `row.id` checks the connection against a spelling
       * nothing dials, and skipping the gate spends the deployment's shared key on a connector whose
       * whole purpose is to keep one person's account out of another's. The compiler forces SOME
       * narrowing here — drizzle's `eq` will not take `string | null` — but only the test named
       * above stops that narrowing from being the fallback.
       */
      if (!access.toolkit) {
        throw new PluginInvariantError(
          `${row.id} resolves to a brokered credential with no Composio app in its url.`,
        );
      }

      /*
       * AN APP THAT NEEDS NO AUTHENTICATION HAS NO ROW TO FIND, AND CANNOT EVER HAVE ONE.
       *
       * `brokered_connections` is the whole of the permission for a brokered call, and every row in
       * it means one thing: an account at this app was granted to this deployment — a person's own,
       * or for a Shared app the team account an administrator connected. A `NO_AUTH` app has no
       * account and no consent — Composio refuses even to hold an authorization config for one — so
       * nobody presses Connect and nothing could write the row.
       *
       * THE ALTERNATIVE WAS WRITING ONE ANYWAY, and it is worse than it looks. Offboarding reads
       * this table to find what to revoke, the audit trail reads it to say what somebody had, and
       * disconnect reads it to know what to end. Rows where no person consented and no account
       * exists are indistinguishable, a year on, from rows where somebody did.
       *
       * The scheme is the one RECORDED when the app was enabled rather than a fresh read of the
       * catalogue: a vendor that re-labels an app must not turn a gate off underneath a deployment
       * that is already running.
       *
       * AND IT IS THE APP'S RECORDED SCHEME, NOT THIS ROW'S, WHICH IS THE SAME KEYING THE GATE
       * BELOW ALREADY USES.
       *
       * CRITERION. Whether a brokered call needs a connection row is decided by the app the url
       * names, out of the one row that answers for it — see {@link brokeredAppRow}.
       *
       * REASON. This read `row.authScheme`, the column on whichever row the call was dialled
       * through, while the gate two lines down looks the connection up by TOOLKIT. Two rows may
       * name one app, so the two halves of one decision were about different rows — and this half
       * fails open: a duplicate row recording `NO_AUTH` at a key app's url skips the per-person gate
       * entirely, and the deployment's own Composio key runs a call for somebody who connected
       * nothing. The other direction merely refuses a call that could have gone through. A gate and
       * its exemption have to be keyed on the same thing, and the gate's key is the app.
       *
       * ONE SMALL READ PER BROKERED CALL, which is the price of that. `mcp_servers` holds one row
       * per connector on any deployment, and the call it guards is a network round trip to the
       * vendor.
       */
      if ((await brokeredAppKind(access.toolkit)) === "none") return {};

      /**
       * WHAT THAT GATE ANSWERS FOR EACH KIND OF APP, WRITTEN DOWN BECAUSE THE LINE ABOVE DOES NOT.
       *
       * Type-only and erased; see {@link Decides}. This was the ONE scheme read in the file that
       * compared a raw literal instead of asking {@link schemeKind}, so the vocabulary it decided on
       * was not the vocabulary it read: `NO_AUTH` was a CONSENT-kind scheme, and this line exempted
       * it from inside that member while every other consumer of `consent` demanded a row. One
       * member answered two ways is the drift a closed vocabulary exists to make impossible, and the
       * cost was paid next door — {@link confirmBrokeredConnection} asked the classifier, was told
       * `consent`, and wrote the verified connection row this gate and the connect route both exist
       * to keep out of that table. `none` is now its own member, and this asks for it by name.
       */
      type _NoAuthGateDecides = Decides<
        SchemeKind,
        {
          key: "demands a connection row, because a key app has an account to hold one";
          consent: "demands a connection row, because somebody consented and the row is that grant";
          none: "lets the call through with no row at all — there is no account, so there is nothing anybody could have granted";
          unreadable: "demands a connection row, which is the closed direction and the right one";
        }
      >;

      /*
       * Keyed on the app the call will run in, which is the one the url names, and on the account
       * the ROW says acts — the asker's own for a Personal app, the deployment's for a Shared one.
       *
       * `row.id` is a display key and nothing holds it equal to the slug in the url, so a row named
       * `gmail` at `composio://slack` passed this gate on a Gmail connection and then ran a Slack
       * action — the person having connected an app they were never asked about.
       */
      const resolved = await accountRefFor(row.id, actorId);
      if ("refusal" in resolved)
        throw new PluginRefusedError(resolved.refusal, null);
      /*
       * THE ACCOUNT MUST BE THE ONE THE AUDIENCE GATE WAS ASKED ABOUT.
       *
       * `callTool` decides whether to run the Shared audience gate off the app's mode as it read it,
       * and this reads the mode again. An administrator switching the app to Shared between the two
       * reads would otherwise send an ungated call out on the team account. Refused rather than
       * re-gated: the switch is rare, asking again is cheap, and a refusal cannot be the hole.
       */
      if (gatedMode && resolved.mode !== gatedMode)
        throw new PluginRefusedError(
          `${row.title} changed how it is shared while this call was being checked, so it was not called. Ask again.`,
          null,
        );
      const [connected] = await database
        .select({ vendorUserId: brokeredConnections.vendorUserId })
        .from(brokeredConnections)
        .where(accountRow(access.toolkit, resolved.ref))
        .limit(1);
      if (!connected) {
        throw new PluginRefusedError(
          resolved.ref.holder === "deployment"
            ? `${row.title} is shared across this deployment and no account is connected to it yet. Ask an administrator to connect it.`
            : `You have not connected your ${row.title} account. Connect it in Settings and ask again.`,
          null,
        );
      }
      /*
       * THE ROW'S IDENTITY, NOT A RECOMPUTED ONE. A shared account was connected under the id minted
       * when the app became Shared; reading it back here is what makes a later change to
       * DEPLOYMENT_ID unable to move the account a call lands in.
       */
      return { vendorUserId: connected.vendorUserId };
    }

    if (access.credential !== "person-oauth") {
      const token = row.credentialId
        ? await secretFor(
            row.credentialId,
            `${row.id} needs a credential this deployment no longer holds. An administrator has to add it again.`,
          )
        : undefined;
      return { token };
    }

    /*
     * Narrowing, not a second decision.
     *
     * `access.credential === "person-oauth"` is derived in `access.ts` from exactly this auth kind,
     * so the branch above has already established it — but the derivation runs through a lookup
     * table the compiler cannot follow back to `entry`. Nothing below re-decides whether this is a
     * per-person server; it only reads the OAuth details that kind carries.
     *
     * A throw rather than a fallback. If the descriptor and the entry ever did disagree, answering
     * out of the deployment's own credential is precisely the failure the comment above this function
     * says must be impossible.
     */
    if (entry?.auth.kind !== "user-oauth") {
      throw new PluginInvariantError(
        `${row.id} resolves to a per-person credential with no user-oauth catalogue entry.`,
      );
    }

    /*
     * The anonymous actor is the empty string, and an empty string must never match a row.
     *
     * `identifyActor` answers with `{ id: "" }` when it cannot resolve who is asking. Letting that
     * reach the lookup would mean a run nobody can be held accountable for picking up whichever
     * grant sorted first, so it is refused before the query rather than trusted to miss.
     */
    if (!actorId) {
      throw new PluginRefusedError(
        `${row.id} answers as the person asking, and this run is not attributed to anybody.`,
        null,
      );
    }

    /*
     * Whether this person has connected at all, which is a refusal worth reaching before anything
     * queues behind another call. WHICH credential they hold is read again inside the critical
     * section below, because a reconnection can move it while this call waits its turn — and even
     * when the row stays put, the secret inside it does not.
     */
    const [held] = await database
      .select({ credentialId: mcpUserCredentials.credentialId })
      .from(mcpUserCredentials)
      .where(
        and(
          eq(mcpUserCredentials.serverId, row.id),
          eq(mcpUserCredentials.userId, actorId),
        ),
      )
      .limit(1);

    if (!held) {
      throw new PluginRefusedError(
        `You have not connected your ${entry.title} account. Connect it in Settings and ask again.`,
        null,
      );
    }

    // Held before the critical section, because narrowing does not survive into a closure and this
    // is where the entry is known to be a `user-oauth` one.
    const { tokenUrl } = entry.auth;
    const { title } = entry;
    /*
     * Where to register again, for a vendor that issues its own clients — and undefined for one an
     * administrator registered with by hand, where there is nothing this deployment could do about a
     * client the vendor no longer honours.
     */
    const registrationUrl =
      entry.auth.clientRegistration === "dynamic"
        ? entry.auth.registrationUrl
        : undefined;

    /*
     * What to tell the person when the deployment holds no client they can be called on, in the
     * words of whoever can actually change that.
     *
     * A hand-registered client is an administrator's paperwork — they pasted it in from the vendor's
     * console, and only they can paste one in again. A self-registered one is nobody's paperwork:
     * there is no console entry to re-create, and the deployment introduces itself again the next
     * time somebody connects. Naming an administrator there would send the person to somebody with
     * no step to take, which is worse than saying nothing.
     */
    const noClient = registrationUrl
      ? `${title} has no OAuth client for this deployment, so this cannot be called. Connect ${title} again in Settings: the deployment registers itself with the vendor when somebody connects.`
      : `${title} has no OAuth client registered for this deployment, so this cannot be called. An administrator has to add one.`;
    const unusableClient = registrationUrl
      ? `${title} has no usable OAuth client for this deployment. Connect ${title} again in Settings: the deployment registers itself with the vendor on the next connect.`
      : `${title} has no usable OAuth client for this deployment. An administrator has to add one again.`;
    /**
     * What to say when the vendor has forgotten the client this person's grant was issued under.
     *
     * The same register as the two above, and the same instruction, because it is the same situation
     * from the person's side: nothing they can be called on. What is different is that the
     * deployment CAN do its half — introduce itself again — and has, by the time this is thrown. So
     * the sentence says that too, otherwise "connect again" reads as a thing to keep trying.
     *
     * Their refresh token is not carried across. A grant belongs to the client it was issued to (RFC
     * 6749 §6, §10.4), so re-presenting it under the new client is a request a conforming vendor
     * refuses — and one that only ever appears to work against a vendor whose acceptance would
     * itself be the vulnerability. A new consent is the only thing that produces a usable grant.
     */
    const clientReplaced = `${title} no longer recognises this deployment's OAuth client, so this cannot be called. The deployment has registered itself again — connect ${title} again in Settings.`;

    if (!row.credentialId) {
      // The person did their part; the deployment has not. Refused before anything queues, because
      // a deployment holding no client has the same answer for everybody asking.
      throw new PluginRefusedError(noClient, null);
    }

    /**
     * The client as the deployment holds it right now, or the refusal for holding none.
     *
     * Read from the server row each time rather than from the row this call came in with: a retry
     * that registered again — this connection's own, a moment ago — replaced it, and the pointer
     * carried in from before the queue names the evicted one.
     */
    async function currentClient(): Promise<StoredClient> {
      /*
       * When the client was stored comes back with it, from the vault row itself rather than from a
       * column of our own. It is what the retry below measures its backoff against, and a left join
       * keeps it one query: a server pointing at nothing is the refusal on the next line, and a
       * pointer to a row that is no longer there is `secretFor`'s to refuse.
       */
      const [server] = await database
        .select({
          credentialId: mcpServers.credentialId,
          registeredAt: credentialRows.createdAt,
        })
        .from(mcpServers)
        .leftJoin(
          credentialRows,
          eq(credentialRows.id, mcpServers.credentialId),
        )
        .where(eq(mcpServers.id, row.id))
        .limit(1);
      if (!server?.credentialId) {
        throw new PluginRefusedError(noClient, null);
      }
      /*
       * Decrypted outside the guard below, so that `secretFor`'s own refusal for a revoked or
       * missing row is not caught here and relabelled. Only the parse is guarded.
       */
      const decrypted = await secretFor(server.credentialId, unusableClient);
      let parsed: unknown;
      try {
        parsed = JSON.parse(decrypted);
      } catch {
        /*
         * Unreadable is the same as none, exactly as it is for {@link heldOAuthClient} and
         * {@link storedOAuthClient}: there is nothing here to present to a vendor. Those two answer
         * null because their callers are deciding whether a consent flow can start; this one is
         * already mid-call, and its every caller would have to turn a null into this same refusal
         * on the next line — so it raises it.
         *
         * THE PARSER'S OWN WORDS ARE NEVER CARRIED. `JSON.parse` reports failure by quoting the
         * input it choked on, and the input here is the DECRYPTED OAuth client. Rethrowing it puts
         * a fragment of the client secret — under Bun's parser, the whole of it when the stored
         * value is a bare token — into the `mcp.call_failed` payload and into
         * `mcp_servers.last_error`, two durable stores that the Plugins page draws for anybody who
         * can read it.
         *
         * A reader should conclude that the signal is not lost, only the bytes: `unusableClient`
         * says the deployment holds a client it cannot use, which is distinct from `noClient`'s
         * holding none, and it names connecting again as what replaces it. An operator can tell
         * the credential is broken; nobody learns what was in it.
         */
        throw new PluginRefusedError(unusableClient, null);
      }
      /*
       * The same refusal for a value that parsed and is not a client — see {@link isUsableClient},
       * which is where the criterion and the reason live, because all three readers share both.
       *
       * Raised rather than answered null, for the reason above: this caller is mid-call. It is the
       * third throw in a row here — `noClient`, then the parse, then this — and that is the shape
       * of the contract rather than a repetition to collapse. Each names a different state of the
       * deployment's credential, and only the sentence is shared between the last two.
       */
      if (!isUsableClient(parsed)) {
        throw new PluginRefusedError(unusableClient, null);
      }
      return { client: parsed, registeredAt: server.registeredAt };
    }

    /*
     * The exchange, one call at a time for this connection, reading the connection fresh inside.
     *
     * Both halves of what goes out are read in here rather than carried in from above, because both
     * can move while this call waits its turn. The refresh token rotates, and the token read a
     * moment ago is then already spent — presenting it would be refused by the vendor for no reason
     * the person could act on. The client is replaced by a re-registration, and presenting the
     * evicted one would have every queued call discover that separately and register around it.
     *
     * TWO things serialise this, and they are not redundant. The map above queues calls made in THIS
     * process; the row lock below serialises the whole deployment. Only the lock is a correctness
     * property — a second replica has a map of its own and is not in ours — and the map is what
     * keeps a burst of calls on one connection from piling N transactions onto that one row lock,
     * each of them holding a pooled connection while it waits its turn.
     *
     * An evicted client is handled AFTER the transaction rather than inside it. Nothing about
     * re-registering needs this person's lock — the client is per server — and doing it inside would
     * have a second pooled connection opened while this one holds a row lock, which is the shape the
     * pool note in `db/client.ts` is about.
     */
    return await serialized(`${row.id}:${actorId}`, async () => {
      /*
       * The client, read before the transaction opens rather than inside it.
       *
       * It is per SERVER and is not what the lock protects, and reading it here keeps the vault read
       * off a second pooled connection while this call holds one open for the whole exchange. Still
       * inside the critical section, so the ordering that matters is unchanged: a queued call reads
       * the client after whatever ran before it replaced it.
       */
      const stored = await currentClient();

      /*
       * The vault row, locked for as long as the token it holds is being spent.
       *
       * A rotating vendor kills the refresh token it was shown, so two replicas that both read the
       * stored token and both present it do not merely race: the second presentation looks to the
       * vendor like a stolen token being replayed, and refresh-token-reuse detection answers it by
       * revoking the whole token family. The connection is then bricked, and nobody did anything
       * wrong. `SELECT … FOR UPDATE` is what makes the second replica wait for the first, exactly as
       * a person reconnecting already waits (`credentials.rotate`).
       *
       * Yes, the lock is held across an HTTP call to the vendor — bounded by the exchange's own
       * timeout. That is the point rather than an oversight: the lock IS the cross-replica
       * serialisation, and a lock released before the exchange would serialise nothing.
       *
       * The read comes AFTER the lock, never before. A replica that woke from the lock and used a
       * token it had read on the way in would present the one the first replica just spent, which is
       * the very double-spend this exists to prevent.
       */
      try {
        return await database.transaction(async (transaction) => {
          const [current] = await transaction
            .select({
              credentialId: mcpUserCredentials.credentialId,
              scope: mcpUserCredentials.scope,
            })
            .from(mcpUserCredentials)
            .where(
              and(
                eq(mcpUserCredentials.serverId, row.id),
                eq(mcpUserCredentials.userId, actorId),
              ),
            )
            .limit(1);

          // Disconnected while this call was queued. The same sentence as above: nothing is broken,
          // and connecting again is the thing to do.
          if (!current) {
            throw new PluginRefusedError(
              `You have not connected your ${title} account. Connect it in Settings and ask again.`,
              null,
            );
          }

          const [locked] = await transaction
            .select({
              encryptedValue: credentialRows.encryptedValue,
              revokedAt: credentialRows.revokedAt,
            })
            .from(credentialRows)
            .where(eq(credentialRows.id, current.credentialId))
            .for("update");
          /*
           * A row that is gone or revoked, said the way `secretFor` says it: withdrawn access is
           * nobody's fault and connecting again is the step. Reached by a replica that waited here
           * while somebody disconnected, as well as by one that was told after the fact.
           */
          if (!locked || locked.revokedAt) {
            throw new PluginRefusedError(
              `Your ${title} access was withdrawn. Connect it again in Settings.`,
              null,
            );
          }
          const refreshToken = await decryptSecret(
            encryptionKey,
            locked.encryptedValue,
          );

          const minted = await exchangeRefreshToken({
            tokenUrl,
            client: stored.client,
            refreshToken,
          });

          /*
           * A vendor that sent nothing back, or sent back the token we presented, rotated nothing —
           * and writing either would be inventing a rotation, at the cost of a needless
           * re-encryption of every connection on every call.
           */
          if (minted.refreshToken && minted.refreshToken !== refreshToken) {
            /*
             * The vendor rotated the grant: the token we were just shown is now the only valid one.
             * Persisting it is not optional bookkeeping — failing to would strand the connection on
             * the next call — so a failure here refuses THIS call rather than returning an access
             * token whose refresh token is already spent.
             *
             * In this transaction, so it commits with the lock that made the exchange ours: written
             * outside it, the next replica in line would wake to the token this one just spent.
             */
            await rotateConnectionToken(
              {
                credentialId: current.credentialId,
                refreshToken: minted.refreshToken,
              },
              transaction,
            );
          }

          return { token: minted.accessToken };
        });
      } catch (error) {
        /*
         * Outside the transaction, so the row lock is already released and the vault read this does
         * is not a second connection held behind this one's.
         *
         * Rethrows anything that is not the vendor disowning our client, which is every ordinary
         * failure: a withdrawn grant, a vendor being down, a disconnect mid-queue.
         */
        return await refuseAndReplaceEvictedClient({
          error,
          clientRegisteredAt: stored.registeredAt,
          registrationUrl,
          serverId: row.id,
          refusal: clientReplaced,
        });
      }
    });
  }

  /**
   * The vendor has disowned this deployment's client: fix the deployment, refuse the call.
   *
   * `invalid_client` is the vendor saying the CLIENT is the problem, and for a client the deployment
   * issued to itself there is nobody to tell — no console entry an administrator could re-create, so
   * every connection to that server would otherwise sit behind a refusal nothing here can act on.
   * Introducing itself again is the same act as the first registration, and it is worth doing: it is
   * what makes the next CONSENT possible.
   *
   * IT DOES NOT MAKE THIS CALL POSSIBLE, and this function used to pretend otherwise. It registered a
   * new client and re-presented the same refresh token under it. A refresh token is bound to the
   * client it was issued to — RFC 6749 §6 has the token endpoint verify exactly that, and §10.4 is
   * why — so a conforming vendor refuses the retry, and the only vendor it can work against is one
   * whose acceptance would itself be the vulnerability. So the grant is never carried across, and the
   * person is told the one thing that helps: connect again.
   *
   * The re-registration is still bounded by {@link CLIENT_REREGISTRATION_BACKOFF_MS}, and that bound
   * is the whole protection here rather than a nicety. This runs for any non-admin's tool call, and
   * it REPLACES the client every other connection in the deployment is bound to; a vendor that is
   * simply down answers every exchange `invalid_client`, so without the window one outage would have
   * each call in turn rotate the deployment-wide client. A client younger than the window is the
   * product of the last refusal's re-registration, and is left exactly alone.
   *
   * Always throws. The refusal it raises when it did register is the caller's answer; anything it
   * cannot act on is rethrown untouched, because the vendor's own words are better than ours.
   */
  async function refuseAndReplaceEvictedClient(input: {
    error: unknown;
    /** When the client that was just refused was stored. */
    clientRegisteredAt: Date | null;
    registrationUrl: string | undefined;
    serverId: string;
    /** What to tell the person once the deployment has registered itself again. */
    refusal: string;
  }): Promise<never> {
    const { error, registrationUrl, serverId } = input;
    /*
     * The code, off the error itself. Never the sentence: that is written for a person, and a
     * recovery that read it would be one rewording away from silently never running again.
     */
    const code = error instanceof TokenRefusedError ? error.code : null;
    const { redirectUri } = options;
    if (code !== INVALID_CLIENT || !registrationUrl || !redirectUri) {
      throw error;
    }

    const registeredAt = input.clientRegisteredAt;
    if (
      registeredAt &&
      Date.now() - registeredAt.getTime() < CLIENT_REREGISTRATION_BACKOFF_MS
    ) {
      throw error;
    }

    const fresh = await registerClient({ registrationUrl, redirectUri });
    // The vendor would not have us either. The first refusal is the one worth reporting: it says
    // what actually stopped the call, where this one says what stopped the recovery.
    if (!fresh) throw error;

    await persistOAuthClient({ serverId, client: fresh, by: "deployment" });
    throw new PluginRefusedError(input.refusal, null);
  }

  /**
   * Point one person's connection at a new refresh token, revoking the one it replaces.
   *
   * For a person connecting, which is where a new row earns its keep: what they held before this is
   * still a live grant at the vendor, and the revocation is how it stops being one. A vendor's own
   * rotation is the other case entirely, and goes through {@link rotateConnectionToken}.
   *
   * Upserted on the pair, so it is the same act whether they are connecting or reconnecting. The
   * credential the row used to point at is revoked in the same breath: a refresh token nothing
   * points at is still a live grant at the vendor, and leaving it behind would mean somebody had two
   * valid grants and could only ever see one of them to withdraw it.
   *
   * Says whether it replaced something, which is the one fact the caller writing the trail needs
   * and cannot recover afterwards.
   *
   * ONE TRANSACTION, because these are two writes and one decision. The secret goes into the vault
   * and the connection row is pointed at it; separately, a failure between them leaves the pointer
   * naming the credential the rotation had just revoked — a connection that reads as live on the
   * settings page and refuses every call, with the person's actual grant retired and no way back to
   * it. `credentials.rotate` and `credentials.create` already accept the caller's executor for
   * exactly this, and the pointer write runs on the same one.
   */
  async function swapUserCredential(input: {
    serverId: string;
    userId: string;
    refreshToken: string;
    scope: string;
  }): Promise<{ replaced: boolean }> {
    const key = {
      kind: "mcp_user_token" as const,
      provider: input.serverId,
      keyId: input.userId,
    };
    const value = {
      ...key,
      metadata: { server: input.serverId, scope: input.scope },
      // Encrypted before the transaction opens: it is arithmetic, and it has no business happening
      // while a pooled connection is held open behind row locks.
      encryptedValue: await encryptSecret(encryptionKey, input.refreshToken),
    };

    return await database.transaction(async (transaction) => {
      /*
       * `credentials_active_key_idx` holds one live credential per key, so a second insert for the
       * same person and server would be refused. Asked of the key rather than of the connection row,
       * because the row can name a credential that has already been revoked while the key itself is
       * free, and it is the key the index constrains.
       */
      const live = await credentials.findLiveByKey(key, transaction);
      const stored = live
        ? await credentials.rotate(
            { ...value, previousCredentialId: live.id },
            transaction,
          )
        : await credentials.create(value, transaction);

      await transaction
        .insert(mcpUserCredentials)
        .values({
          serverId: input.serverId,
          userId: input.userId,
          credentialId: stored.id,
          scope: input.scope,
        })
        .onConflictDoUpdate({
          target: [mcpUserCredentials.serverId, mcpUserCredentials.userId],
          set: {
            credentialId: stored.id,
            scope: input.scope,
            updatedAt: new Date(),
          },
        });

      return { replaced: live !== null };
    });
  }

  /**
   * Carry a connection over to the refresh token the vendor rotated to.
   *
   * In place, in the vault row the connection already points at — deliberately NOT the swap
   * {@link swapUserCredential} performs. A rotating vendor issues a new refresh token on every
   * exchange, so a swap here would mint a row and revoke a row per tool call, forever, on the
   * hottest path there is. And the revocation would have nothing to withdraw: the token just spent
   * was dead at the vendor the moment it answered, so the only live grant is the one being written.
   *
   * Deliberately WITHOUT the `mcp.account_connected` row, for the same reason as ever: rotation is
   * the vendor's plumbing, not a person's act, and a trail that records it as one reads as a
   * re-consent that nobody performed.
   *
   * The scope and the row are left alone. Nothing about what the vendor granted has changed — only
   * which token presents it.
   */
  async function rotateConnectionToken(
    input: {
      credentialId: string;
      refreshToken: string;
    },
    /**
     * The transaction the caller spent the token in, and this write belongs to it.
     *
     * The caller holds a `FOR UPDATE` lock on the very row being written. On its own pooled
     * connection this write would be a second session waiting for a lock only the caller can
     * release, and the caller cannot release it while awaiting this — so it would hang to the
     * statement timeout rather than rotate.
     */
    executor?: CredentialExecutor,
  ): Promise<void> {
    await credentials.updateSecret(
      input.credentialId,
      await encryptSecret(encryptionKey, input.refreshToken),
      executor,
    );
  }

  /** The one vault key a server's OAuth client is ever stored under. */
  const oauthClientKey = (serverId: string) => ({
    kind: "mcp_oauth_client" as const,
    provider: serverId,
    keyId: `oauth-client-${serverId}`,
  });

  /**
   * One writer at a time for one server's OAuth client, across the whole deployment.
   *
   * Everything that stores a client reads "is there a live one" and then writes accordingly, and the
   * gap between those two used to be unserialised. `POST /connect` is `requireUser`, so two people
   * pressing Connect on a fresh connector is not a rare interleaving: both read no live client, and
   * then the second `create` meets the first on `credentials_active_key_idx` as a raw 23505 — a 500
   * where a consent URL belonged — or, when there was a client to replace, the second `rotate` finds
   * its own predecessor already revoked and says so.
   *
   * An ADVISORY lock rather than a row lock, because the thing being protected is the ABSENCE of a
   * row as much as a row: there is nothing to lock `FOR UPDATE` on a first registration. Held for
   * the transaction, so it is released by the commit or the rollback and never by us forgetting.
   *
   * `hashtext` collisions are harmless here. Two servers sharing a hash would take turns registering
   * clients, which is slower and not wrong.
   */
  async function withOAuthClientLock<T>(
    serverId: string,
    work: (transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    return await database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`oauth-client-${serverId}`}))`,
      );
      return await work(transaction);
    });
  }

  /**
   * {@link storedOAuthClient}'s question, asked on the caller's own transaction.
   *
   * The same question deliberately — the server row's pointer, and the row it names being live —
   * because the callback redeems against `oauthClientFor`, which reads exactly that. A read that
   * accepted a live client the server row does NOT name would hand somebody a consent screen for a
   * client the callback then cannot find, and the connect would fail after the vendor said yes.
   *
   * On the transaction rather than through `storedOAuthClient` because the caller is inside
   * {@link withOAuthClientLock} and holding a pooled connection: a read on a second connection would
   * be a session queueing behind sessions that cannot finish until it returns.
   */
  async function heldOAuthClient(
    transaction: Transaction,
    serverId: string,
  ): Promise<OAuthClient | null> {
    const [server] = await transaction
      .select({ credentialId: mcpServers.credentialId })
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId))
      .limit(1);
    if (!server?.credentialId) return null;

    const [held] = await transaction
      .select({
        encryptedValue: credentialRows.encryptedValue,
        revokedAt: credentialRows.revokedAt,
      })
      .from(credentialRows)
      .where(eq(credentialRows.id, server.credentialId))
      .limit(1);
    if (!held || held.revokedAt) return null;

    try {
      const parsed: unknown = JSON.parse(
        await decryptSecret(encryptionKey, held.encryptedValue),
      );
      // A value that parsed and is not a client is unreadable in the same way and for the same
      // caller — see {@link isUsableClient}. Null, because that is what this reader's caller acts
      // on: it goes and registers one, which is the answer to holding none.
      return isUsableClient(parsed) ? parsed : null;
    } catch {
      // Unreadable is the same as none: there is nothing to send anybody to consent with.
      return null;
    }
  }

  /**
   * The two writes that store a client, on one transaction: the vault row, and the pointer to it.
   *
   * One transaction because they are one decision. Separately, a failure between them leaves
   * `mcp_servers.credential_id` naming the credential the rotation had just revoked — a connector
   * that looks configured on every screen and cannot complete a consent flow.
   *
   * The caller is expected to hold {@link withOAuthClientLock}, which is what makes the read below
   * safe to act on.
   */
  async function writeOAuthClient(
    input: { serverId: string; client: OAuthClient },
    transaction: Transaction,
  ): Promise<{ replaced: boolean }> {
    const key = oauthClientKey(input.serverId);
    const value = {
      ...key,
      metadata: { server: input.serverId, clientId: input.client.clientId },
      encryptedValue: await encryptSecret(
        encryptionKey,
        JSON.stringify(input.client),
      ),
    };

    const live = await credentials.findLiveByKey(key, transaction);
    const stored = live
      ? await credentials.rotate(
          { ...value, previousCredentialId: live.id },
          transaction,
        )
      : await credentials.create(value, transaction);

    await transaction
      .update(mcpServers)
      .set({ credentialId: stored.id, updatedAt: new Date() })
      .where(eq(mcpServers.id, input.serverId));

    return { replaced: live !== null };
  }

  /**
   * The trail row for a client this deployment now holds.
   *
   * Written AFTER the transaction that stored it, not inside. The audit store has its own handle on
   * the database, so writing from inside would open a second pooled connection while the first is
   * held — the shape the pool note in `db/client.ts` warns about, and the one that turns a busy
   * deployment into a hang. A trail row lost to a crash in that window is a worse trade than a
   * deadlock, but only just, and this way round the client is at least the thing that is certain.
   */
  async function recordClientRegistered(
    input: { serverId: string; client: OAuthClient; by: string },
    replaced: boolean,
  ): Promise<void> {
    await recordAuditEvent(auditStore, {
      eventType: "mcp.oauth_client_registered",
      targetType: "mcp_server",
      targetId: input.serverId,
      payload: {
        actor: input.by,
        server: input.serverId,
        // The id, never the secret. It identifies the client that was registered, which is what
        // somebody reading the trail needs in order to check it against the vendor's console.
        clientId: input.client.clientId,
        replaced,
      },
    });
  }

  /**
   * Store the deployment's OAuth client for a `user-oauth` server, whoever obtained it.
   *
   * Both halves go into one encrypted value, so a single vault read yields a usable client. The id is
   * copied into `metadata` as well — it is not a secret, and a page listing what the deployment holds
   * should be able to name it without decrypting anything.
   *
   * Replacing a client revokes the previous one rather than orphaning it, so "what does this
   * deployment hold" keeps having one answer per server. Nobody's connection breaks in the sense that
   * matters here — a refresh token is the person's — but nobody's connection SURVIVES either: a grant
   * belongs to the client it was issued to, so replacing the client is asking everybody to connect
   * again. That is why the two callers that replace one both say so to whoever is listening.
   *
   * Shared by an administrator pasting one in and by the deployment registering its own, so `by` is
   * the only difference between the two in the trail — which is the honest one.
   */
  async function persistOAuthClient(input: {
    serverId: string;
    client: OAuthClient;
    by: string;
  }): Promise<void> {
    const { entry } = await requireServer(input.serverId);
    if (entry?.auth.kind !== "user-oauth") {
      throw new CustomServerRefusedError(
        `${input.serverId} is not reached with an OAuth client.`,
      );
    }

    const { replaced } = await withOAuthClientLock(
      input.serverId,
      (transaction) =>
        writeOAuthClient(
          { serverId: input.serverId, client: input.client },
          transaction,
        ),
    );

    await recordClientRegistered(input, replaced);
  }

  /**
   * The deployment's OAuth client for a server as it stands, or null if there is none to read.
   *
   * Decrypted, because both halves are needed: the id to build a consent URL and the secret to
   * redeem the code it comes back with. Held for the length of one request, like every other secret
   * this module reads.
   */
  async function storedOAuthClient(
    serverId: string,
  ): Promise<OAuthClient | null> {
    const [row] = await database
      .select({ credentialId: mcpServers.credentialId })
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId))
      .limit(1);
    if (!row?.credentialId) return null;

    try {
      const parsed: unknown = JSON.parse(
        await decryptCredentialForUse(
          encryptionKey,
          credentials,
          row.credentialId,
        ),
      );
      // A client that parsed and is not one is as unusable as the revoked or missing row the catch
      // below answers for, and is the same none to every caller — see {@link isUsableClient}.
      return isUsableClient(parsed) ? parsed : null;
    } catch {
      // A revoked, missing or unreadable client is the same as none for every caller: there is
      // nothing to send anybody to consent with, and the answer is to obtain one again.
      return null;
    }
  }

  /**
   * The credential a server is being pointed at is of the kind that server can spend.
   *
   * Both add paths dereference the pointer before they return, so this is checked where the pointer
   * is accepted rather than where it is used. `mcp` is the only kind that answers "this server's own
   * token". A `mcp_user_token` is one person's grant and a `mcp_oauth_client` identifies the
   * deployment to a vendor; spending either here uses a credential on behalf of somebody who never
   * agreed to it, which is the same objection `POST /api/admin/credentials` already makes when it
   * refuses to mint those two by hand.
   *
   * The shape is checked before the lookup because `credentials.id` is a `uuid` column, so a value
   * that is not one makes the query itself fail rather than return no rows, and the caller gets a
   * database error where a refusal belongs.
   *
   * One message for both "wrong kind" and "no such credential", deliberately. A caller who can tell
   * those apart can ask this endpoint which credential ids are real.
   */
  async function requireCredentialOfKind(
    serverTitle: string,
    serverId: string,
    credentialId: string,
    kind: "mcp" | null,
  ): Promise<void> {
    /*
     * A server that takes no credential when it is added is refused here rather than at the caller,
     * so that offering an id is one question with one answer wherever it is asked. The wording says
     * what is true of both kinds that reach it: a `user-oauth` server's client arrives through the
     * call that mints it, and a server needing no credential has nothing to be given.
     */
    if (!kind) {
      throw new CustomServerRefusedError(
        `${serverTitle} takes no credential when it is added.`,
      );
    }

    const looksLikeId =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        credentialId,
      );
    /*
     * Live, as well as the right kind and the right owner.
     *
     * A revoked credential cannot be decrypted, so attaching one only ever produced a server that
     * fails on its next call. Refusing it here says so at the moment somebody can still act on it,
     * and it closes the case where a token was retired precisely because it should stop being used.
     */
    const [named] = looksLikeId
      ? await database
          .select({
            kind: credentialRows.kind,
            provider: credentialRows.provider,
          })
          .from(credentialRows)
          .where(
            and(
              eq(credentialRows.id, credentialId),
              isNull(credentialRows.revokedAt),
            ),
          )
      : [];

    /*
     * Whose it is, as well as what it is.
     *
     * `provider` is the server a token was minted for: `storeMcpToken` sets it to the server id and
     * is the only way the plugins screen makes one. Without this, any `mcp` row in the vault could
     * be attached to any server, and since the refresh spends it against that server's address, a
     * token given to one vendor was deliverable to another. Reading a credential back is otherwise
     * impossible by design, so this closes the one field that accepts a reference to a secret rather
     * than the secret itself.
     */
    if (named?.kind !== kind || named.provider !== serverId) {
      throw new CustomServerRefusedError(
        "That is not a credential this server can use. Add the server's own token instead.",
      );
    }
  }

  /**
   * A brokered app's row is not something another add path may write through.
   *
   * CRITERION. `addServer` and `addCustomServer` refuse outright when the id they are about to
   * upsert already holds a row {@link accessFor} answers `brokered` for. Both of those paths write a
   * url of their own choosing, and neither may write one over an app somebody is connected to.
   *
   * REASON. The url is the ONLY place the app slug is written down. `connectionTokenFor` reads it to
   * decide whose account a call runs in, `removeServer` reads it to find the accounts to end at
   * Composio, and `retireConnectionsFor` finds a person's rows by the same string — so the moment
   * another path rewrites that url, every `composio_connections` row behind it stands for an app
   * nothing in this deployment can name any more. Consent that no operation can withdraw is the one
   * state this feature must not reach, and it is reachable by two ordinary administrative acts.
   *
   * REFUSED RATHER THAN REPAIRED, WHICH IS NOT THE ANSWER THE OTHER DIRECTION GETS.
   * {@link addBrokeredApp} converts a row it lands on, because there the url it writes is the app
   * and the row comes out saying so. Here the opposite is true: writing `provenance = "custom"`
   * alongside the new url would make the row self-consistent and lose the accounts just the same.
   * Consistent and orphaned is no better than contradictory and orphaned, so there is nothing to
   * write — only an act to decline.
   *
   * AND THE ADMINISTRATOR IS LEFT A REAL STEP. Removing the app ends every account at the vendor on
   * the way out and takes the row with it, after which the name is free for an endpoint. The
   * refusal says that, because the alternative reading — "this name is taken forever" — is not true
   * and would send somebody editing the database.
   *
   * ASKED WITH NO ENTRY, the reading {@link removeServer} uses, and for its reason: an entry can
   * only ever SUPPRESS the brokered answer, so passing one a colliding id looked up would hide the
   * brokered state of the very row most in need of protecting.
   */
  function requireNotBrokered(
    serverId: string,
    existing:
      | { provenance: string; url: string; authScheme: string | null }
      | undefined,
  ) {
    if (!existing) return;
    if (accessFor(existing, null).credential !== "brokered") return;
    throw new CustomServerRefusedError(
      `${serverId} is a Composio app this deployment has enabled, and people may have connected their accounts to it. Remove the app first — which ends those accounts at Composio — and the name is then free.`,
    );
  }

  async function requireServer(serverId: string) {
    const [row] = await database
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId))
      .limit(1);
    if (!row) throw new CatalogueEntryUnknownError(serverId);

    // Null for a custom server, and every caller handles that by assuming the worst about it.
    const entry = catalogueEntry(row.id);
    if (row.provenance === "first-party" && !entry) {
      // The row outlived its catalogue entry, which means a build removed a vendor while a
      // deployment still had it added. Refused rather than reached: the pinned host that made it
      // admissible no longer exists to check against, so there is nothing left that says this URL
      // is one we agreed to talk to.
      throw new CatalogueEntryUnknownError(row.id);
    }
    /*
     * Resolved here so every caller reads the same answer.
     *
     * Three call sites used to derive their own — the transport, the credential and the audit row —
     * and a Composio app made all three of them wrong at once. One derivation means they cannot
     * disagree, and `access.ts` is the only place a new kind of server has to be taught about.
     *
     * AND RESOLVED AGAINST THE APP'S ACCOUNT COLUMNS, NOT THE DIALLED ROW'S. `reachedAs` is read off
     * the scheme and the mode, both of which belong to the app — see {@link BrokeredAppRow} — so a
     * brokered row is handed to {@link accessFor} carrying the answering row's two columns. Done
     * here rather than at each consumer because this is the one resolution every store path reads,
     * which is fewer places to remember than the callers; `listServers` reports the same two columns
     * off the same row for the one reader outside the store, the memory ingestion. `app` goes back
     * with it, so the audience gate decides on and keys its approval by the row that answers rather
     * than the one that was dialled. Null for every row that is not a brokered app.
     */
    const toolkit = row.provenance === "composio" ? toolkitOf(row.url) : null;
    const app = toolkit ? await brokeredAppRow(toolkit) : null;
    const access = accessFor(
      app
        ? { ...row, authScheme: app.authScheme, accountMode: app.accountMode }
        : row,
      entry,
    );
    return { row, entry, access, app };
  }

  /**
   * What a row that answers for an app is asked for: which row it is, how the app connects, and
   * whose account it runs in.
   *
   * THE ACCOUNT COLUMNS TRAVEL WITH THE SCHEME FOR THE SCHEME'S OWN REASON. Whether an app is Shared
   * and which deployment identity it holds are facts about the APP, exactly as its scheme is, and a
   * duplicate row at the same url is not a second app. Read off whichever row a call was dialled
   * through, a duplicate recording `personal` at a Shared app's url skipped the audience gate and
   * let anybody connect a personal account to the team's app, and one recording `shared` at a
   * Personal app's url sent a person's call out as the deployment. Every account decision —
   * {@link accountRefFor}, the audience gate in `callTool`, the trail's `reachedAs`, the listing —
   * now reads these from here, so none of them can be about a different row than the others.
   */
  type BrokeredAppRow = {
    id: string;
    authScheme: string | null;
    accountMode: AccountMode | null;
    sharedVendorUserId: string | null;
  };

  /**
   * The one `mcp_servers` row that answers for the app a url names: its id, and its scheme.
   *
   * KEYED ON THE URL, which is where a brokered row records which app it is; `mcp_servers.id` is a
   * display name and nothing holds the two equal. A row called `gmail` at `composio://slack` would
   * have somebody's Slack key attached to a scheme read off Gmail's row — and, through the id this
   * also answers, a probe chosen off Gmail's action list and spent on their Slack key. That stake is
   * shared by every caller: {@link connectBrokeredWithFields}, {@link recheckBrokeredConnection},
   * {@link confirmBrokeredConnection} and {@link disconnectBrokered} read the scheme,
   * {@link probeBrokeredConnection} reads the id.
   *
   * AND ORDERED, BECAUSE THE URL IS NOT A KEY. `mcp_servers.url` has no unique index behind it, so
   * two rows may name one app and `limit(1)` over them is the planner's choice rather than an
   * answer. Each caller used to take it unordered and separately: the same person, the same app, and
   * five readings free to disagree with each other and with themselves between two page loads. What
   * that costs is a live key connection refused in words about a sign-in screen nobody used —
   * "connect it the way it asks for", over an app connected exactly the way it asked — and, on the
   * id, a Re-check the listing offers off the app's own row whose press resolves to the OTHER row,
   * finds no action published there and reports that nothing could be tried: the `checkable`/`probe`
   * deadlock, reached through the duplicate rather than through a composed id.
   *
   * SO THE READ IS ONE FUNCTION AND NOT A RULE EACH CALLER REPEATS. The lower id answers, which is
   * the rule {@link brokeredConnectionsFor} names the app by, so the row the page shows an app under
   * is the row every one of these reads off — and a sixth caller cannot re-derive the choice
   * differently, because there is nothing here to re-derive.
   *
   * NULL FOR AN APP WITH NO ROW AT ALL, and that is an answer rather than a gap: a person can hold
   * an account at an app this deployment has since removed, nothing names the scheme it was
   * connected under any more, and every caller treats the null as "not an app we hold a key for" —
   * or, for the probe, as "there is no app left to check".
   */
  async function brokeredAppRow(
    toolkit: string,
  ): Promise<BrokeredAppRow | null> {
    const url = `composio://${toolkit}`;
    return (await brokeredAppRowsAt([url])).get(url) ?? null;
  }

  /**
   * The same answer for several urls at once, and the ONE PLACE the ordering rule is written.
   *
   * THE RULE IS SQL'S `order by id` AND THE FIRST ROW SEEN PER URL, which is what
   * {@link brokeredAppRow} asks for one app and what {@link brokeredConnectionsFor} and
   * {@link listServers} ask for many. Those three had their own spellings of it, and one of them —
   * the listing — spelled it as a JavaScript `<` over rows it had already fetched. That is UTF-16
   * code unit order; this is the deployment's collation. They agree for ASCII on a `C` database and
   * are free to disagree anywhere else, and where they disagreed the settings page named an app
   * under one row while every read behind its buttons was about another. So the rule is a function
   * and the callers have nothing left to re-derive.
   *
   * A URL WITH NO ROW IS SIMPLY ABSENT from the map, which is the null {@link brokeredAppRow}
   * answers and the connection {@link brokeredConnectionsFor} drops: a person can hold an account
   * at an app this deployment has since removed, and there is no row to name it by.
   *
   * EMPTY IN, EMPTY OUT AND NO QUERY, because `inArray` with no values is a statement no database
   * needs to be asked.
   */
  async function brokeredAppRowsAt(
    urls: string[],
  ): Promise<Map<string, BrokeredAppRow>> {
    const answering = new Map<string, BrokeredAppRow>();
    if (urls.length === 0) return answering;
    const rows = await database
      .select({
        id: mcpServers.id,
        url: mcpServers.url,
        authScheme: mcpServers.authScheme,
        accountMode: mcpServers.accountMode,
        sharedVendorUserId: mcpServers.sharedVendorUserId,
      })
      .from(mcpServers)
      .where(inArray(mcpServers.url, urls))
      .orderBy(asc(mcpServers.id));
    for (const { url, ...row } of rows) {
      if (!answering.has(url)) answering.set(url, row);
    }
    return answering;
  }

  /** {@link brokeredAppRow}'s scheme, for the callers that ask only what the app is connected with. */
  async function brokeredAppScheme(toolkit: string): Promise<string | null> {
    return (await brokeredAppRow(toolkit))?.authScheme ?? null;
  }

  /**
   * What that scheme decides, which is what every caller actually branches on.
   *
   * ONE CLASSIFICATION OVER ONE ROW, and the second half of what {@link brokeredAppRow} is for.
   * That function ends the disagreement about WHICH ROW answers for an app; this one ends the
   * disagreement about what its column MEANS. They were separate questions and were answered
   * separately: four callers each asked {@link isFieldScheme} and treated everything else — a
   * consent scheme, a literal from another deployment, a null — as one answer, and only three of
   * them could survive being wrong about it. The confirm is the fourth, and it WRITES.
   *
   * SO THE THIRD ANSWER TRAVELS, rather than being flattened at the call site. See
   * {@link SchemeKind}: `unreadable` is what a caller needs in order to fail closed, and a boolean
   * cannot carry it.
   */
  async function brokeredAppKind(toolkit: string): Promise<SchemeKind> {
    return schemeKind(await brokeredAppScheme(toolkit));
  }

  return {
    options,
    database,
    auditStore,
    credentials,
    encryptionKey,
    injectedVendor,
    exchangeRefreshToken,
    registerClient,
    broker,
    exchangeChains,
    serialized,
    grantsFor,
    mcpGrantsForServers,
    toolsDeclaredBy,
    knownToolRefs,
    secretFor,
    accountRefFor,
    accountRow,
    connectionTokenFor,
    refuseAndReplaceEvictedClient,
    swapUserCredential,
    rotateConnectionToken,
    oauthClientKey,
    withOAuthClientLock,
    heldOAuthClient,
    writeOAuthClient,
    recordClientRegistered,
    persistOAuthClient,
    storedOAuthClient,
    requireCredentialOfKind,
    requireNotBrokered,
    requireServer,
    brokeredAppRow,
    brokeredAppRowsAt,
    brokeredAppScheme,
    brokeredAppKind,
  };
}

export type StoreContext = ReturnType<typeof createStoreContext>;

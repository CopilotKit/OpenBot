import {
  BrokerRefusalError,
  type ComposioBroker,
  type GrantState,
} from "../broker";
import { type ComposioActions, LISTING_LIMIT } from "../composio";
import {
  askVendor,
  configIdOf,
  everyRefusal,
  named,
  sent,
  statusOf,
  textOf,
  VENDOR_SHAPE_REMEDY,
  whose,
  withdrawableAccounts,
  withdrawalDeclined,
} from "../composio-vendor";
import type { AccountRef } from "../shared-accounts";
import type { ClientContext } from "./context";
import { CONFIG_SUFFIX, CONNECTED, REVOCABLE, STATUSES_NAMED } from "./model";

/**
 * Sending a person to consent, asking whether they are connected and what they hold, and revoking.
 *
 * `actions` is the same client's action seam, read by {@link ComposioBroker.grantsFor} for the
 * actions it reports a grant over.
 */
export function consentMethods(
  context: ClientContext,
  actions: ComposioActions,
) {
  const { vendor, accountsFor, configsFor, askForEach } = context;
  return {
    // Composio's grant is held by this deployment. Its existing behaviour, declared; see
    // {@link ConnectedAppBroker.grantIsLocal} for why this is a property and not a comparison.
    grantIsLocal: true,
    // Composio runs no correlated, pollable authorization flow: it mints nothing to poll, and its
    // return leg is an OAuth callback with state, handled in `oauth.ts` and never through this
    // seam. Declared rather than omitted; see {@link ConnectedAppBroker.authorizations}.
    authorizations: null,
    /**
     * The toolkit itself, WHICH IS AN ANSWER AND NOT A STUB.
     *
     * A Composio connection is made against an auth config, and an auth config is per toolkit. So
     * there is no auth provider standing behind several toolkits here the way Arcade's `google`
     * stands behind `Gmail` and `GoogleCalendar`: the toolkit IS its own auth provider, and the set
     * of apps sharing a connection with it is consequently ALWAYS EMPTY. That is the truth about
     * Composio rather than a degradation of it — {@link ConnectedAppBroker.grantsFor}'s "degenerate
     * is not absent", one member along.
     *
     * SO IT DOES NOT THROW, and the reason is what a throw would cost the callers: every consumer
     * of the sibling computation would need a presence test around this call, and the disconnect
     * path would carry a provider branch — which is the vendor-name comparison this seam exists to
     * keep out of permission and revocation code.
     *
     * No network: the answer is a property of how Composio is shaped, so nothing is asked.
     */
    authProviderOf: async (toolkit: string) => toolkit,
    /**
     * What this person holds at this app, said once per action because that is what Composio knows.
     *
     * DEGENERATE AND NOT ABSENT, which is why this is implemented rather than thrown. An auth
     * config fixes its scope set when it is created and a connection is made against the config,
     * so there is exactly one answer for the toolkit: either this person has an account on it or
     * they have not, and the scopes are the config's. Reporting that answer once per action is the
     * honest rendering of a toolkit-wide grant through {@link GrantState}, which is this
     * deployment's vocabulary rather than any vendor's row shape. The alternative — a throw —
     * would make one seam member answer two different questions depending on who implemented it,
     * which is the defect this file already carried at {@link ComposioBroker.accountName}.
     *
     * THE STATE IS MEASURED OVER EVERY CONFIG, AS {@link ComposioBroker.isConnected}'S IS. The two
     * are the same read-only question — can this person act through the app — and the call that
     * runs an action names the person and the toolkit, not the account, so an account on an
     * operator's hand-made config is one they act through. Measuring this one over our configs
     * alone would answer `needs-consent` to somebody the gate lets through, and send them to
     * consent to an app they already use. Only {@link ComposioBroker.revoke}, which ACTS on what it
     * finds, is scoped to ours.
     *
     * SO THE SCOPES ARE THE CONFIGS THIS PERSON'S ACCOUNTS WERE MINTED AGAINST, WHICH NEED NOT BE
     * OURS. A config fixes its scope set when it is created and every account on it holds exactly
     * that set, so an `authorized` answer carries the scopes of the configs the counted accounts
     * sit on — every one of them, which is why the listing is read to the end rather than stopped at
     * the first row. This used to carry THIS DEPLOYMENT'S scopes whatever the account sat on, which
     * paired `authorized` with a scope set the person never granted. A `needs-consent` answer
     * carries our configs' scopes instead, because those are the configs a consent from here is
     * minted against: it describes what they would be asked for.
     *
     * AN ACCOUNT WHOSE CONFIG CANNOT BE NAMED, OR IS NOT AMONG THE CONFIGS THAT COULD BE READ,
     * LENDS NO SCOPES — neither its own, which nothing here can read, nor ours, which it does not
     * hold. The names are deduplicated and ordered so that two readings of one unchanged deployment
     * are one answer.
     */
    async grantsFor({
      toolkit,
      account,
    }: {
      toolkit: string;
      account: AccountRef;
    }): Promise<GrantState[]> {
      const connected = await accountsFor(
        account.vendorUserId,
        toolkit,
        CONNECTED,
      );
      const state = connected.length > 0 ? "authorized" : "needs-consent";

      const { held, ours } = await configsFor(toolkit);
      const mintedOn = new Set(
        connected.map(configIdOf).filter((id) => id !== null),
      );
      const granting =
        state === "authorized"
          ? held.filter((config) => mintedOn.has(config.id))
          : ours;
      const scopes = [
        ...new Set(granting.flatMap((config) => config.scopes)),
      ].sort();

      const published = await actions.listActions(toolkit, {
        limit: LISTING_LIMIT,
      });
      // A fresh array per entry: one shared list would let a caller mutating its first grant's
      // scopes rewrite every other grant in the answer. An authorized entry is always `held`: it is
      // authorized only because this person holds an account, which is a consent they gave.
      return published.map(
        (action): GrantState =>
          state === "authorized"
            ? {
                action: action.slug,
                state,
                scopes: [...scopes],
                authorization: "held",
              }
            : { action: action.slug, state, scopes: [...scopes] },
      );
    },
    async authorize({
      account,
      toolkit,
      returnUrl,
    }): Promise<{ redirectUrl: string; authorizationId: string | null }> {
      const userId = account.vendorUserId;
      /*
       * THE CONFIG THIS DEPLOYMENT ALREADY MADE, AND NO SECOND ONE MADE HERE.
       *
       * `ensureAuthConfig` creates it when an administrator enables the app, which is what makes
       * this a read. Creating one here instead would mint it at the moment somebody presses
       * Connect, unnamed for this deployment and invisible in the dashboard until the first person
       * happened to try — and where a config already existed for an app enabled twice, a second
       * one would split one app's connections across two configs, so removing "the" config later
       * would drop half of them.
       *
       * NONE IS A STATE WITH A REMEDY, NOT A NULL TO WORK AROUND. It is the app enabled before
       * this deployment created configs at all, or a config deleted by hand in Composio's
       * dashboard. Neither is something a person pressing Connect can fix, so the sentence names
       * the app and the administrator's step rather than leaving them at a link that would attach
       * their account to a configuration nobody here chose.
       *
       * AND "NONE" MEANS NONE OF OURS, which is the correction. The read used to take whichever row
       * the vendor returned first, so an app whose only config was one an operator built by hand
       * read as ready and this minted somebody's connection against it — scopes this deployment
       * cannot see, tool restrictions it cannot read, and an object it must not delete. A
       * connection is a lasting attachment to whatever config it was made against, so guessing here
       * is not a guess that can be corrected later.
       */
      const { ours, unreadable } = await configsFor(toolkit);
      if (ours.length === 0) {
        /*
         * A ROW THIS FILE COULD NOT READ IS NOT AN APP WITH NO CONFIG, AND THE REMEDIES ARE
         * DIFFERENT PEOPLE'S. The sentence below sends an administrator to remove the app and add
         * it again, which is right where the listing was legible and said there is none of ours —
         * and wrong here, because the row that could not be sorted may BE ours, in which case
         * removing the app meets {@link ComposioBroker.deleteAuthConfig}'s own refusal and adding
         * it again is refused by `ensureAuthConfig` for the same reason. Nobody should be sent
         * round a loop that cannot close.
         *
         * WHAT IS NOT DIFFERENT IS THAT NOTHING IS MINTED. A link is a lasting attachment to one
         * particular config, so a person is never sent anywhere on the strength of a listing this
         * deployment could not read — see {@link readableConfigs}, where a config of OURS that was
         * read is enough to go on whatever else the listing held.
         */
        if (unreadable.length > 0) {
          throw new BrokerRefusalError(
            `Composio described ${unreadable.length} of its authorization configs for ${toolkit} in a way this deployment cannot read and none of the rest is one it made, so there is nothing it can show is its own to connect an account against and nobody was sent anywhere. ${VENDOR_SHAPE_REMEDY}`,
            { cause: everyRefusal(unreadable) },
          );
        }
        throw new BrokerRefusalError(
          `This deployment has no authorization config at Composio for ${toolkit}, so there is nothing to connect an account against. An administrator removing the app on its Plugins page and adding it again creates one.`,
        );
      }

      /*
       * A DISABLED CONFIG IS NOT A CONFIG TO CONNECT AGAINST, and it is now visible enough to say
       * so. The listing asks for disabled configs — it has to, or the creation above duplicates one
       * — which means this is the first read that can meet one. A link minted against it does not
       * work, so sending a person to the vendor would spend their consent and end with nothing
       * attached; and nothing they can do from the page they are on changes it, because enabling a
       * config happens in Composio's dashboard.
       *
       * THE FIRST OF SEVERAL, WHICH IS A CHOICE AND NOT AN ACCIDENT. More than one enabled config
       * of ours means a lost enable race, and both are equally ours and equally valid. What
       * mattered about the old "first row" was that the order was the vendor's and the next caller
       * could get a different one; the listing is sorted on the id, so this is the same config for
       * every person and for the removal that later drops all of them.
       */
      const config = ours.find((held) => statusOf(held) === "ENABLED");
      if (!config) {
        /*
         * "DISABLED" IS A CLAIM, AND IT IS ONLY THIS DEPLOYMENT'S TO MAKE WHEN COMPOSIO MADE IT.
         *
         * The test above is `=== "ENABLED"`, so everything that is not that word fell through here
         * — and that is three different states wearing one sentence. A config Composio calls
         * DISABLED is genuinely disabled and the remedy below is genuinely the remedy. A config
         * with no status at all, or one carrying a word this deployment's `@composio/core` has
         * never heard of, is a config whose state is UNKNOWN, and telling an operator it is
         * disabled sends them to a dashboard to enable something that may already be enabled — and
         * where it is, they are left with a page insisting on a fact they can see is false and
         * nothing else to try.
         *
         * BOTH ARE STILL A REFUSAL, WHICH IS THE PART THAT DOES NOT CHANGE. Nothing here mints a
         * link against a config it cannot show is enabled: consent spent against a config that
         * turns out to be disabled attaches nothing and cannot be spent again without asking the
         * person to go round the loop a second time. What the status decides is which sentence a
         * person reads, not whether they are sent.
         *
         * The status is quoted where there is one, for the reason {@link named} gives: it is a
         * closed set of vendor enum names, it carries nobody's data, and it is the one fact an
         * operator can search a dashboard and a changelog for.
         */
        /*
         * `unsettled` RATHER THAN `unreadable`, WHICH IS A RENAME AND ALSO THE THIRD CLAUSE BELOW.
         *
         * This list was called `unreadable` and SHADOWED the one `configsFor` answers — the refusals
         * for rows it could sort into neither pile — for the whole of this block. The two are not the
         * same set and they are not about the same rows: this one holds configs of OURS whose status
         * is a word neither ENABLED nor DISABLED, and the outer one holds rows whose id or name never
         * arrived at all. So the outer set was unreachable from the only place its clause could have
         * been written, and the clause is missing from this refusal while both siblings that collect
         * the same list carry theirs. The identical block in
         * {@link ComposioBroker.connectWithFields} already names its local `unsettled` for exactly
         * this reason, and is the copy this one is now spelled like.
         */
        const unsettled = ours.filter((held) => statusOf(held) !== "DISABLED");
        /*
         * AND THE TWO STATES ARRIVE TOGETHER, SO NEITHER ONE TAKES THE OTHER'S TURN. These were a
         * chain — report the unsettled rows, otherwise report the disabled ones — and the paragraph
         * above says in its own words why that cannot hold: `ours` is a SET, and more than one
         * config of ours is the ordinary outcome of a lost enable race that this method is written
         * around. One DISABLED config beside one carrying a word this deployment's `@composio/core`
         * has never heard of satisfies both conditions, and the chain answered with the unsettled
         * sentence alone — whose only remedy is a package upgrade, which is nobody's act on the page
         * the reader is standing on. The act that would actually have got them connected is enabling
         * the disabled config in Composio's dashboard, and it was withheld because a different row
         * said something unreadable.
         *
         * TWO CLAUSES BECAUSE THEY ARE TWO REMEDIES, in the shape
         * {@link ComposioBroker.deleteAuthConfig} and {@link ComposioBroker.revoke} both use for the
         * same reason. The refusal itself does not move: nothing here mints a link against a config
         * it cannot show is enabled, whichever of the two is true.
         */
        const left: string[] = [];
        const disabled = ours.length - unsettled.length;
        if (disabled > 0) {
          left.push(
            `Composio calls ${disabled} of this deployment's ${ours.length} authorization configs for ${toolkit} disabled, and an administrator can enable it in Composio's dashboard, or remove the app on its Plugins page and add it again.`,
          );
        }
        if (unsettled.length > 0) {
          /*
           * EVERY STATUS THAT WAS ACTUALLY READ, AND NONE OF THEM SPEAKING FOR THE REST. The
           * sentence counted the whole set and quoted `unsettled[0]` — "Composio describes 3 of
           * this deployment's configs as PENDING" is a claim about three rows established of one,
           * and an operator searching their dashboard for the word they were handed would never
           * reach the two that say something else. Each distinct word once, so two configs wearing
           * one status do not read as two findings.
           *
           * AND THE LIST IS BOUNDED, for the reason {@link named} bounds each word. This set is as
           * large as the listing, which is paged; a refusal whose length is decided by how many
           * configs an app has is a refusal nothing downstream can hold.
           */
          const words = [
            ...new Set(unsettled.map((held) => named(held.status))),
          ];
          /*
           * AND THE TAIL COUNTS IN THE NUMBER'S OWN WORDS. "and 1 other words" was the unpluralised
           * spelling, in a sentence whose very next clause conjugates its own verb on the same
           * count — so the one refusal that has to be trusted about an authorization config could
           * not get its own arithmetic to read. See {@link STATUSES_NAMED} for why there is a tail
           * at all.
           */
          const shown = words.slice(0, STATUSES_NAMED);
          const unnamed = words.length - shown.length;
          const said =
            unnamed > 0
              ? `${shown.join(", ")} and ${unnamed} other word${unnamed === 1 ? "" : "s"}`
              : shown.join(", ");
          left.push(
            `Composio describes ${unsettled.length} of this deployment's ${ours.length} authorization configs for ${toolkit} as ${said}, which ${words.length === 1 ? "is" : "are"} neither ENABLED nor DISABLED, so whether a connection begun against one could complete is not something this deployment can tell. ${VENDOR_SHAPE_REMEDY}`,
          );
        }
        /*
         * AND THE ROWS NOTHING COULD SORT ARE THE THIRD CLAUSE, WHICH THE SHADOW HAD TAKEN AWAY.
         *
         * A row whose id or name never arrived may BE a config of this deployment's that Composio
         * calls ENABLED, in which case "no config here could be shown to be enabled" is true of what
         * was read and the remedy above it — go and enable the disabled one — is an act against the
         * wrong object, or against nothing at all. It is a third fact about a third set of rows, so
         * it is a third independent clause rather than a chain, for the reason the paragraph above
         * gives: two facts about two different rows cannot take turns.
         */
        if (unreadable.length > 0) {
          left.push(
            `Composio described ${unreadable.length} of its authorization configs for ${toolkit} in a way this deployment cannot read, so whether one of THOSE is a config of this deployment's that Composio calls enabled is outside what either reading settles: reading those rows in Composio's own dashboard is what says whether there is one here to connect against at all. ${VENDOR_SHAPE_REMEDY}`,
          );
        }
        throw new BrokerRefusalError(
          `No authorization config this deployment holds at Composio for ${toolkit} could be shown to be enabled, so no link was made: consent spent against a config that turns out to be disabled attaches nothing and cannot be spent again without sending ${whose(account)} round the loop a second time. ${left.join(" ")}`,
          unreadable.length > 0
            ? { cause: everyRefusal(unreadable) }
            : undefined,
        );
      }

      /*
       * THE RETURN ADDRESS IS THE WHOLE POINT OF THIS CALL, and it is the caller's rather than
       * this file's: the adapter knows Composio, and where a person belongs afterwards is a fact
       * about this deployment's own pages. It is never logged and never quoted in the refusal
       * below, for the reason the url itself is not.
       *
       * NO `allowMultiple`, WHICH LEAVES THE VENDOR ENFORCING THE RULE THIS DEPLOYMENT ALREADY
       * STATES. One person holds one account per app here, because the call that runs an action
       * names the person and not the account — so with two accounts attached, which mailbox a Bot
       * reads would be Composio's choice and nothing here could say which one it had been. The
       * route refuses a second connection before it ever reaches this method, and that refusal is
       * the sentence a person reads; this is the same rule one layer further down, where the
       * vendor is the only party that can still see an account this deployment's rows have lost
       * track of. What it raises there is {@link BrokerAccountHeldError}, and the route answers
       * that by recording the account the vendor holds, so the person who pressed Connect is
       * connected through it and is not told to disconnect an account their page never showed.
       * `toolkits.authorize` passed `allowMultiple: true` unconditionally — the SDK
       * calls it a "magic function" for exactly that — which is the opposite of what this
       * deployment wants.
       *
       * THE ANSWER IS AN OBJECT BY CONSTRUCTION AND ITS ONE FIELD IS NOT. `link` builds what it
       * returns with `createConnectionRequest(client, response.connected_account_id, INITIATED,
       * response.redirect_url)` inside a try that turns anything thrown into
       * `ComposioFailedToCreateConnectedAccountLink` (`@composio/core` 0.18.1,
       * `src/models/ConnectedAccounts.ts:420-453`), and that builder assembles a literal
       * (`src/models/ConnectionRequest.ts:39-43`). So a refusal for "Composio answered something
       * that is not an object" could not be reached — the vendor either hands over its own object
       * or raises a class {@link vendorRefusal} already translates. What the builder copies across
       * untouched is the url, which is why that is the field still read.
       */
      const request = await askVendor(
        {
          outcome: `this person's connection to ${toolkit} was not begun`,
          app: toolkit,
        },
        () =>
          vendor.connectedAccounts.link(userId, config.id, {
            callbackUrl: returnUrl,
          }),
      );

      const redirectUrl = request.redirectUrl;
      /*
       * PRESENT AND NOT A URL IS THE SHAPE THE ABSENCE GUARD BELOW CANNOT SEE. `!redirectUrl` is
       * false for an object, a number and a list alike, so each of those would be returned as the
       * `redirectUrl: string` this method promises and put in a `Location` header — a page nobody
       * can visit, handed to a person as the consent screen they were sent to.
       */
      if (
        redirectUrl !== undefined &&
        redirectUrl !== null &&
        typeof redirectUrl !== "string"
      ) {
        throw new BrokerRefusalError(
          `Composio sent ${sent(redirectUrl)} where the page to send ${whose(account)} to for ${toolkit} belongs, so nobody was sent anywhere. ${VENDOR_SHAPE_REMEDY}`,
        );
      }
      /*
       * AND THE URL IS THE ONE THAT WAS JUDGED, WHICH IT WAS NOT — the defect {@link textOf} is
       * written against, on the one value in this file that leaves the process in a `Location`
       * header.
       *
       * `!redirectUrl` is false for a string of blank space, so "   " cleared this guard and the
       * shape guard above it and was answered as the `redirectUrl: string` this method promises: a
       * person who pressed Connect is redirected to nothing, having been told they were being sent
       * to the app's own consent screen. And a url that arrived PADDED was handed back with its
       * padding, which is not an address either — the space is percent-encoded or the redirect is
       * refused outright. Every identifier on this path is read through {@link textOf} for exactly
       * this reason; this was the field that was not.
       *
       * THE SHAPE GUARD STAYS AHEAD OF IT, because the two states have different sentences. An
       * object or a number where a url belongs is a vendor change with a package remedy; no url at
       * all is an ordinary fact about an auth scheme, and blank is that fact spelled the other way.
       */
      const page = textOf(redirectUrl);
      if (page === null) {
        /*
         * The SDK spells `redirectUrl` nullable because not every auth scheme has one — an API-key
         * toolkit is connected by typing a secret, not by visiting a page. This deployment's
         * enablement flow sends a person to a url, so no url is nothing to do rather than a
         * success, and the sentence says which app it was about. The url itself is never quoted
         * anywhere, here or elsewhere: whoever opens it attaches an account to this person's
         * connection, so it is handed to the browser that asked and then forgotten.
         */
        throw new BrokerRefusalError(
          `Composio began a connection to ${toolkit} but answered with no page to visit, so there is nothing to send ${whose(account)} to. An app that is connected by entering a credential rather than by visiting a page cannot be connected from here.`,
        );
      }
      // DECLARED NULL, NOT COMPOSIO'S CONNECTION-REQUEST ID. Composio's return leg never comes
      // through this seam: it lands in `oauth.ts`, correlated by sealed state this deployment
      // minted, not by an id the broker handed back. The connection-request id would put a value
      // with a DIFFERENT MEANING behind the same member — the `accountName` defect again.
      return { redirectUrl: page, authorizationId: null };
    },

    async isConnected({ account, toolkit }): Promise<boolean> {
      const userId = account.vendorUserId;
      /*
       * A COUNT, AND NOTHING IS READ OFF A ROW TO REACH IT. An ACTIVE account Composio described
       * without an id is still an ACTIVE account: this person can act through the app, which is the
       * whole of what this gate asks. Reading the id here used to turn that into a refusal, so a
       * field this question never looks at decided its answer.
       *
       * AND IT STOPS AT THE FIRST ROW, WHICH IS THE SAME CORRECTION ONE LEVEL OUT. This method
       * answers a boolean, and a boolean settled by page one cannot be improved by page two — but
       * reading on left the answer exposed to three faults that belong to pages nobody needed: a
       * cursor Composio sent as a number, a cursor it repeated, and the fiftieth page of a listing
       * that will not end. Each of those threw at a person whose ACTIVE account had already been
       * found and told them the vendor's shape was wrong, and `store.ts` deletes their connection
       * row on a `false` — so a question that had been answered `true` was made failable by the
       * machinery that made the `false` complete. Paging is still what makes the `false` honest:
       * with no row yet, the next page is the only thing that can settle it, so it is read.
       *
       * ASKED OF EVERY CONFIG, WHICH IS WHERE THIS DIVERGES FROM `revoke` BELOW. A person whose
       * only account for the app sits on a config an operator built by hand can still act through
       * the app — the call that runs an action names the person and the toolkit, not the account —
       * so scoping this to configs of ours would refuse somebody who is, in fact, connected. This
       * method only READS; the one that acts is the one that has to be narrow.
       */
      return (
        (
          await accountsFor(userId, toolkit, CONNECTED, {
            enough: (rows) => rows.length > 0,
          })
        ).length > 0
      );
    },

    async revoke({ account, toolkit }): Promise<boolean> {
      const userId = account.vendorUserId;
      /*
       * THE ANSWER IS WHAT WAS ASKED FOR, not whether the call threw. `false` here means there was
       * nothing to withdraw, which is what the audit trail's `vendorRevocationRequested` is for: a
       * reader has to be able to tell an account this deployment acted on from one that outlives it
       * somewhere else.
       *
       * ASKED FOR, RATHER THAN DONE, AND THE FIELD IS NAMED FOR THAT. The delete carries
       * `revoke_on_delete`, which is what turns it from a record-keeping soft-delete into an actual
       * withdrawal — and what it starts is a background job the vendor gives no supported way to
       * poll. So the account is gone at the broker by the time this returns and nothing here can
       * call with it again; whether Google has torn up the refresh token happens afterwards. `true`
       * claims exactly that much. See {@link ComposioVendor} for the two declarations this rests on.
       *
       * EVERY ACCOUNT, not the first, and in every state that could still be a grant. One person
       * can hold more than one account for one app — two mailboxes, or a stale account beside a
       * fresh one, or a shared account beside their own — and each of them is access this
       * deployment's calls could run under. See {@link REVOCABLE} for why the listing here is wider
       * than the one behind `isConnected`.
       *
       * AND EVERY ACCOUNT MEANS EVERY ACCOUNT ON A CONFIG THIS DEPLOYMENT MADE, WHICH IS NARROWER
       * THAN WHAT THIS USED TO DELETE. The listing was asked by person, app and "all account
       * types" and by nothing else, so it returned accounts attached to authorization configs an
       * operator built by hand in Composio's dashboard — for purposes this deployment knows nothing
       * about, on scopes it cannot see, and, with `accountType: "ALL"`, including the SHARED ones
       * that other people are acting through. Every one of those was then deleted with
       * `revoke_on_delete`, which tears the grant up at Google or Slack. One person pressing
       * disconnect on their own settings page ended somebody else's integration.
       *
       * WHICH IS THE PRINCIPLE {@link ComposioBroker.deleteAuthConfig} ALREADY STATES, ARRIVING
       * ONE LEVEL DOWN. That method refuses to delete a config it cannot show is this
       * deployment's, on the reasoning that an operator's dashboard work is not ours to destroy —
       * and the accounts hanging off that config are the same work. {@link madeHere} is the only
       * thing that tells the two apart, so it decides both.
       *
       * NOTHING AT ALL IS NOTHING TO WITHDRAW, AND IT IS ANSWERED WITHOUT ASKING. An app Composio
       * holds no configs for never had a connection begun through it — {@link
       * ComposioBroker.authorize} mints every link against a config of this deployment's and
       * refuses where there is none — so there is nothing here that this deployment granted.
       * Answering before the listing is also what keeps the empty filter off the wire; see
       * `authConfigIds` on {@link ComposioVendor} for why an empty one must never be sent.
       *
       * BUT "NOTHING OF OURS" IS NOT THAT STATE, AND ANSWERING `false` TO IT WAS THE SEVENTH ROUTE
       * TO A REVOCATION THAT DID NOT REVOKE. The reasoning above is sound about an app with no
       * configs and cannot tell that app from this one: an operator renames a config in Composio's
       * dashboard — drops the suffix, or edits the app's title past it — and this deployment's own
       * live grants read as somebody else's work. `false` then means "there was nothing to
       * withdraw", `store.ts` writes `vendorRevocationRequested: false` into the audit trail and
       * deletes the `composio_connections` row, and the person's grant stands at Google with
       * nothing in this deployment naming it. The trail records that no withdrawal was even asked
       * for, which is the one direction nobody thinks to check.
       *
       * {@link ComposioBroker.deleteAuthConfig} REFUSES IN EXACTLY THIS STATE, and two halves of
       * one operation cannot disagree about one condition. Its reading is the right one and this is
       * the half that moves: the app's configs are legible, none of them carries the suffix, and
       * nothing in the row says whether that is an operator's own work or ours under a title
       * somebody edited. A refusal leaves the connection row standing, which is what keeps the
       * person's grant findable, and names the same one act in a dashboard that the removal does.
       *
       * `false` STILL MEANS WHAT IT SAID, and now only where it is true: Composio holds nothing for
       * this app, so this deployment granted nothing through it.
       */
      const { held, ours, unreadable } = await configsFor(toolkit);
      if (ours.length === 0 && held.length > 0) {
        /*
         * THE UNREADABLE ROWS TRAVEL WITH THIS SENTENCE RATHER THAN WAITING FOR A PRESS THAT NEVER
         * GETS TO THEM. The refusal below is written for `ours.length === 0 && unreadable.length >
         * 0`, and as a second consecutive throw it is reachable only where `held.length === 0` —
         * so a listing carrying one renamed config AND one row nothing could sort reported the
         * rename alone, and closed by telling this person that renaming it "lets disconnecting
         * again withdraw them". It does not: the account listing is scoped to the configs this
         * method can name, and a row in the other pile is one it never was. The same clause is
         * appended independently to the partial-withdrawal sentence further down, which is the
         * shape this should always have had.
         */
        const alsoUnreadable =
          unreadable.length > 0
            ? ` Composio also described ${unreadable.length} of its ${toolkit} authorization configs in a way this deployment cannot read, so any grant of theirs on one of those is outside the question either reading settles, and renaming the config above is not on its own enough to end everything they hold: reading those rows in Composio's own dashboard is what says whether anything is left.`
            : "";
        throw new BrokerRefusalError(
          `Disconnecting ${toolkit} found none of this deployment's own authorization configs at Composio, and Composio holds ${held.length} for ${toolkit} whose name does not carry ${CONFIG_SUFFIX} — so nothing was withdrawn and ${whose(account)}'s access has not ended, rather than their connection being forgotten here while their grant stands. Nothing here can tell one of ours, renamed in Composio's dashboard, from an operator's own work. If it is this deployment's, ${whose(account)}'s grants on it are live, and renaming it to end with ${CONFIG_SUFFIX} lets disconnecting again withdraw them. If it is an operator's, this deployment granted nothing through it and only that dashboard can end what it holds.${alsoUnreadable}`,
          unreadable.length > 0
            ? { cause: everyRefusal(unreadable) }
            : undefined,
        );
      }
      /*
       * AND A ROW THAT COULD NOT BE READ IS NOT A ROW THAT IS NOT OURS — the same distinction one
       * field further in. A config whose id or name Composio sent unreadably cannot be put in the
       * account listing's filter, so any grant of this person's sitting on it is invisible to
       * everything below and a `false` would be the same false trail entry as the rename above.
       * Where there IS something of ours it is withdrawn first and this is reported afterwards, for
       * the reason {@link readableConfigs} gives; here there is nothing to withdraw first.
       */
      if (ours.length === 0 && unreadable.length > 0) {
        throw new BrokerRefusalError(
          `Composio described ${unreadable.length} of its authorization configs for ${toolkit} in a way this deployment cannot read and none of the rest is one it made, so whether ${whose(account)} holds a grant on one of this deployment's own could not be told and nothing was withdrawn. Their access has not been shown to end. ${VENDOR_SHAPE_REMEDY}`,
          { cause: everyRefusal(unreadable) },
        );
      }
      if (ours.length === 0) return false;
      const accounts = await accountsFor(userId, toolkit, REVOCABLE, {
        configs: ours.map((config) => config.id),
      });
      /*
       * THE READABLE ONES GO FIRST AND THE UNREADABLE ONES ARE REPORTED AFTERWARDS. Reading the ids
       * of all of them before sending any delete is what made one unnameable row a permanent block
       * on a person's disconnect — see {@link withdrawableAccounts}. Partitioning puts the withdrawal
       * back in front of the report, which is the order a person's grants actually need.
       */
      const { ids, nameless } = withdrawableAccounts(accounts, toolkit);

      /*
       * AND NOTHING TO WITHDRAW IS ITS OWN STATE, WHICH IS THE BRANCH EVERY SIBLING OF THIS METHOD
       * HAS AND THIS ONE DID NOT.
       *
       * A config of ours that IS readable, no account of this person's on it, and a row nothing
       * could sort beside it: the partial-withdrawal throw below was what answered, and what it
       * said was "Composio withdrew 0 of this person's 0 accounts for gmail". Both figures are
       * counts of a set nothing measured, in the one sentence a reader is meant to act on, and
       * "withdrew" asserts that a withdrawal happened. None did, and none was there to happen.
       * {@link ComposioBroker.deleteAuthConfig} was corrected for the identical sentence about
       * configs — "removed 0 of this deployment's 0" — and this is that count one listing further
       * in, reached from the other end.
       *
       * STILL A REFUSAL, for the reason that method's branch is one. A grant of this person's may
       * sit on the config behind the row nothing could sort, and the account listing was never
       * scoped to it — so `store.ts` must not delete the row naming which app they connected on the
       * strength of a question nothing asked.
       *
       * THE OTHER HALF OF "NOTHING TO WITHDRAW" IS NOT A REFUSAL AND IS ANSWERED BELOW. Every row
       * legible, none of this person's accounts on any of them, is the ordinary state of a person
       * who is not connected — `false`, which is what the ending of this method already says.
       */
      if (ids.length === 0 && nameless.length === 0 && unreadable.length > 0) {
        throw new BrokerRefusalError(
          `Composio described ${unreadable.length} of its authorization configs for ${toolkit} in a way this deployment cannot read, and ${whose(account)} holds no account on any of the ones it could read, so nothing was withdrawn and their access has not been shown to end. Whether they hold a grant on one of THOSE is outside what either reading settles and disconnecting again meets the same answer: reading those rows in Composio's own dashboard is what says whether anything is left. ${VENDOR_SHAPE_REMEDY}`,
          { cause: everyRefusal(unreadable) },
        );
      }

      /*
       * WHAT CAME BACK IS READ, WHICH IS THE HALF THAT USED TO BE MISSING. Not throwing is not the
       * same as having been done: Composio answers a delete with a `success` saying whether it
       * performed one, and a `false` there means the account is still attached and no revocation
       * job was started. It is counted as a refusal — into the same list a thrown vendor error
       * lands in — so that the sentence below reports it as an account that was not withdrawn,
       * which is exactly what it is. See {@link withdrawalDeclined}.
       *
       * INSIDE THE LOOP AND OUTSIDE {@link askVendor}, deliberately. `askVendor` wraps the
       * `await vendor.*` and nothing else, because everything it translates is a fault raised
       * inside the vendor's package; the refusal below is this file's own reading of a reply that
       * arrived intact, and it already carries an authored sentence.
       */
      const refused = await askForEach(ids, async (id) => {
        const answer = await askVendor(
          {
            outcome: `one of this person's ${toolkit} accounts was not withdrawn`,
            app: toolkit,
          },
          () => vendor.connectedAccounts.delete(id, { revoke_on_delete: true }),
        );
        const declined = withdrawalDeclined(answer, toolkit);
        if (declined !== null) throw declined;
      });

      if (refused.length > 0 || nameless.length > 0 || unreadable.length > 0) {
        /*
         * A PARTIAL WITHDRAWAL IS A FAILURE AND NOT A `true`, and the reason is the row this throw
         * protects. `store.ts` revokes and only then deletes the `composio_connections` row, which
         * is the only thing in this deployment that names which app this person connected. Answer
         * `true` here on a partial and that row is deleted, the trail records a disconnection, and
         * the account this call could not end is left live with nothing pointing at it — the exact
         * state the store's revoke-before-delete order exists to make impossible. Throwing leaves
         * the row standing, so pressing disconnect again is a second attempt with everything the
         * first one had, and the accounts already gone are no longer in the listing, so the retry
         * converges rather than repeating.
         *
         * WHICH IS ALSO WHY IT IS NOT A `true` WITH A GRUMBLE. Nothing was disconnected in the
         * sense the person asked about: their app still answers. The count is in the sentence
         * because "some of your accounts were withdrawn" is the one thing a reader cannot work out
         * for themselves, and EVERY refusal the loop met is kept as `cause` for whoever is reading
         * a log rather than a page — see {@link everyRefusal} for why all of them rather than the
         * first, which is what this used to keep.
         *
         * AND THE TWO WAYS A GRANT SURVIVES ARE NOT THE SAME ADVICE. An account Composio refused is
         * one a second press reaches, which is what "disconnecting again" is worth saying about. An
         * account it described with no id is not: the row will be as unnameable next time, so the
         * only honest instruction is the one that does not run through this page at all.
         *
         * WHICH IS WHY THEY ARE TWO INDEPENDENT CLAUSES AND NOT A CHAIN. They were an `if`/`else
         * if`, so one person holding both kinds — a nameless row beside a refused one, which is one
         * listing away from either on its own — was told only that "disconnecting again meets them
         * unchanged". That sentence is true of the row with no id and false of the refused account
         * sitting next to it, and it is the sentence deciding whether they press the button again:
         * the one remedy that would actually have ended the refused grant was withheld by the
         * presence of a row it says nothing about. Two facts about two different accounts cannot
         * take turns. {@link ComposioBroker.deleteAuthConfig} writes the identical pair as two
         * independent `if`s one method up, and the paragraph above already described these as two
         * remedies — the chain was the only thing disagreeing.
         *
         * THE REACHABLE REMEDY GOES FIRST, matching that method's order, because it is the one the
         * reader can act on from the page they are standing on.
         *
         * AND THE DENOMINATOR IS THE ACCOUNTS, NOT THE ROWS. It was `accounts.length`, which is how
         * many rows the listing handed over, and a listing that named one account twice is a
         * listing with more rows than accounts — see {@link withdrawableAccounts}. "Withdrew 1 of
         * this person's 2 accounts" over one account that is gone is a count nothing measured, in
         * the sentence a reader is meant to act on. The two halves this call actually holds are the
         * accounts it could name and the ones it could not, and their sum is the set.
         */
        const accountsHeld = ids.length + nameless.length;
        const left: string[] = [];
        if (refused.length > 0) {
          left.push(
            "Disconnecting again asks only for the accounts that are left.",
          );
        }
        if (nameless.length > 0) {
          left.push(
            `Composio described ${nameless.length} of them with no id at all, so this deployment has no way to name those in a withdrawal and disconnecting again meets them unchanged: removing them in Composio's own dashboard is what ends them.`,
          );
        }
        /*
         * AND A CONFIG ROW THAT COULD NOT BE READ IS ITS OWN CLAUSE, because it is a fact about a
         * different thing from all of the above. Every sentence before this one counts ACCOUNTS
         * that were looked at; this one says that the set of accounts looked at may not have been
         * the set — a config of this deployment's, sitting behind a row whose id or name Composio
         * sent unreadably, is one the listing was never scoped to. The grants already withdrawn
         * stay withdrawn, which is why this arrives after them rather than instead of them.
         */
        if (unreadable.length > 0) {
          left.push(
            `Composio also described ${unreadable.length} of its authorization configs for ${toolkit} in a way this deployment cannot read, so any grant of theirs on one of those was never in the question and disconnecting again meets the same answer: reading those configs in Composio's own dashboard is what says whether anything is left.`,
          );
        }
        throw new BrokerRefusalError(
          `Composio withdrew ${ids.length - refused.length} of ${whose(account)}'s ${accountsHeld} accounts for ${toolkit} and their access to it has not been shown to end. ${left.join(" ")}`,
          { cause: everyRefusal([...refused, ...nameless, ...unreadable]) },
        );
      }

      /*
       * THE ACCOUNTS WITHDRAWN, WHICH IS THE SAME NUMBER BY A HONESTER ROUTE. Reaching this line
       * means nothing refused and nothing was nameless, so the rows and the accounts differ only
       * where the listing repeated one — and `true` is a claim about having asked the vendor to
       * withdraw something, which is exactly what `ids` counts.
       */
      return ids.length > 0;
    },
  } satisfies Pick<
    ComposioBroker,
    | "grantIsLocal"
    | "authorizations"
    | "authProviderOf"
    | "grantsFor"
    | "authorize"
    | "isConnected"
    | "revoke"
  >;
}

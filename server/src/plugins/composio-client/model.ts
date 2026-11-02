import type { BrokerApp, FieldScheme } from "../broker";
import type { ComposioResult } from "../composio";
import type {
  AccountRow,
  CheckedAuthConfig,
  VendorAccountStatus,
  VendorAuthConfig,
  VendorTool,
  VendorToolkitDetail,
} from "../composio-vendor";

/**
 * The Composio client's shapes and constants: the vendor seam it is built over, and the names and
 * limits its methods share. Split out of `../composio-adapter.ts`, which re-exports what it always
 * exported. No `@composio/core` here; the adapter is still the one file that imports it.
 */

/**
 * The one file in `server/src` that imports `@composio/core`, and what it owes the rest of them.
 *
 * `./composio` describes calling an action and `./broker` describes everything that has to be true
 * before one can be called; both are written as narrow projections that name no vendor type, so
 * that the SDK's shape — its constructor, its retries, its zod schemas and whatever the next
 * version renames — is confined here. This module is the adapter that satisfies both from one
 * client. A second importer of `@composio/core` under `server/src` would undo that, because the
 * point of a single import site is that a version bump has exactly one file to be read against.
 *
 * NO SESSION IS EVER CREATED, AND THAT IS A SECURITY BOUNDARY RATHER THAN A PREFERENCE. The SDK's
 * `composio.create(...)` and `sessions.create(...)` open a Composio tool-router session, and a
 * session brings Composio's own hosted surface with it — a remote shell and a Python sandbox that
 * this deployment neither asked for, cannot see into, and could not audit if a model reached them.
 * Everything below is a plain per-call request carrying a user id. A `create` of a session
 * anywhere in this file is a defect, not an optimisation, and it will not look like one: the
 * session API is the shortest path to most of what this file does the long way.
 *
 * EVERY LISTING PASSES AN EXPLICIT LIMIT AND EVERY LISTING IS READ TO THE END OF ITS CURSOR.
 * Composio's default page is 20, which is smaller than the number of actions Gmail alone publishes,
 * and through the SDK's tool wrapper the default did a second thing as well: `getRawComposioTools`
 * set `important=true` whenever a toolkit query arrived with no limit, no tags and no search
 * (`@composio/core` 0.18.1, `src/models/Tools.ts:505-515`), so an omitted limit silently narrowed
 * the answer to the vendor's own "important" subset and nothing in the result said a filter had
 * been applied. {@link LISTING_LIMIT} is the documented page ceiling and therefore the fewest round
 * trips a listing can be read in.
 *
 * AND THE LIMIT IS A PAGE RATHER THAN THE ANSWER, WHICH IS WHAT CHANGED. Two of the four listings
 * here used to meet a full page and refuse it, because the SDK wrapper around them could not ask
 * for a second — one takes no cursor, the other drops the response's. That was never true of the
 * vendor: both raw endpoints carry `cursor` and `next_cursor`, and Composio publishes more than
 * {@link LISTING_LIMIT} toolkits, so the catalogue refusal fired on every call and the app picker
 * showed an operator nothing at all. All four now go through {@link everyRowOf}, which follows the
 * cursor until the vendor stops offering one and refuses rather than truncates when it cannot.
 *
 * THE API KEY NEVER LEAVES THIS FILE. It arrives as {@link createComposioClient}'s only argument,
 * goes straight into the vendor's constructor, and is held from there on by the vendor's client
 * inside a closure. Nothing below logs it, no thrown message quotes it, and neither of the two
 * returned objects carries a field that could be read back to it — they expose eight methods and
 * no state. A key in a log line is a key in a log aggregator, and a key in an error message is a
 * key in an audit row and in a model's context.
 */

/**
 * What this adapter needs of `@composio/core`'s client, written as a shape rather than as a class.
 *
 * A TEST SATISFIES IT WITH AN OBJECT LITERAL, which is the entire argument for it and the reason
 * {@link buildComposioClient} takes one of these instead of an API key. The vendor's own client
 * cannot be constructed without a key and answers nothing without a network, so an adapter that
 * built its own client would be an adapter no test could reach — and this is the file where the
 * field names, the argument order and the refusal below would go wrong unnoticed.
 *
 * Every member is written with METHOD syntax deliberately. Method parameters are compared
 * bivariantly, so a real `Composio` — whose signatures carry optional request-options arguments
 * and wider parameter types than the calls here use — satisfies this without a cast.
 *
 * THE TWO DELETES ARE NOT `Composio`'s, AND THAT IS THE ONE PLACE THIS SHAPE DIVERGES FROM IT. Both
 * of the vendor's own wrappers hard-code the request body they send — `this.client.authConfigs
 * .delete(nanoid, undefined, requestOptions)` and the same line for connected accounts
 * (`@composio/core` 0.18.1, `src/models/AuthConfigs.ts:303-311` and
 * `src/models/ConnectedAccounts.ts:532-540`) — so through them the `revoke_on_delete` parameter
 * cannot be passed at all, and both calls soft-delete while the grant at Google or Slack stands. So
 * the shape below asks for the underlying client's signature instead, and
 * {@link createComposioClient} satisfies it from `composio.getClient()`. See
 * {@link ComposioBroker.revoke} for what that flag is and what its absence made this deployment
 * claim.
 */
export type ComposioVendor = {
  tools: {
    /**
     * Every action of one app, one page at a time, THROUGH THE RAW CLIENT RATHER THAN THE WRAPPER.
     *
     * `getRawComposioTools` was here and could not be paged. `ToolListParamsSchema` names no cursor
     * field at all (`@composio/core` 0.18.1, `src/types/tool.types.ts:257-266`) and the method ends
     * `tools.items.map(...)` (`src/models/Tools.ts:561`), dropping the response's `next_cursor`
     * before any caller sees it — so through the wrapper a page at {@link LISTING_LIMIT} and a
     * listing longer than one were the same array, and `./composio` refused rather than commit a
     * fragment as the whole truth about an app. The raw client is the difference: `ToolListParams`
     * carries `cursor`, "a base64 encoded string of the page and limit", and `ToolListResponse`
     * carries `next_cursor` (`@composio/client` 0.1.0-alpha.76, `resources/tools.d.ts:421-432` and
     * `:200-204`). The request IS expressible, and {@link everyRowOf} makes it.
     *
     * WHAT THE WRAPPER WAS DOING THAT THIS HAS TO KEEP DOING IS TWO PARAMETERS AND ONE NO-OP.
     * `toolkit_versions` is the SDK's own `toolkitVersions` config, which defaults to "latest"
     * (`src/utils/config-defaults/ConfigDefaults.node.ts`) and was forwarded on every listing it
     * made (`src/models/Tools.ts:548`); it decides which `version` each action comes back with,
     * which is the value a later call sends back to Composio, so it is passed here as the literal
     * the default is. `important` is the one this file already knew about and is now simply not
     * named: the wrapper set it to "true" whenever a toolkit query carried no limit (`:505-515`),
     * which NARROWS the answer to a featured subset that nothing in the answer declares. And the
     * no-op is `applyDefaultSchemaModifiers`, which returns its argument untouched unless
     * `dangerouslyAllowAutoUploadDownloadFiles` is on (`:242-248`); it defaults off
     * (`ConfigDefaults.node.ts`) and {@link createComposioClient} does not turn it on — which is
     * the premise `./composio`'s file-upload guard is written on.
     *
     * AND `ToolSchema.parse` IS GONE WITH IT, WHICH IS A GAIN AND A COST, BOTH WRITTEN DOWN
     * ELSEWHERE. The gain is that the parse STRIPPED every schema key its `ParametersSchema` did
     * not name before any caller could see it — see {@link ComposioAction.inputParameters}, where
     * that loss was recorded as unavoidable and where the fix was named as this exact call. The
     * cost is that nothing validates the row: {@link actionOf} carries every check now, including
     * the container, and {@link pageOf} carries the envelope.
     */
    list(query: {
      toolkit_slug: string;
      limit: number;
      toolkit_versions: "latest";
      /** Where the last page left off, ABSENT on the first request rather than undefined. */
      cursor?: string;
    }): Promise<{
      /**
       * `unknown` BECAUSE NOTHING HAS LOOKED AT IT, which is the difference between this listing
       * and the two the SDK still serves. Their transformers open `response.items.map(...)`, so a
       * malformed envelope dies inside the vendor's package; a generated client parses the body and
       * returns it. {@link pageOf} is where that is answered.
       */
      items?: unknown;
      /** The vendor's own word for "there is another page", read by {@link everyRowOf}. */
      next_cursor?: unknown;
    } | null>;
    getRawComposioToolBySlug(
      slug: string,
      options?: { version?: string },
    ): Promise<VendorTool>;
    execute(
      slug: string,
      body: {
        arguments: Record<string, unknown>;
        userId: string;
        version: string;
        /**
         * WHICH ACCOUNT OF THE PERSON'S TO RUN IN, absent where any of theirs will do.
         *
         * `ToolExecuteParams` carries it and `Tools.execute` forwards it to the client
         * (`@composio/core` 0.18.1), so this is the wire's own field rather than one this
         * deployment composes. Why a verification cannot go without it is written at
         * {@link ComposioActions.execute}: a person and an app do not name an account, and one
         * person may hold several for one app.
         */
        connectedAccountId?: string;
      },
    ): Promise<ComposioResult>;
  };
  toolkits: {
    /**
     * The app catalogue, one page at a time, THROUGH THE RAW CLIENT FOR THE SAME REASON.
     *
     * AND THIS IS THE ONE THAT WAS BROKEN IN FRONT OF PEOPLE. `Toolkits.getToolkits` does forward a
     * `cursor` (`@composio/core` 0.18.1, `src/models/Toolkits.ts:68`) — so the wrapper could ASK
     * for a second page — but `transformToolkitListResponse` returns `response.items.map(...)`, a
     * bare array (`src/utils/transformers/toolkits.ts:16-43`), so there is no cursor to put in it.
     * One half of a pager is not a pager, and `fetchDirectory` refused a full page because it could
     * not tell a complete catalogue from a truncated one. Composio publishes more than
     * {@link LISTING_LIMIT} toolkits, so that refusal fired on the FIRST call, every time, and an
     * operator opening the app picker saw no apps at all. `ToolkitListResponse` carries
     * `next_cursor` and `ToolkitListParams` carries `cursor` (`@composio/client` 0.1.0-alpha.76,
     * `resources/toolkits.d.ts:322-326`, `:467-478`), so the whole request was expressible the
     * entire time.
     *
     * `sort_by` IS THE WIRE'S SPELLING OF WHAT WAS `sortBy`, and it still matters even though the
     * listing is no longer finite. What it buys now is order rather than coverage: the rows reach a
     * picker in the order Composio thinks people want them, and the page ceiling in
     * {@link PAGE_CEILING} is the one case left where being cut off is possible at all.
     *
     * NO SEARCH TERM, WHICH IS THE SAME DECISION FOR A DIFFERENT REASON THAN BEFORE. It used to be
     * that the SDK's params named no search field and the parse stripped what it did not name, so a
     * term passed here would vanish before the request. `ToolkitListParams` DOES name `search`
     * (`:480-484`), so that is no longer the argument. The argument is that the catalogue is held
     * for ten minutes and searched in this process by both of its callers — the picker and the
     * enable route's slug check — and a per-term request would be a per-term cache. Searching over
     * the held rows is this deployment's own job and stays so.
     */
    list(query: {
      limit: number;
      sort_by: "usage";
      /** Where the last page left off, ABSENT on the first request rather than undefined. */
      cursor?: string;
    }): Promise<{
      /** `unknown` for the reason the action listing's is — see {@link pageOf}. */
      items?: unknown;
      /** The vendor's own word for "there is another page", read by {@link everyRowOf}. */
      next_cursor?: unknown;
    } | null>;
    /**
     * ONE app, read for the one thing the catalogue listing does not carry: what it asks a person.
     *
     * The listing above answers which apps exist and which scheme each of them authenticates with;
     * it does not answer which boxes a form for that scheme needs. That is published per app and it
     * moves — one app wants a key, the next wants a key and a workspace subdomain — so it is asked
     * for at the moment a person presses Connect rather than derived from anything held here. See
     * {@link ComposioBroker.connectionFields}.
     *
     * NO PAGE AND NO CURSOR, because a toolkit is one object rather than a listing: this is the one
     * vendor read in this file where there is no second page to be mistaken for the whole answer.
     */
    retrieve(slug: string): Promise<VendorToolkitDetail>;
  };
  authConfigs: {
    list(query: {
      toolkit: string;
      limit: number;
      /**
       * Ask for the disabled ones too, ALWAYS, which is why this is the literal and not a boolean.
       *
       * The vendor's listing returns enabled configs unless asked otherwise
       * (`AuthConfigListParamsSchema.showDisabled`, `@composio/core` 0.18.1,
       * `src/types/authConfigs.types.ts:124-131`), and a config this listing cannot see is a config
       * {@link ComposioBroker.ensureAuthConfig} creates a second of — which is the exact split that
       * method exists to prevent, arriving through the one door it was not watching. Every question
       * this file asks of the listing is better served by seeing a disabled config and saying so:
       * creation must not duplicate it, deletion must remove it, and consent must refuse against
       * it rather than mint a link that cannot work.
       */
      showDisabled: true;
      /**
       * Where the last page left off, ABSENT on the first request rather than undefined.
       *
       * `AuthConfigListParamsSchema` names it and `AuthConfigs.list` forwards it
       * (`@composio/core` 0.18.1, `src/types/authConfigs.types.ts:124-131`,
       * `src/models/AuthConfigs.ts:95`), which is the fact that decides how a truncated answer is
       * handled here: the catalogue refuses a full page because it has no way to ask for the next
       * one, and this listing does. See {@link everyRowOf}.
       */
      cursor?: string;
    }): Promise<{
      items: VendorAuthConfig[];
      /**
       * The vendor's own word for "there is another page", which was being discarded at this type.
       *
       * `unknown` RATHER THAN `string | null`, because the transformer writes `response.next_cursor
       * ?? null` (`src/utils/transformers/authConfigs.ts:80`) and that is the wire's value with no
       * check on it — a numeric cursor reaches {@link everyRowOf} exactly as Composio sent it, which
       * is the one shape that could be read as the end of a listing that has not ended.
       *
       * `AuthConfigListResponseSchema` carries it (`@composio/core` 0.18.1,
       * `src/types/authConfigs.types.ts:129-133`) and
       * `transformAuthConfigListResponse` fills it in from `next_cursor` on every answer
       * (`src/utils/transformers/authConfigs.ts:72-80`). Omitting it here did not make the
       * truncation go away; it made it unobservable, because a field a projection does not name is
       * a field no caller and no test of a caller can ask about. {@link everyRowOf} reads it, and
       * follows it until the vendor stops offering one — so a listing at {@link LISTING_LIMIT} is
       * no longer a fragment this file can mistake for the whole answer.
       */
      nextCursor?: unknown;
    }>;
    /**
     * Create one auth config, and hand back the id Composio gave it.
     *
     * `Promise<unknown>` UNTIL NOW, AND THE ANSWER WAS NEVER LOOKED AT. That was read as harmless
     * because nothing here needs the id — the next listing finds the config by its name. It is not:
     * `transformCreateAuthConfigResponse` builds what this resolves to by dereferencing
     * `response.auth_config.id` and `response.toolkit.slug` (`@composio/core` 0.18.1,
     * `src/utils/transformers/authConfigs.ts:96-106`), so a drift in the answer's SHAPE raises a
     * `TypeError` inside the vendor's package — after the create has gone out and been answered.
     * {@link ComposioBroker.ensureAuthConfig} then reported that no config had been created, over a
     * config standing at Composio that nothing in this deployment names. Reading the reply is what
     * makes the difference between "nothing was created" and "something may have been" a fact
     * rather than an assumption.
     *
     * `id?: unknown` FOR THE REASON EVERY OTHER FIELD IN THIS PROJECTION IS ONE: the `transform()`
     * around it is the warn-only kind (`src/utils/transform.ts:26-36`), so
     * `CreateAuthConfigResponseSchema` spelling the id a required string is the answer Composio
     * MEANS to send rather than a fact about the one that arrived.
     *
     * NULLABLE THOUGH THE VENDOR'S OWN DECLARATION IS NOT, exactly as the account delete below is:
     * the generated client parses the body and returns it, and reading a field off a `null` would
     * be a crash carrying a sentence that reads like a stack trace.
     */
    create(
      toolkit: string,
      /**
       * THE UNION, BECAUSE THE MANAGED TYPE IS RIGHT FOR ONE KIND OF APP AND WAS SENT FOR ALL OF
       * THEM. A self-registering app has no Composio-owned OAuth client behind it and a key app
       * has no consent screen to send anybody to, so both are created as custom configs — carrying
       * the scheme, and never a credential, which is per-connection rather than per-config. The
       * managed shape has no field to name a scheme with, which is why this is a union of two
       * shapes rather than one shape with an optional field.
       */
      options:
        | { type: "use_composio_managed_auth"; name: string }
        | {
            type: "use_custom_auth";
            authScheme: FieldScheme | "DCR_OAUTH";
            name: string;
            /**
             * EMPTY, AND PRESENT, WHICH IS NOT THE CONTRADICTION IT LOOKS LIKE.
             *
             * Neither config this deployment creates carries a secret — a self-registering app
             * needs none and a key app's key belongs to each connection made against the config
             * rather than to the config — but `CreateCustomAuthConfigParamsSchema` spells
             * `credentials` REQUIRED (`@composio/core` 0.18.1,
             * `src/types/authConfigs.types.ts:52-65`) and `AuthConfigs.create` `safeParse`s its
             * options before it builds a body (`src/models/AuthConfigs.ts:132-137`). So an absent
             * field is not "no credentials sent"; it is a `ValidationError` raised inside the
             * vendor's package with no request made at all. The empty record is what carries
             * nothing THROUGH that check, and the type says so rather than leaving the next reader
             * to discover it from a failed enable.
             */
            credentials: Record<string, never>;
          },
    ): Promise<{ id?: unknown } | null>;
    /**
     * Delete one auth config, and ask for the upstream credentials on it to be revoked too.
     *
     * THE SAME TRAP AS THE ACCOUNT DELETE BELOW, one level up. The endpoint "soft-deletes an
     * authentication configuration" and revokes "the upstream credentials of every connection using
     * this auth config" only when the flag is passed (`@composio/client` 0.1.0-alpha.76,
     * `resources/auth-configs.d.ts:60-72` and `:651-659`), so a delete without it leaves every
     * grant that was ever made against this config alive at the provider.
     *
     * WHICH IS WHY IT IS PASSED HERE EVEN THOUGH THE ACCOUNTS WERE ALREADY ASKED FOR INDIVIDUALLY.
     * Removing an app revokes each connected person first and drops the config last, and that loop
     * reaches exactly the people this deployment has a `composio_connections` row for. An account
     * whose row drifted — cleared by a confirm that Composio answered `false` to, or lost with a
     * database this deployment restored — is invisible to it and still live at the vendor. This is
     * the one call that reaches those, and there is nothing on this config that removing the app is
     * not meant to end.
     *
     * AND ITS REPLY CARRIES NO VERDICT, WHICH IS WHY THIS ONE IS NOT READ WHERE THE ACCOUNT DELETE
     * BELOW IS. That is the obvious question to ask of a call whose answer is awaited and dropped —
     * {@link ComposioBroker.revokeAccount} exists to argue that not throwing is not the same as
     * having been done, and the same gap one level up would have `removeServer` deleting the app's
     * row behind a config that is still standing. It was asked and the answer is in the vendor's own
     * type: `AuthConfigDeleteResponse` has exactly one field, an OPTIONAL `revoke_job_id`, and no
     * `success` (`@composio/client` 0.1.0-alpha.76, `resources/auth-configs.d.ts:377-385`). The
     * account delete's `ConnectedAccountDeleteResponse` does carry `success: boolean` (`:7447-7451`),
     * which is what {@link withdrawalDeclined} reads. There is nothing here to read, so `unknown`
     * is the honest declaration rather than a field this deployment would be inventing.
     *
     * WHAT THE REPLY DOES SAY IS THAT THE REVOCATION IS A BACKGROUND JOB. `revoke_job_id` is
     * "present only when `revoke_on_delete=true`", and the vendor's own comment on it says to track
     * the job and its per-connection results in the Composio dashboard because "a programmatic
     * endpoint to poll this job is not yet generally available". So a clean return here means the
     * config was deleted and the upstream revocations were STARTED — not that they finished. That
     * limit belongs to Composio rather than to this deployment, and it is why `removeServer`'s
     * promise is the one it makes: every account is asked to be withdrawn before anything here is
     * deleted, which is as far as the vendor lets anybody go.
     */
    delete(id: string, params: { revoke_on_delete: true }): Promise<unknown>;
  };
  connectedAccounts: {
    list(query: {
      userIds: string[];
      toolkitSlugs: string[];
      /**
       * Which statuses this particular question is about — see {@link CONNECTED} and
       * {@link REVOCABLE}, which are the only two answers this file gives.
       */
      statuses: VendorAccountStatus[];
      /**
       * Both sharing models, ALWAYS, which is why this is the literal and not the enum.
       *
       * OMITTING IT IS NOT "NO OPINION", in exactly the way an omitted limit is not. The parameter
       * defaults to private accounts only (`ConnectedAccountListParamsSchema.accountType`,
       * `@composio/core` 0.18.1, `src/types/connectedAccounts.types.ts:286-293`), so a person whose
       * account for an app is a SHARED one reads as not connected, is told to connect an app they
       * already have, and — far worse — is invisible to the revoke, which then reports that there
       * was nothing to withdraw while their grant stands. Neither of the two questions this file
       * asks has any reason to care how an account is shared: the gate is about whether this person
       * can act through the app, and the revoke is about ending every account they can act through.
       */
      accountType: "ALL";
      /**
       * Which authorization configs the question is about, ABSENT where it is about all of them.
       *
       * THE TWO QUESTIONS DIFFER HERE TOO, AND ONLY ONE OF THEM MAY ACT. `authConfigIds` is a
       * parameter of the listing (`ConnectedAccountListParamsSchema.authConfigIds`,
       * `@composio/core` 0.18.1, `src/types/connectedAccounts.types.ts:260-264`) forwarded as
       * `auth_config_ids` (`src/models/ConnectedAccounts.ts:117`), and omitting it asks about every
       * config in the project — this deployment's and an operator's hand-made ones alike. That is
       * the right question for {@link ComposioBroker.isConnected}, which only reads whether a person
       * can act through the app, and the wrong one for {@link ComposioBroker.revoke}, which deletes
       * what it finds: see there for why an account on somebody else's config is not this
       * deployment's to end.
       *
       * NEVER THE EMPTY ARRAY. A caller with no configs of its own has nothing to scope TO, and an
       * empty filter is the shape most likely to be read as no filter at all by whatever is on the
       * far side — which would be the unscoped listing arriving through the parameter added to
       * prevent it. `revoke` answers before it asks in that case.
       */
      authConfigIds?: string[];
      limit: number;
      /**
       * Where the last page left off, ABSENT on the first request rather than undefined.
       *
       * `ConnectedAccountListParamsSchema` names it and `ConnectedAccounts.list` forwards it
       * (`@composio/core` 0.18.1, `src/types/connectedAccounts.types.ts:259-266`,
       * `src/models/ConnectedAccounts.ts:118`). This is the listing the paging matters most for:
       * {@link ComposioBroker.revoke} answers `true` for "this person's access has ended", and one
       * page of their accounts is not the set of their accounts. See {@link everyRowOf}.
       */
      cursor?: string;
    }): Promise<{
      /**
       * The id, and `data.displayName` read by name, are the only fields read off an account.
       * `data` and `state.val` also carry the account's tokens, and nothing else is read from them.
       *
       * `transformConnectedAccountResponse` spreads the raw item and overrides the fields it
       * renames (`@composio/core` 0.18.1, `src/utils/transformers/connectedAccounts.ts:52-66`), so
       * `id` and `data` arrive exactly as Composio sent them inside the same warn-only
       * `transform()` as everything else here. An account with no id is the one shape the revoke
       * below cannot act on, and {@link withdrawableAccounts} is what says so about it.
       *
       * THE ROW ITSELF IS AN OBJECT BY CONSTRUCTION, which is why only the fields are in doubt. The
       * same function reads `response.auth_config.id` (`:60`) on its way to building each row, so a
       * row that is not an object raises inside the vendor's code and never reaches this listing.
       */
      items: AccountRow[];
      /**
       * The same truncation signal as the auth-config listing above, from the same vendor schema.
       *
       * `ConnectedAccountListResponseSchema` spells it `nullish`
       * (`src/types/connectedAccounts.types.ts:297-303`) and the transformer sets it on every
       * answer (`src/utils/transformers/connectedAccounts.ts:109-117`). It matters more here than
       * anywhere else in this file: {@link ComposioBroker.revoke} answers `true` for "this
       * person's access has ended", and it used to have seen only one page of the accounts it
       * would have to end. {@link everyRowOf} follows it until there is none left.
       */
      nextCursor?: unknown;
    }>;
    /**
     * Mint one person's connect link against one auth config, with the page to come back to.
     *
     * `link` RATHER THAN `initiate`, AND RATHER THAN `toolkits.authorize`. All three end at a
     * redirect url, and only the choice between them decides whether this deployment keeps working.
     * `toolkits.authorize` takes a user id, a toolkit and an optional auth config id and has no
     * parameter for a callback at all (`@composio/core` 0.18.1, `src/models/Toolkits.ts:333-338`),
     * which is why consent used to end on Composio's hosted page — the address below has nowhere
     * to travel on that call. `initiate` does carry one (`:249`), but the endpoint under it is
     * retired for Composio-managed OAuth on redirectable schemes — cutover 2026-05-08 for new
     * organizations and 2026-07-03 for the rest, after which it throws
     * `ComposioLegacyConnectedAccountsEndpointRetiredError` (`src/models/ConnectedAccounts.ts:146-160`)
     * — and `use_composio_managed_auth` is exactly what {@link ComposioBroker.ensureAuthConfig}
     * creates. `link` is the vendor's own named replacement for that combination, carries the
     * callback, and answers in the same shape.
     *
     * TAKING THE AUTH CONFIG ID IS NOT A COST HERE. It is the one thing `toolkits.authorize` was
     * doing for us, and it did it by listing the configs and creating one at Composio's managed
     * defaults where it found none — which this deployment already does for itself, at enable
     * time, named so an operator can find it in their dashboard. The listing below is that same
     * read; the creation is not repeated, because an app with no config is a state to report
     * rather than one to paper over.
     */
    link(
      userId: string,
      authConfigId: string,
      options: { callbackUrl: string },
    ): Promise<{ redirectUrl?: unknown }>;
    /**
     * Create one person's account from the secret they typed, WITHOUT a consent screen anywhere.
     *
     * THE RAW CLIENT FOR THE REASON BOTH DELETES ARE RAW, and a sharper one. `@composio/core`'s
     * `connectedAccounts.initiate` is the wrapper over this endpoint, and the endpoint under it is
     * retired for the managed-auth path — it throws
     * `ComposioLegacyConnectedAccountsEndpointRetiredError` (`@composio/core` 0.18.1,
     * `src/models/ConnectedAccounts.ts:146-160`) — while `link`, which replaced it, mints a consent
     * url and has nowhere to put a typed value at all. What this flow needs is neither: the person
     * has already typed their credential into a form here, so there is no screen to send them to
     * and nothing to come back from. `@composio/client`'s own create takes the state directly
     * (`0.1.0-alpha.76`, `resources/connected-accounts.d.ts:33`, `:7502-7511`), which is the whole
     * of what this call is.
     *
     * NO `validate_credentials`, AND ITS ABSENCE IS DELIBERATE RATHER THAN AN OVERSIGHT. The
     * parameter exists on the same body and the vendor marks it EXPERIMENTAL (`:7505-7509`).
     * Whether a typed key actually works is settled here by making a call with it rather than by
     * asking Composio to grade it, because a connection Composio accepts is not a connection that
     * works: a wrong value comes back `ACTIVE`.
     *
     * `id` AND `status` READ AS `unknown`, for the reason every other vendor field in this
     * projection is. The generated client declares both as required
     * (`ConnectedAccountCreateResponse`, `:121-146`), which is the schema's promise about what
     * Composio means to send rather than a fact about what arrived — and the id is the one field
     * this whole call exists to answer, so a missing one is a refusal here rather than an
     * `undefined` handed on as the account somebody is meant to be able to undo.
     */
    create(body: {
      auth_config: { id: string };
      /**
       * The person, and the secret they typed, in the shape the vendor's own builder assembles.
       *
       * `state` IS `unknown` BECAUSE WHAT GOES IN IT IS THE APP'S QUESTION RATHER THAN THIS FILE'S
       * ANSWER. The generated client declares it as a fourteen-member union keyed on the scheme,
       * each member's `val` carrying whatever fields that app publishes plus `[k: string]: unknown`
       * (`@composio/client` 0.1.0-alpha.76, `resources/connected-accounts.d.ts:7551`, `:8083-8086`)
       * — so naming a shape here would be this file asserting which boxes an app asks for, which is
       * exactly the thing {@link ComposioBroker.connectionFields} exists to go and ask.
       */
      connection: { user_id: string; state: unknown };
    }): Promise<{ id?: unknown; status?: unknown }>;
    /**
     * Delete one connected account, and ask for the grant behind it to be revoked too.
     *
     * WITHOUT THE FLAG THIS CALL DOES NOT REVOKE ANYTHING, and that is the vendor's own description
     * of it: it "soft-deletes a connected account by marking it as deleted in the database", which
     * "prevents the account from being used for API calls but preserves the record"
     * (`@composio/client` 0.1.0-alpha.76, `resources/connected-accounts.d.ts:59-72`). The refresh
     * token at Google or Slack survives that untouched. Every path in this deployment that claims
     * to end somebody's access — a person disconnecting, an administrator removing an app, a person
     * being offboarded — runs through here, so an unflagged delete made all three of those claims
     * false at once and wrote `true` into the audit trail beside them.
     *
     * WHAT THE FLAG BUYS IS A REQUEST AND NOT A RESULT, which is the whole reason
     * {@link ComposioBroker.revoke}'s answer is named the way it is. The upstream revocation runs as
     * a background job; the response carries its `revoke_job_id` and the vendor documents that no
     * generally available endpoint polls it (`:7447-7459`). Nothing here can say the provider tore
     * the refresh token up, and nothing here pretends to.
     *
     * BUT THE ANSWER DOES SAY WHETHER COMPOSIO DID ITS OWN HALF, AND THAT WAS BEING DISCARDED.
     * `ConnectedAccountDeleteResponse` carries a REQUIRED `success: boolean`, "indicates whether
     * the connected account was successfully deleted" (`@composio/client` 0.1.0-alpha.76,
     * `resources/connected-accounts.d.ts:7445-7459`). This used to be `Promise<unknown>`, read for
     * nothing, on the argument that no field on the answer could support a stronger claim than "we
     * asked". That argument is true of the REVOCATION and false of the DELETE: a 200 carrying
     * `success: false` is Composio saying it did not delete the account, so the background job the
     * flag asks for was never started either — and {@link ComposioBroker.revoke} answered `true`
     * over the top of it while the grant stood at the provider. Reading it is not a stronger claim
     * than "we asked"; it is the difference between having asked and having been refused.
     *
     * DECLARED `success?: unknown` RATHER THAN AT THE VENDOR'S OWN `boolean`, for the reason every
     * other field in this projection is: the generated client parses the body and hands it over, so
     * "required" is the schema's promise about what Composio means to send rather than a fact about
     * what arrived. {@link withdrawalDeclined} is where the three answers are told apart.
     *
     * `revoke_job_id` IS DELIBERATELY NOT READ, and its absence is deliberately not a refusal. The
     * same declaration marks it optional and says it is present "only when `revoke_on_delete=true`"
     * — which says when it CAN appear, not that it always does — so a guard on it would turn every
     * withdrawal Composio accepted into a permanent failure the first time they stopped sending it,
     * which is the shape of mistake this file has already made twice in the other direction.
     *
     * NULLABLE AND OPTIONAL THOUGH THE VENDOR'S OWN DECLARATION IS NEITHER, because the generated
     * client has two answers it resolves with no document: a 204 becomes `null` and a JSON reply
     * carrying `content-length: 0` becomes `undefined` (`@composio/client` 0.1.0-alpha.76,
     * `src/internal/parse.ts:16-42`). Declaring this at the vendor's `ConnectedAccountDeleteResponse`
     * would be the same assertion-over-a-wire-value every other field here refuses to make, and it
     * would hide the one case {@link withdrawalDeclined} has to tell from a refusal.
     */
    delete(
      id: string,
      params: { revoke_on_delete: true },
    ): Promise<{ success?: unknown } | null | undefined>;
  };
};

/**
 * The suffix every auth config this deployment creates carries, so a reader can tell whose it is.
 *
 * An auth config is visible in Composio's own dashboard beside any that were made by hand there,
 * and the two are otherwise indistinguishable. The name is the only field this deployment gets to
 * choose, so it is where the provenance goes.
 */
export const CONFIG_SUFFIX = "(OpenBot)";

/**
 * How many different unrecognised statuses one refusal names before it stops naming them.
 *
 * The set it bounds is as large as the app's config listing, which is paged — see
 * {@link everyRowOf} — so without a bound the length of an operator's refusal is decided by how
 * many authorization configs somebody made. Five is past the number of distinct words this can
 * plausibly be about: `AuthConfigRetrieveResponseSchema` names two, and a vendor that has invented
 * five more at once is a package upgrade rather than a sentence to read.
 */
export const STATUSES_NAMED = 5;

/**
 * Whether this deployment made that auth config, which is the question every decision here turns on.
 *
 * THE SUFFIX IS WRITTEN FOR EXACTLY THIS AND WAS NOT BEING READ. Both callers used to take the
 * first row of an unordered listing, and the two consequences are of different sizes. Removing an
 * app deleted whatever came back first — which can be a config an operator built by hand, with
 * their own scopes and their own tool restrictions, taking every account on it down with it.
 * Beginning a connection attached a person to whatever came back first — which can be a
 * configuration nobody here chose and this deployment cannot see or tighten. And because the order
 * is the vendor's, the two calls can resolve DIFFERENT rows, so an app could be removed while
 * people kept connecting against a config the removal left behind.
 *
 * MATCHED ON THE END OF THE NAME rather than on the whole of it, because the rest of the name is an
 * app's title as an administrator saw it at enable time and titles are edited. The suffix is the
 * part this file writes. Trailing whitespace is tolerated for the same reason it is tolerated
 * anywhere a human-edited string is compared: a name that picked up a space in a dashboard is the
 * same config.
 *
 * IT TAKES A {@link CheckedAuthConfig} AND NOT A {@link VendorAuthConfig}, which is what makes this
 * one line honest. A predicate cannot refuse — it answers true or false — so reading a name the
 * vendor may not have sent here could only ever have meant silently answering `false`, and `false`
 * from this function means "somebody else's config": untouched by a removal, and satisfying the
 * check that stops a second one being created. {@link readableConfigs} is where the absence becomes a
 * sentence instead, upstream of every caller.
 */
export function madeHere(config: CheckedAuthConfig): boolean {
  return config.name.trimEnd().endsWith(CONFIG_SUFFIX);
}

/**
 * The statuses that answer "is this person connected", which is the narrow question of the two.
 *
 * ACTIVE ONLY. An `INITIATED` account is somebody who started an authorization and never finished
 * it, and an `EXPIRED` or `REVOKED` one is a grant that no longer opens anything; counting any of
 * them as connected tells a person their app is wired up and then fails every call they make with
 * it.
 */
export const CONNECTED: VendorAccountStatus[] = ["ACTIVE"];

/**
 * The statuses that answer "what is there to revoke", which is a deliberately wider question.
 *
 * THE TWO QUESTIONS ARE NOT THE SAME ONE, AND TREATING THEM AS ONE LEFT GRANTS STANDING. This used
 * to be a single ACTIVE listing shared by both, on the argument that "connected" and "there is
 * something to revoke" are the same fact. They are not. A half-finished consent can already have
 * been granted at the provider with the callback never delivered; an `EXPIRED` account is an access
 * token that lapsed and a refresh token that did not; an `INACTIVE` one is a live grant the vendor
 * has set aside. None of them should tell a person they are connected, and every one of them is
 * something whose withdrawal is the entire point of pressing disconnect.
 *
 * `REVOKED` IS THE ONE STATUS LEFT OUT, and left out on purpose rather than forgotten. It is the
 * only value that positively says the grant is already gone, so including it would have this
 * deployment delete a tombstone and then record that it ended somebody's access — the one way the
 * audit field can be made to lie in the direction nobody would check.
 */
export const REVOCABLE: VendorAccountStatus[] = [
  "INITIALIZING",
  "INITIATED",
  "ACTIVE",
  "FAILED",
  "EXPIRED",
  "INACTIVE",
];

/**
 * How long one catalogue answer is served to everybody who asks for it.
 *
 * THE CATALOGUE IS READ ONCE PER SEARCH KEYSTROKE OTHERWISE, WHICH IS WHAT THIS IS ABOUT. The admin
 * picker debounces its search field and then asks `/composio/apps`, and that route filters in this
 * process precisely because Composio's toolkit listing takes no search term — so every distinct term
 * a person types is another request for the whole directory, a few hundred rows of it, to answer a
 * question about one. Typing "linear" pulls the catalogue four or five times, and enabling the app
 * afterwards pulls it once more.
 *
 * TEN MINUTES BECAUSE OF WHAT GOES STALE IN IT. The rows are Composio's published toolkits: an app
 * is added to their catalogue or its action count moves every so often, never within one
 * administrator's sitting, and the worst a stale row can do here is show a description or a count
 * that is a few minutes behind. Held for a working session it would be a cache nobody could explain
 * to an operator whose new app is missing; held for seconds it would not survive the debounce it
 * exists for.
 */
export const DIRECTORY_TTL_MS = 10 * 60 * 1000;

/**
 * The held catalogue as a copy nobody else holds, which is what makes handing it out safe.
 *
 * WHAT WAS HANDED OUT WAS THE CACHE ITSELF. One array of one set of row objects was returned to
 * every caller for ten minutes, so a route that sorted the rows in place reordered the catalogue for
 * everybody, and one that edited a row — a title trimmed for display, a description truncated —
 * edited what the next caller would read as Composio's answer. Nothing does that today, which is
 * precisely the problem with leaving it: the first caller that does will have changed a cache it
 * had no idea it was holding, and the fault will surface in the NEXT request rather than its own.
 *
 * `categories` AND `connection` ARE BOTH COPIED, because a shallow spread of the row would hand
 * either of them on by reference. This used to copy the array and say it was "the one field here
 * that is not a primitive", which is what let the other one through: {@link BrokerConnection} is an
 * object in every one of its five shapes, so the row's spread carried one object out of the cache
 * and into every caller for the whole ten minutes — the exact sharing this function exists to end,
 * surviving in the field it is worst in. `connection` is what the app picker hides an `unsupported`
 * app by and what the enable route branches on to decide whether to create an authorization config
 * at all, so a caller that edited the object it was handed would be editing what those two
 * decisions read of every later caller's rows.
 *
 * SPREAD RATHER THAN NAMED PER KIND, so that adding a member to the union — or a field to one of
 * them — cannot quietly reintroduce the sharing. The spread of a union widens to the union, which
 * is the one shape here a `switch` on `kind` would have to be kept in step with by hand.
 *
 * COPIED RATHER THAN FROZEN, which was the other candidate. Freezing would make the sharing safe by
 * making a mutation throw, but the type says `BrokerApp[]` and a caller is entitled to sort a list
 * it was given; turning a reasonable caller into a `TypeError` is a worse answer than a few hundred
 * small objects, which is nothing beside the request this cache exists to avoid.
 */
export function copyOf(apps: Promise<BrokerApp[]>): Promise<BrokerApp[]> {
  return apps.then((held) =>
    held.map((app) => ({
      ...app,
      categories: [...app.categories],
      connection: { ...app.connection },
    })),
  );
}

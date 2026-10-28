import { Composio } from "@composio/core";
import type { ComposioBroker, ConnectedAppBroker } from "./broker";
import type { ComposioActions } from "./composio";
import { accountMethods } from "./composio-client/accounts";
import { actionsFor } from "./composio-client/actions";
import { consentMethods } from "./composio-client/consent";
import { createClientContext } from "./composio-client/context";
import { directoryMethods } from "./composio-client/directory";
import { fieldMethods } from "./composio-client/fields";
import type { ComposioVendor } from "./composio-client/model";

export type { ComposioVendor } from "./composio-client/model";

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

/**
 * Both seams, over one vendor client.
 *
 * TAKING THE VENDOR OBJECT RATHER THAN A KEY IS THE SEAM. It is what lets every test of this
 * file's own decisions — which limit went out, which field became which, which call was refused
 * before it was made — run against an object literal and never a socket. {@link createComposioClient}
 * is the one line that turns a key into a vendor, and it is deliberately too thin to have a bug in.
 *
 * The vendor is captured in a closure rather than stored on either returned object, so neither
 * `actions` nor `broker` offers a route back to the client or to the key it holds.
 *
 * @param now The clock the catalogue's lifetime is measured against, injected for the same reason
 * the vendor is. A test that could not move the clock could only assert the cache's hit by counting
 * calls and would have to sleep ten minutes to assert its expiry, so the window would be the one
 * thing here no test could reach. It is a parameter of the builder rather than of
 * {@link ComposioBroker.listApps}, because the seam's callers are routes and none of them has an
 * opinion about what time it is.
 */
export function buildComposioClient(
  vendor: ComposioVendor,
  now: () => number = Date.now,
): {
  actions: ComposioActions;
  broker: ConnectedAppBroker;
} {
  const context = createClientContext(vendor, now);
  const actions = actionsFor(context);

  const broker: ComposioBroker = {
    ...directoryMethods(context),
    ...consentMethods(context, actions),
    ...fieldMethods(context),
    ...accountMethods(context),
  };
  return { actions, broker };
}

/**
 * The lines that turn this deployment's API key into a vendor client.
 *
 * Most of what this file decides lives in {@link buildComposioClient}, and this one used to say it
 * therefore had "no decision worth testing". That sentence was wrong twice over and both times in
 * the same way: this is where the SDK's DEFAULTS are accepted or refused, and a default accepted by
 * omission looks exactly like a default nobody thought about. It cost the two deletes their
 * `revoke_on_delete` once — see the describe about which delete the vendor carries — and it left
 * the construction literal below unpinned, so that deleting a line from it phoned out on boot and
 * broke no test. Both are now asserted; the construction literal carries its own note.
 *
 * The key is a parameter here and a private field of the vendor's client thereafter, and no path
 * out of this module carries it — see the module comment. That is also why this returns the seam
 * rather than the vendor: handing `composio` back would put the key on an object any caller could
 * read, so the construction below is asserted by what it DOES, not by a config object a test could
 * inspect.
 *
 * IT IS NO LONGER ONE LINE, AND THE REASON WAS THE TWO DELETES AND IS NOW ALSO THE TWO LISTINGS.
 * `Composio` used to satisfy {@link ComposioVendor} whole, passed straight in. It cannot any more,
 * for two separate faults in the same wrapper. Its own `authConfigs.delete` and
 * `connectedAccounts.delete` send a hard-coded empty body and therefore cannot ask for the upstream
 * revocation, which is the difference between ending somebody's access and filing it away. And its
 * `tools.getRawComposioTools` and `toolkits.get` cannot be paged — one takes no cursor, the other
 * drops the response's — which is the difference between a catalogue and the first thousand rows
 * of one, and which showed an operator an empty app picker. The underlying `@composio/client`
 * answers all four, so those members are satisfied from `getClient()` and the rest from the SDK's
 * own models. A wrapper per member rather than a spread, so that the arrow's own type checks
 * against the shape above — a vendor method whose signature drifted would fail here rather than at
 * the call site.
 *
 * NO NEW IMPORT, WHICH IS WHY THE ONE-IMPORT-SITE RULE SURVIVES THIS. `getClient()` is public on the
 * SDK's own object and the client's types are inferred from it; `@composio/client` is not named
 * anywhere under `server/src`, so a version bump still has exactly this file to be read against.
 */
export function createComposioClient(apiKey: string): {
  actions: ComposioActions;
  broker: ConnectedAppBroker;
} {
  /*
   * THREE ENTRIES, EVERY ONE OF THEM LOAD-BEARING, AND ALL THREE PINNED BY A TEST. What this
   * literal settles is what a boot of this server is allowed to do before it has served anything:
   * which host the key goes to, whether a third party hears about the start-up, and whether a
   * vendor library gets a say in how the process shuts down. Those are deployment facts, not
   * style, and none of them was visible to a test until one was written for them — see
   * `server/tests/composio-adapter.test.ts`, "what constructing the vendor is allowed to do on
   * boot", which watches a stubbed transport and a stubbed `process.on` and fails if any line here
   * is deleted or flipped. Read that test before changing anything below.
   *
   * `apiKey` DOES NOT FAIL WHEN DROPPED, IT FALLS BACK. `getSDKConfig` reads `COMPOSIO_API_KEY`
   * out of the environment and then `api_key` out of `~/.composio/user_data.json`
   * (`@composio/core` 0.18.1, `src/utils/sdk.ts:42-52`), so a literal that lost this line would go
   * on working against whichever account the machine was last logged into, with the configured
   * `config.composioApiKey` silently unused. `baseURL` is deliberately NOT passed for the same
   * reason read the other way: the default is `https://backend.composio.dev`
   * (`src/utils/constants.ts:7`), and the test asserts the origin every request actually goes to,
   * so adding one here is a change that has to be argued for rather than one that slips in.
   */
  const composio = new Composio({
    apiKey,
    /*
     * TRACKING OFF DOES TWO THINGS, AND THE SECOND IS THE ONE THAT IS HARD TO UNDO. It defaults to
     * TRUE (`src/utils/config-defaults/ConfigDefaults.node.ts:5`), and a true value runs
     * `telemetry.setup()` (`src/composio.ts:380-390`). That POSTs an `SDK_INITIALIZED` metric to
     * `https://telemetry.composio.dev/v1/metrics/invocations`
     * (`src/services/telemetry/TelemetryService.ts:4,38-46`) — a third party's analytics, which
     * the operator of a self-hosted install never opted into. And, before that, it installs THREE
     * process-level listeners — `beforeExit`, `SIGINT` and `SIGTERM`
     * (`src/telemetry/Telemetry.ts:66,315-356`) — whose signal handlers flush telemetry, then
     * `removeListener` and `process.kill(process.pid, signal)` to re-raise. Blocking the egress
     * would not undo that half: it would leave a vendor library between an operator's Ctrl-C, or a
     * container runtime's SIGTERM, and this server's exit.
     */
    allowTracking: false,
    /*
     * AND THE BOOT MUST NOT DEPEND ON THE VENDOR'S RELEASE FEED. This defaults to FALSE
     * (`src/composio.ts:113-120`), and a falsy value runs `checkForLatestVersionFromNPM`
     * (`src/composio.ts:399-402`), which fetches `https://registry.npmjs.org/@composio/core/latest`
     * (`src/utils/version.ts:41-43`) as the client is constructed.
     */
    disableVersionCheck: true,
    /*
     * NOTHING ELSE IS PASSED, AND THE REST OF `ComposioConfig` IS ACCEPTED AS IT COMES, which is
     * safe only because of where each default lands — recorded here so the next reader does not
     * have to re-derive it.
     *
     * `dangerouslyAllowAutoUploadDownloadFiles` defaults OFF (`ConfigDefaults.node.ts:4`) and is
     * the premise `./composio`'s file filter is written on; under EITHER setting that filter drops
     * every action that needs a file and offers one that only accepts a file without that
     * parameter, and the execute path refuses a call that carries it anyway. So the premise is
     * defended by tested guards rather than by this literal, and turning the flag on here would be
     * a change to make against that filter. `sensitiveFileUploadProtection`,
     * `fileUploadPathDenySegments`, `fileUploadDirs` and `fileDownloadDir` only bear on uploads
     * and downloads that the same filter means never happen. `provider` defaults to the SDK's `OpenAIProvider`, which this adapter never asks to
     * format anything — every read here goes through the raw client or the SDK's own models.
     * `host` and `defaultHeaders` are telemetry and header cosmetics, and telemetry is off above.
     * `toolkitVersions` defaults to "latest", which is the literal every listing in this file
     * already passes explicitly; see {@link ComposioVendor.tools.list}.
     */
  });
  const client = composio.getClient();

  return buildComposioClient({
    tools: {
      // The listing is the raw client's because the wrapper has no cursor; the single-tool read and
      // the execute stay the SDK's, because both are one call about one action and neither pages.
      list: (query) => client.tools.list(query),
      getRawComposioToolBySlug: (slug, options) =>
        composio.tools.getRawComposioToolBySlug(slug, options),
      execute: (slug, body) => composio.tools.execute(slug, body),
    },
    toolkits: {
      list: (query) => client.toolkits.list(query),
      retrieve: (slug) => client.toolkits.retrieve(slug),
    },
    authConfigs: {
      list: (query) => composio.authConfigs.list(query),
      create: (toolkit, options) =>
        composio.authConfigs.create(toolkit, options),
      delete: (id, params) => client.authConfigs.delete(id, params),
    },
    connectedAccounts: {
      list: (query) => composio.connectedAccounts.list(query),
      link: (userId, authConfigId, options) =>
        composio.connectedAccounts.link(userId, authConfigId, options),
      /*
       * The create is the raw client's for a third reason of its own: the SDK's wrapper over this
       * endpoint is `initiate`, which is retired for the managed-auth path, and `link` above — its
       * replacement — mints a consent url and has nowhere to put a value a person typed.
       *
       * THE ONE ASSERTION IN THIS FUNCTION, AND IT IS ABOUT `state` ALONE. The generated client
       * declares that field as a fourteen-member union keyed on the scheme, each member's `val`
       * ending in `[k: string]: unknown` — which is to say the vendor's own type admits any object
       * once the scheme is picked, and picking it here would be this file asserting which boxes an
       * app asks a person for. {@link ComposioVendor} therefore says `unknown` and the widening is
       * spent here, at the one line where this deployment's projection meets the vendor's schema
       * and nothing else is decided.
       */
      create: (body) =>
        client.connectedAccounts.create(
          body as Parameters<typeof client.connectedAccounts.create>[0],
        ),
      delete: (id, params) => client.connectedAccounts.delete(id, params),
    },
  });
}

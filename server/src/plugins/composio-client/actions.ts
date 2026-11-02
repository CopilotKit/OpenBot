import {
  type ComposioAction,
  type ComposioActions,
  type ComposioResult,
  withheldArguments,
} from "../composio";
import {
  actionOf,
  askVendor,
  everyRowOf,
  type Listing,
  pageOf,
  sent,
  textOf,
  VENDOR_SHAPE_REMEDY,
  type VendorToolRow,
} from "../composio-vendor";
import type { ClientContext } from "./context";

/** Listing an app's actions and calling one, as ./composio describes them. */
export function actionsFor(context: ClientContext): ComposioActions {
  const { vendor } = context;

  const actions: ComposioActions = {
    async listActions(toolkit, page): Promise<ComposioAction[]> {
      /*
       * A PAGE OF NOTHING IS NOT A PAGE, AND THE REASON IT IS REFUSED HAS MOVED.
       *
       * It used to be a fact about the wrapper: `getRawComposioTools` composed its request with
       * `...(limit ? { limit } : {})` (`@composio/core` 0.18.1, `src/models/Tools.ts:536`) over a
       * schema spelling the field `z.number().optional()` with no floor
       * (`src/types/tool.types.ts:257`), so a zero was not sent short — it was not sent at all, and
       * Composio's own page of twenty came back looking exactly like everything a small app
       * publishes. The raw client passes a zero through, so what a zero means now is Composio's to
       * say rather than a silent substitution.
       *
       * IT IS STILL REFUSED, AND THE ARGUMENT IS THE ONE THAT DID NOT DEPEND ON THE WRAPPER. The
       * page is required on this seam precisely so that no layer supplies one quietly; a caller
       * asking for no rows is a caller with a fault, and a fault is a thing to report rather than a
       * thing to correct on their behalf. What changed with paging is that the limit is now a PAGE
       * SIZE rather than the whole listing — {@link everyRowOf} reads on until the cursor stops —
       * so a small one costs requests rather than actions. A zero would cost every request there
       * is, or none.
       */
      if (!Number.isInteger(page.limit) || page.limit < 1) {
        throw new Error(
          `A page of ${page.limit} rows is not a page Composio can be asked for, so ${toolkit}'s action list was not refreshed and the tools already held are untouched. The page a listing asks for is required on this seam so that no layer supplies one quietly, and a request for no rows is a fault to report rather than one to correct on a caller's behalf.`,
        );
      }

      /*
       * EVERY PAGE, WHICH IS WHAT THIS SEAM COULD NOT DO UNTIL THE LISTING LEFT THE WRAPPER.
       * `./composio` used to meet a listing at {@link LISTING_LIMIT} and refuse it, for the reason
       * the catalogue above used to: an app with exactly that many actions and one with more of
       * them answer identically, and committing the second deletes every action past the cut from
       * `mcp_tools` under a refresh that reported success. That refusal is gone with this, and the
       * guard it cannot be confused with — `store.ts`'s empty-listing guard — stays where it is.
       */
      const listing: Listing = {
        noun: `${toolkit}'s actions`,
        consequence: `${toolkit}'s action list was not refreshed and the tools already held are untouched`,
      };
      const tools = await everyRowOf<VendorToolRow>(listing, (cursor) =>
        pageOf(listing, () =>
          askVendor(
            {
              outcome: `${toolkit}'s action list was not refreshed and the tools already held are untouched`,
              app: toolkit,
            },
            () =>
              vendor.tools.list({
                toolkit_slug: toolkit,
                limit: page.limit,
                // The SDK's own default, forwarded on every listing it made, and the thing that
                // decides which `version` each action carries. See {@link ComposioVendor}.
                toolkit_versions: "latest",
                ...(cursor === undefined ? {} : { cursor }),
              }),
          ),
        ),
      );

      return tools.map((row, position) => actionOf(row, position, toolkit));
    },

    async execute(call, args): Promise<ComposioResult> {
      /*
       * THE TOOL IS RESOLVED BEFORE IT IS RUN, AND THAT COSTS A ROUND TRIP ON PURPOSE.
       *
       * Composio's execute takes the slug alone — its REST parameters have no toolkit field — so
       * the pair the caller was gated on cannot travel on the wire, and the obligation
       * {@link ComposioActions.execute} writes down has to be discharged here instead. The
       * resolved tool carries the app the vendor will actually run it against, so asking for it
       * first is what makes the check possible at all.
       *
       * `tools.execute` resolves the same tool again internally, so this is a second request
       * rather than a saved one. It buys the one thing a single request cannot: a mismatch that is
       * refused before anything runs, rather than discovered in an audit row afterwards.
       *
       * AND IT IS TAKEN AT ITS DECLARED TYPE, WHICH IS THE ONE ANSWER IN THIS FILE MOST SAFE TO DO
       * THAT WITH. `getRawComposioToolBySlug` ends in `this.transformToolCases(tool)` (`@composio/core`
       * 0.18.1, `src/models/Tools.ts:719`), whose last act is `ToolSchema.parse(...)` — a throwing
       * parse — so what resolves here is an object satisfying that schema or a `ZodError` that
       * `./composio` recognises and answers with a package remedy. An answer that is not an object,
       * and a `toolkit` that is present and not an object, both die at that parse; two refusals
       * stood here for exactly those and neither could be reached.
       */
      const resolved = await askVendor(
        {
          outcome: `${call.slug} was not resolved and nothing was run`,
          app: call.toolkit,
        },
        () =>
          vendor.tools.getRawComposioToolBySlug(call.slug, {
            version: call.version,
          }),
      );

      /*
       * AN UNREADABLE APP IS NOT THE SAME FACT AS NO APP, AND THEIR REMEDIES DIFFER. The mismatch
       * refusal below ends by telling an administrator to refresh this app's tools, which is right
       * for a slug recorded against a url that has since changed and useless for an SDK that has
       * begun answering a different shape. So a toolkit whose slug is not a usable name is refused
       * as what it is rather than folded into "no app at all", where it would arrive wearing a
       * remedy that cannot work.
       *
       * AND IT IS STILL READ, DESPITE `ToolkitSchema` SPELLING THE SLUG REQUIRED, for the reason
       * {@link actionOf} reads the action's own: `z.string()` is satisfied by the empty string, so
       * a passing parse still admits an app with no name — which would compare unequal to every
       * toolkit and refuse this call as a mismatch with nothing on the other side of the sentence.
       */
      /*
       * `?? undefined` BECAUSE ABSENT ALREADY HAS A SENTENCE HERE AND `null` IS THE OTHER SPELLING
       * OF IT. The mismatch refusal below already says "no app at all" for an action the vendor
       * attributes to nothing, so absence is an answer on this path rather than a fault. Exempting
       * only `undefined` read a `null` as an app that was PRESENT and then took `.slug` off it —
       * `null is not an object (evaluating 'answeredApp.slug')`, thrown from outside every vendor
       * `try` in this file, which `./composio` puts into a model's context and an audit row as this
       * deployment's account of what happened. That is the same `undefined`-only exemption the
       * three field guards in {@link actionOf} carried, failing the loud way instead of the total
       * one.
       */
      const answeredApp = resolved.toolkit ?? undefined;
      let ran: string | undefined;
      if (answeredApp !== undefined) {
        /*
         * `answeredSlug` RATHER THAN `named`, WHICH IS ONLY A RENAME AND IS WORTH ONE LINE. This
         * binding was called `named` and shadowed the module helper of that name for the rest of
         * the block — so {@link named} was unreachable here, and an edit reaching for it would have
         * been calling a string. Nothing was wrong today; the next change to this block is what the
         * rename is for.
         */
        const answeredSlug = textOf(answeredApp.slug);
        if (answeredSlug === null) {
          throw new Error(
            `Composio sent ${sent(answeredApp.slug)} where the slug of the app ${call.slug} belongs to should be, so nothing was run: a name this deployment cannot read is not one it can compare with ${call.toolkit}. ${VENDOR_SHAPE_REMEDY}`,
          );
        }
        ran = answeredSlug;
      }

      if (ran !== call.toolkit) {
        /*
         * REFUSED RATHER THAN FORWARDED, and both apps are named.
         *
         * The gate in `./access` cleared this run against the app the connection's url names
         * NOW; the slug was recorded by a listing made at some earlier time. Where the two
         * disagree — a url edited between a refresh and a call — forwarding runs one person's
         * Gmail action under a gate that only ever examined their Slack connection. A reader
         * holding only one of the two names cannot tell which of the two is the wrong one, so
         * both go in the sentence. An app the vendor did not name at all is the same refusal:
         * this deployment cannot show that the call is about the app it was gated on.
         */
        throw new Error(
          `${call.slug} was not sent to Composio: this connection is for ${call.toolkit}, and Composio resolves that action to ${
            ran ?? "no app at all"
          }. Refreshing this app's tools on its Plugins page recovers it where the action was recorded against a url that has since changed.`,
        );
      }

      /*
       * A FILE PARAMETER THE LISTING LEFT OUT IS REFUSED HERE, AND THE RESOLVE IS WHAT MAKES THAT
       * POSSIBLE. `./composio` offers an action whose file parameters are all optional with those
       * parameters removed, because the only value a model can put in one is a staging key it made
       * up. A model can still send one, so the call has to be checked against the action's own
       * schema, and the tool resolved above at the recorded version is that schema: the same
       * definition the listing was read from, asked the same question by the same walk. See
       * {@link withheldArguments}.
       *
       * REFUSED IN A SENTENCE RATHER THAN STRIPPED, which is how this file answers every call it
       * will not send. Dropping the value quietly would run a different call from the one the model
       * made and tell it nothing, so the email would go without the attachment the model believes it
       * attached. The sentence names the parameter and the remedy, which is the same call without it.
       *
       * ONE LIMIT, WRITTEN DOWN RATHER THAN HIDDEN. What resolves here has been through
       * `ToolSchema.parse`, which keeps `properties`, `required`, the composition keywords, `items`
       * and the flag itself, and drops the rarer 2020-12 applicators (`prefixItems`, `contains` and
       * the like). A file reachable only through one of those is withheld by the listing and not
       * seen here. In the fifteen toolkits read when this was written, every file sat directly on a
       * named property or under its `anyOf` or `items`, all of which survive the parse.
       */
      const withheld = withheldArguments(resolved.inputParameters, args);
      if (withheld.length > 0) {
        const named = withheld.join(", ");
        throw new Error(
          `${call.slug} was not run, because it included ${named}, which is a file. OpenBot can't pass a file to this action, so any value there could only have been made up, and the action is offered without ${named} for that reason. Try again without ${named}.`,
        );
      }

      return askVendor(
        { outcome: `${call.slug} was not run`, app: call.toolkit },
        () =>
          vendor.tools.execute(call.slug, {
            arguments: args,
            userId: call.userId,
            version: call.version,
            /*
             * SPREAD RATHER THAN PASSED AS `undefined`, which is the same care every other optional
             * on this wire gets here — see the cursor on the listings above. What the vendor is
             * handed for "any account of theirs" is a body with no such key, not a key holding
             * nothing, so a client that distinguishes the two cannot read an absent pin as a
             * request for an account called undefined.
             */
            ...(call.connectedAccountId === undefined
              ? {}
              : { connectedAccountId: call.connectedAccountId }),
          }),
      );
    },
  };
  return actions;
}

import type { BrokerApp, BrokerRefusalError } from "../broker";
import { LISTING_LIMIT } from "../composio";
import {
  type AccountRow,
  appOf,
  askVendor,
  type CheckedAuthConfig,
  everyRowOf,
  type Listing,
  pageOf,
  readableConfigs,
  type VendorAccountStatus,
  type VendorToolkit,
} from "../composio-vendor";
import { type ComposioVendor, madeHere } from "./model";

/**
 * What the Composio client's methods share: the vendor it calls, the clock, and the listings every
 * group asks through. Made once per client by `buildComposioClient`.
 */
export function createClientContext(
  vendor: ComposioVendor,
  now: () => number = Date.now,
) {
  /**
   * This person's accounts for this app, in whichever states the ASKING question is about.
   *
   * ONE LISTING WITH THE STATUSES AS ITS ARGUMENT, rather than one listing both callers share.
   * They shared one until it turned out that the shared answer was wrong for one of them: see
   * {@link CONNECTED} and {@link REVOCABLE} for why "is this person connected" and "what is there
   * to revoke" are different questions. What they do share is everything a drift between them
   * would come from — the breadth of `accountType`, the limit, and the fact that both ask about one
   * person and one app — so the difference between them is exactly the list of statuses and is
   * visible at both call sites.
   *
   * AND SO ARE THE OTHER TWO THINGS THE TWO QUESTIONS DO NOT SHARE, for the same reason the
   * statuses are. `configs` is which authorization configs the answer is about — every one of them
   * for the three that only READ (the gate, `grantsFor` and `accountName`), and only this
   * deployment's for the withdrawal, because the withdrawal ACTS on what it finds. `enough` is when the rows in hand already settle the question, which is true of
   * a boolean the moment one row arrives and never true of a set of accounts to end. Both are
   * written at the call sites below, beside the statuses, so that the whole of the difference
   * between the two questions is one argument list a reader can compare.
   */
  const accountsFor = async (
    userId: string,
    toolkit: string,
    statuses: VendorAccountStatus[],
    asked: {
      configs?: string[];
      enough?: (rows: AccountRow[]) => boolean;
    } = {},
  ): Promise<AccountRow[]> => {
    /*
     * EVERY PAGE UNLESS THE CALLER SAYS OTHERWISE, READ HERE RATHER THAN AT EITHER CALLER, so that
     * the two questions cannot drift on the one thing they do share. A truncated listing is the
     * wrong answer to both of them for the same reason: `false` claims somebody has no account for
     * an app when nobody looked at all of them, and a withdrawal that saw one page ends fewer
     * grants than it reports. What a caller may say is that it has ENOUGH — see {@link everyRowOf}
     * — which is not truncation: it is a question that has been answered.
     *
     * THE ROWS GO BACK AS ROWS, WHICH IS NARROWER THAN WHAT THIS USED TO HAND OVER. It read every
     * id here, and the two callers do not want the same thing: `isConnected` is a COUNT — the id is
     * nothing it reads — so taking ids on its behalf turned an account Composio described without
     * one into a thrown refusal against a person who is, in fact, connected. Reading the ids is the
     * withdrawal's business, and it is done there, where a row that cannot be named is something to
     * report alongside the grants that were ended rather than something to stop them.
     */
    const rows = await everyRowOf(
      {
        noun: `this person's ${toolkit} accounts`,
        consequence:
          "neither whether they are connected nor what there is to withdraw could be read",
      },
      (cursor) =>
        askVendor(
          {
            outcome: `this person's ${toolkit} accounts were not read`,
            app: toolkit,
          },
          () =>
            vendor.connectedAccounts.list({
              userIds: [userId],
              toolkitSlugs: [toolkit],
              /*
               * COPIED, BECAUSE WHAT THE CALLERS PASS IN IS {@link CONNECTED} OR {@link REVOCABLE}
               * ITSELF. Every other list in this body is built here — `[userId]`, `[toolkit]`, and
               * `asked.configs`, which is a fresh `map` — and this one was the adapter's own
               * module-level constant handed straight over the seam to the vendor's package. A
               * recipient that sorts, de-duplicates or appends to the array it was given would not
               * spoil one listing; it would rewrite the constant for the life of the process, after
               * which `isConnected` — the gate `./access` asks before running somebody's action —
               * and the withdrawal's own filter would both be asking a question nobody wrote down,
               * in the next request rather than this one. It is the same reasoning {@link copyOf}
               * applies to the catalogue rows, with no expiry to bound it.
               */
              statuses: [...statuses],
              accountType: "ALL",
              // Spread for the reason the cursor is: an explicit `undefined` reaches the vendor's
              // `parse` as a key, and "about every config" is said by not naming any.
              ...(asked.configs === undefined
                ? {}
                : { authConfigIds: asked.configs }),
              limit: LISTING_LIMIT,
              ...(cursor === undefined ? {} : { cursor }),
            }),
        ),
      asked.enough,
    );
    return rows;
  };

  /**
   * Every auth config Composio holds for one app, ours and anybody else's alike, in one order.
   *
   * THE LISTING IS SCOPED TO THE PROJECT AND NOT TO THIS DEPLOYMENT, which is the correction. An
   * auth config is scoped to the project the API key belongs to — so nothing here is hidden from
   * this listing, and that was read as "everything it returns is ours". It is not: an operator with
   * the same project open in Composio's dashboard can create configs for the same app by hand, for
   * purposes this deployment knows nothing about. {@link madeHere} is the only thing that tells the
   * two apart, and every caller below is about an object one of them must not touch.
   *
   * THE UNCLAIMED ROWS ARE RETURNED RATHER THAN DROPPED HERE, which is the part that moved. The
   * filter used to live on the way out, so "no configs at all" and "configs, none of them ours"
   * reached every caller as the same empty array — and telling those two apart is the whole of what
   * {@link ComposioBroker.deleteAuthConfig} was missing, and then of what
   * {@link ComposioBroker.revoke} was missing a wave later, on the same distinction, one function
   * away. The `ours` filter is still offered, beside rather than instead of the rest, because a
   * caller that can only see its own configs is a caller that cannot notice the other two states.
   *
   * SORTED SO THAT TWO CALLERS AGREE. The vendor's order is not documented, and the whole failure
   * being fixed here is two calls resolving different rows; a total order on the id makes the
   * choice this file makes a stable one, whoever asks and whenever.
   *
   * BY CODE UNIT RATHER THAN BY `localeCompare`, WHICH IS THE WHOLE POINT OF THE SORT RATHER THAN A
   * QUIBBLE WITH IT. `localeCompare` called with no locale collates in the HOST's, and the hosts
   * are not one host: "ac_B" comes before "ac_a" by code unit and after it under an English
   * collation, and the two callers this order exists to keep in step — a person pressing Connect
   * and an administrator pressing Remove — need not be answered by the same process, the same
   * container or the same build of ICU. An order that two machines can disagree about is not an
   * order two callers agree on. `<` is the same total order everywhere, which is the only property
   * asked of it here.
   *
   * THREE PARTS RATHER THAN A LIST, AND THAT IS A GUARD AGAINST THIS FILE'S OWN HISTORY. Each of
   * the four callers below has to answer three different questions about one listing — what is
   * ours, what is standing that is not, and what could not be read at all — and every defect this
   * function has been corrected for was one caller answering one of them while its neighbour, one
   * function away, answered it differently or not at all. A shape that hands over only `ours`
   * lets a caller not notice the other two; this one cannot be destructured without saying so.
   */
  const configsFor = async (
    toolkit: string,
  ): Promise<{
    /** Every readable row, ours and anybody else's alike, deduplicated and in one order. */
    held: CheckedAuthConfig[];
    /** The subset of `held` carrying {@link CONFIG_SUFFIX}, which is what this deployment claims. */
    ours: CheckedAuthConfig[];
    /** One refusal per row that could be sorted into neither, which is never nothing. */
    unreadable: BrokerRefusalError[];
  }> => {
    /*
     * EVERY PAGE, BECAUSE A CONFIG ON THE SECOND ONE IS STILL OURS. Read one page and the two
     * callers below are wrong in the two opposite directions {@link madeHere} describes:
     * `ensureAuthConfig` finds none and creates the second config it exists to prevent, and
     * `deleteAuthConfig` leaves one standing, reports a clean removal, and lets `removeServer`
     * delete the app's row over the top of a live grant.
     */
    const rows = await everyRowOf(
      {
        noun: `this deployment's authorization configs for ${toolkit}`,
        consequence:
          "whether one exists is not something this deployment can tell",
      },
      (cursor) =>
        askVendor(
          {
            outcome: `this deployment's authorization configs for ${toolkit} were not read`,
            app: toolkit,
          },
          () =>
            vendor.authConfigs.list({
              toolkit,
              limit: LISTING_LIMIT,
              showDisabled: true,
              ...(cursor === undefined ? {} : { cursor }),
            }),
        ),
    );
    /*
     * CHECKED BEFORE THE FILTER AND NOT AFTER IT, which is the order the whole guard turns on. The
     * filter's question IS the name, so a row checked only once it had been kept would be a row
     * sorted by a field nobody had read — see {@link madeHere} for what each of the two guesses
     * costs. Every row therefore passes {@link readableConfigs} first, including the ones that turn
     * out to belong to an operator's own dashboard work.
     */
    const { configs, unreadable } = readableConfigs(rows, toolkit);
    const held = configs.sort((one, other) =>
      one.id < other.id ? -1 : one.id > other.id ? 1 : 0,
    );
    return { held, ours: held.filter(madeHere), unreadable };
  };

  /**
   * Ask for every one of them and answer with what refused, rather than stopping at the first.
   *
   * A THROW MID-LOOP ABANDONS GRANTS THAT ARE STILL LIVE. Both callers below are deleting a set of
   * things that each independently hold somebody's access, and an exception out of the second of
   * five leaves three untouched and unmentioned — while the caller is told only about the one that
   * failed, so nothing in the answer says the loop did not finish. Attempting all of them makes the
   * failure a statement about a set: this many were asked for and this many refused.
   *
   * SERIALLY RATHER THAN TOGETHER, for the same reason every other call here goes out one at a
   * time: the vendor rate-limits, and a person with several accounts is not a reason to open
   * several connections. The order is the listing's, which is sorted.
   *
   * EVERY REFUSAL IS ANSWERED AND NOT ONLY THE FIRST. What the callers do with this list is throw a
   * COUNT — "two of three were withdrawn and the rest refused" — because a count is what a reader
   * can act on, which makes the reasons the only place the detail lives. Returning them all is what
   * lets {@link everyRefusal} put all of them on the failure the caller raises; the previous version
   * collected them and both callers then read `refused[0]`, so the second and third reason existed
   * for the length of one expression and were then dropped.
   *
   * EVERY FAILURE IS A REFUSAL HERE, AND THE CLASSIFICATION THAT USED TO SIT IN THIS LOOP HAS MOVED
   * ONE LAYER DOWN. There was an `isOurFault` test in the catch that re-threw a `TypeError`, a
   * `ReferenceError` or a `RangeError` rather than counting it, on the premise that those are what
   * a program's own mistake looks like and are never "a thing Composio can reply". The premise is
   * false — see the `TypeError` row in {@link vendorRefusal} for the five vendor shapes that raise
   * exactly that from inside `@composio/core`'s own transformers — so its effect was inverted: a
   * vendor fault escaped the loop as a bug of ours, abandoning every account after it unasked, and
   * the person was handed a crash instead of a sentence.
   *
   * IT MOVED RATHER THAN BEING RETUNED because this loop cannot make the distinction and
   * {@link askVendor} can. Every `ask` below is one `await vendor.*` wrapped by that function, so
   * whether a fault came from inside the vendor's code is a fact about the call stack there, where
   * here it could only ever have been guessed at from an error class.
   */
  const askForEach = async <T>(
    items: T[],
    ask: (item: T) => Promise<unknown>,
  ): Promise<unknown[]> => {
    const refused: unknown[] = [];
    for (const item of items) {
      try {
        await ask(item);
      } catch (error) {
        refused.push(error);
      }
    }
    return refused;
  };

  /**
   * The catalogue as the vendor answers it, EVERY PAGE OF IT, mapped to the rows a person picks from.
   *
   * IT USED TO BE ONE PAGE AND A REFUSAL, AND THAT REFUSAL IS THE BUG THIS FUNCTION WAS FIXED FOR.
   * It asked for {@link LISTING_LIMIT} rows, met exactly that many, and threw — because a full page
   * and a truncated one are the same array and it believed no second request could tell them apart.
   * Composio publishes more than {@link LISTING_LIMIT} toolkits, so the condition was true on every
   * call and the app picker showed an operator nothing at all, with a sentence explaining why a
   * partial directory would be worse. The reasoning was right and the premise was false: the raw
   * client has a cursor for this listing and always did. See {@link ComposioVendor} and
   * {@link everyRowOf}.
   *
   * SORTED BY USAGE, AND NO SEARCH TERM — see {@link ComposioVendor}, where both are argued now
   * that neither is holding a finite page together.
   *
   * THROWN FROM INSIDE THE FETCH, WHICH IS WHAT KEEPS A FAILURE OUT OF THE CACHE. Every refusal
   * below — a cursor that cannot be followed, a page that is not a page, a row that cannot be read
   * — rejects the promise `listApps` holds, and `listApps` drops an entry whose request rejected.
   * A fragment committed here would be a fragment served for ten minutes to BOTH callers: an
   * administrator searching for an app past the cut is told nothing matched, and the enable route,
   * which checks a slug against this same directory, tells them a real app is not one Composio
   * lists.
   */
  const fetchDirectory = async (): Promise<BrokerApp[]> => {
    const listing: Listing = {
      noun: "Composio's app catalogue",
      consequence: "the directory was not shown",
    };
    const toolkits = await everyRowOf<VendorToolkit>(listing, (cursor) =>
      pageOf(listing, () =>
        askVendor(
          { outcome: "the app catalogue was not read", app: null },
          () =>
            vendor.toolkits.list({
              limit: LISTING_LIMIT,
              sort_by: "usage",
              // Spread rather than an explicit undefined, for the reason `everyRowOf` gives: a
              // `cursor: undefined` is a key on the wire, and "the first page" is said by omission.
              ...(cursor === undefined ? {} : { cursor }),
            }),
        ),
      ),
    );

    /*
     * Each absence becomes the value that reads honestly on an administrator's screen, and each
     * PRESENT field that is not what it is declared to be becomes a refusal — see {@link appOf},
     * where both halves of that and every sentence live. An empty description shows as no
     * description; a null logo is the field's documented way of saying the vendor published none,
     * which renders as a gap rather than as a broken image.
     *
     * The categories are the DISPLAY names rather than the slugs, because this list is read by a
     * person choosing an app and "Productivity" is what they are choosing by.
     *
     * A MISSING COUNT BECOMES ZERO, WHICH IS THE ONE IMPERFECT ANSWER HERE. `actionCount` is a
     * number and the shape offers no way to say "not published", so a toolkit that publishes no
     * count reads as an app with no actions. It is the conservative direction — it understates
     * the size of a change rather than overstating it — and Composio publishes a count for every
     * toolkit measured, so this is a guard against the vendor rather than a routine case. A count
     * that arrives as something other than a number is the different case and is refused.
     */
    return toolkits.map(appOf);
  };

  return {
    vendor,
    now,
    accountsFor,
    configsFor,
    askForEach,
    fetchDirectory,
  };
}

export type ClientContext = ReturnType<typeof createClientContext>;

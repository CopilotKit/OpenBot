import Arcade, { APIError } from "@arcadeai/arcadejs";
import {
  type ArcadeActions,
  type ArcadeFailure,
  ArcadeFailureError,
  authorizationRequirementOf,
  classify,
  requiredScopesOf,
  shapeOf,
  vendorStatusOf,
} from "./arcade";
import {
  type BrokerApp,
  type BrokerConnection,
  BrokerRefusalError,
  type ConnectedAppBroker,
  flagOf,
  type GrantState,
} from "./broker";

/**
 * THE VENDOR'S ONLY DOOR INTO THE SERVER. This is the one file under `server/src` that imports
 * `@arcadeai/arcadejs`, so a version bump has exactly this file to be read against, the same
 * convention `createComposioClient` states for its SDK. It imports the transport (`./arcade`) for
 * the `ArcadeFailure` shape; the transport never imports it, because that direction is a cycle and
 * `broker.ts` records why.
 */

/** Deeper than any real wrapping; a bound, so a cyclic `cause` cannot loop. */
const MAX_CAUSE_DEPTH = 16;

/**
 * THE TEXT A VENDOR FIELD CARRIES, OR NOTHING — AND A STRING WITH NO TEXT IN IT IS NOTHING.
 *
 * `""` is absence wearing a value's clothes, and answering it as a value is what breaks every
 * caller that then writes `textOf(a) ?? textOf(b)`: `??` falls through on null and undefined ONLY,
 * so an empty `provider_user_info.name` SHADOWED a perfectly good `login` and the Connected-accounts
 * screen drew a blank name on a connection that is genuinely connected. The emptiness belongs here,
 * in the function that claims to answer "is this text", and not in a `||` at each call site — one
 * of which would be forgotten. Whitespace-only is the same fact: a name of three spaces draws the
 * same blank.
 *
 * The value is returned UNTOUCHED when it has text; this answers whether there is any, it does not
 * reformat what the vendor sent. `authorize` below already spells this rule inline for `url` and
 * the authorization id (`typeof x !== "string" || x === ""`), which is the same judgement made one
 * field at a time.
 */
const textOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/**
 * Walk the `cause` chain to the FIRST `APIError` and read its `status` and the response body's
 * `error.name` / `error.message`. The SDK's own fields are `status`, `headers` and `error` (the
 * parsed body); nothing on it names the tool, so nothing here looks for one. No `APIError` anywhere
 * in the chain answers `null`.
 *
 * `status` is undefined for `APIConnectionError` and `APIUserAbortError`, which extend `APIError`:
 * no response was ever read, so the outcome is uncertain, not refused.
 */
export function normalizeArcadeError(error: unknown): ArcadeFailure | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || typeof current !== "object" || seen.has(current))
      return null;
    seen.add(current);
    /*
     * A REFUSAL THIS FILE ALREADY NORMALIZED ANSWERS ITSELF, and it is read on the same chain walk
     * rather than only at the top, because {@link vendorCall}'s answer is carried as a `cause` by
     * the one place that wraps it again (`revoke`, which fails over several connections at once).
     *
     * THIS IS WHAT KEEPS THE MEDIATION FROM COSTING ANYTHING. Every reader of a failure out of this
     * adapter — the authorize route's definite-or-uncertain decision, keyed on `status`; `callTool`'s
     * authorize prompt and `confirmReturn`'s `user_mismatch`, both keyed on the body's `error.name`
     * — asks through this function, so stopping the vendor's own `APIError` at the adapter boundary
     * takes nothing away from any of them. The vendor's PROSE is the only thing that does not come
     * back out; see {@link ArcadeFailureError}, which drops it.
     */
    if (current instanceof ArcadeFailureError) return current.failure;
    if (current instanceof APIError) {
      const body = current.error;
      const record =
        body !== null && typeof body === "object"
          ? (body as Record<string, unknown>)
          : {};
      return {
        status: typeof current.status === "number" ? current.status : undefined,
        name: textOf(record.name),
        message: textOf(record.message),
      };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * THIS DEPLOYMENT'S ONE SENTENCE FOR "ARCADE ANSWERED, AND THE ANSWER HAD NO BODY IN IT".
 *
 * ONE SENTENCE AND NOT SEVERAL, because the fact is one fact wherever it lands: the socket carried
 * a status and no readable value under it — an empty 204, or a body whose whole JSON is `null`.
 * It is written in the uncertainty register {@link vendorCall}'s `APIConnectionError` sentence uses
 * ("is not known here") rather than the refusal register ("Arcade refused …"), because an empty
 * answer is not the vendor declining: whether the call took effect is genuinely unknown, and every
 * caller that spends a DELETE off this reading must treat it as unknown.
 *
 * NOT A SHAPE QUOTED BACK. The body is the thing this file exists to keep off an admin page; see
 * {@link vendorCall}. "No body" says all there is to say without quoting one.
 */
const unreadableBody = (step: string): string =>
  `Arcade answered ${step} with no body this deployment could read — an empty response, or one whose JSON is the literal null — so what it says is not known here.`;

/**
 * THE ANSWER'S BODY, OR THIS DEPLOYMENT'S REFUSAL — never a dereference of `null`.
 *
 * FOR THE CALLS THAT ARE NOT PAGED LISTINGS. A page goes through `OffsetPage`'s constructor, which
 * raises on a null body and is caught in {@link vendorCall}; `tools.authorize`, `auth.status` and
 * `auth.confirmUser` go through no constructor at all, so the SDK hands a literal `null` straight
 * back WEARING ITS DECLARED RESPONSE TYPE. The generated types are a description of what Arcade
 * sends today and are validated by nothing — the same reading `confirmReturn`'s `auth_id` check
 * already states one field down — so reading `answer.status` off one of those is the identical
 * unguarded dereference, raising the identical bare `TypeError` from inside this file instead.
 *
 * THE FIELD-LEVEL GUARDS BELOW STAY EXACTLY AS THEY ARE: this establishes only that there is an
 * object to read fields off, and says nothing about what is in it.
 */
function requireBody<T>(step: string, answer: T): T & object {
  if (answer === null || typeof answer !== "object") {
    throw new Error(unreadableBody(step));
  }
  return answer as T & object;
}

/**
 * ONE CALL TO THE VENDOR, WITH ITS REFUSAL TURNED INTO THIS DEPLOYMENT'S OWN SENTENCE.
 *
 * EVERY `client.*` CALL IN THIS FILE GOES THROUGH HERE, and that uniformity is the point rather
 * than a tidiness: the thing being confined is the SDK's `APIError`, whose `message` is
 * `${status} ${the response body}` (`core/error.js: makeMessage`), and one unwrapped call is one
 * path on which a vendor body reaches a log line, the Plugins page's `lastError`, a model's context
 * or an audit row. On this vendor a body is not inert — the auth paths answer with a bearer `url`
 * and a live `context.token` — and the claim this adapter is held to is that neither ever reaches
 * any of those. `step` is written HERE, at the call site, for the reason `callTool`'s refusal names
 * the action from the call site: nothing in an `APIError` says what was being asked.
 *
 * WHAT IS NOT AN SDK ERROR IS RETHROWN UNTOUCHED, which is deliberate: it leaves this file's own
 * refusals — the malformed-listing sentences, the mint with no url — exactly as they were.
 *
 * WITH ONE EXCEPTION, AND IT IS THE BODY THE SDK COULD NOT READ. A 204 with `content-length: 0`,
 * and a body whose JSON is the literal `null`, both reach `OffsetPage`'s constructor as `body ===
 * null` and raise a bare `TypeError: null is not an object (evaluating 'body.items')` from inside
 * `@arcadeai/arcadejs`, before one line of this file has looked at anything. Left to escape as
 * itself, that `TypeError` is the WRONG ANSWER TWICE: an operator reading the Plugins page gets a
 * vendor stack trace instead of this deployment's sentence, indistinguishable in the logs from a
 * programmer error here; and the only reason the revoke invariant holds on those two shapes is
 * that a crash is technically "not answering" — one tidy-up of the cast that raises it (a `?? []`,
 * say) turns both into `revoke` answering `false` with no DELETE spent, which is the live defect
 * `broker.ts:712-717` forbids. So the body this deployment could not read gets a REFUSAL, the same
 * one {@link requireBody} writes for the non-paged calls, and never a fallback to an empty list.
 *
 * THE ORDER IS WHAT MAKES THAT SAFE, and it is the whole of the old warning against catching "by
 * shape": `normalizeArcadeError` IS ASKED FIRST and every `APIError` answers it, so nothing
 * reaching the `TypeError` branch carries a vendor response at all. The `run()` closures here are
 * one `client.*` call each and nothing else, so a `TypeError` with no `APIError` anywhere in its
 * chain is the SDK failing to read an answer, which is exactly what the sentence says.
 *
 * A REFUSAL THAT IS ALREADY MEDIATED PASSES STRAIGHT THROUGH, so a nested call cannot dress one
 * sentence up in another.
 */
async function vendorCall<T>(step: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ArcadeFailureError) throw error;
    const failure = normalizeArcadeError(error);
    if (!failure) {
      if (error instanceof TypeError) throw new Error(unreadableBody(step));
      throw error;
    }
    throw new ArcadeFailureError(
      failure.status === undefined
        ? // `status` is undefined for `APIConnectionError` and `APIUserAbortError`: no response was
          // ever read, so the outcome is uncertain rather than refused, and the sentence says so —
          // the authorize route keys exactly that distinction off `status`.
          `Arcade did not answer ${step}, so whether it ran is not known here.`
        : `Arcade refused ${step} with HTTP ${failure.status}.`,
      failure,
    );
  }
}

/**
 * Page size for the PER-TOOLKIT action listings, `grantsFor` and `authProvidersNamedBy`. A short
 * page ends it, never `total_count`. The whole-directory listing behind `listApps` does NOT use
 * this: see {@link DIRECTORY_PAGE_SIZE}.
 *
 * THE MEASURED WORST CASE, so the next person does not re-scan the API: across Arcade's directory
 * (8,320 tools, 129 toolkits) the largest toolkit is **`GithubApi`, 818 actions** — then
 * `PosthogApi` 766, `DatadogApi` 588, `ZohoBooksApi` 511, `HubspotCrmApi` 453. At 100 a page
 * costs ~1.19 s, so `GithubApi` read SEQUENTIALLY was 9 pages, ~10.7 s, past the 10 s
 * `VENDOR_CALL_TIMEOUT_MS` that wraps the grants screen and Disconnect alike: neither could load.
 * Under {@link CATALOGUE_CONCURRENCY} it is page one, then the other 8 in one wave, ~2.4 s.
 *
 * KEPT AT 100 RATHER THAN RAISED TO THE DIRECTORY'S 1000, deliberately. Latency, not size,
 * dominates (~1.19 s at 100, ~1.8 s at 1000), so two waves of 100 cost about what one page of
 * 1000 does. At 1000 every toolkit Arcade publishes would be ONE page, and the paths that make a
 * per-toolkit read trustworthy — a short page ending it, `seen < total` judged across pages, a
 * provider disagreeing with itself past page one — would stop being exercised by any real toolkit
 * while still being the only defence when one grows. At 100, every toolkit over 100 actions
 * crosses page boundaries on every read, so the completeness check stays a live check.
 */
const CATALOGUE_PAGE_SIZE = 100;

/**
 * How many per-toolkit action pages are in flight at once after page one has said how many there
 * are, through the same opt-in {@link Listing.concurrency} the directory uses.
 *
 * EIGHT, because it covers `GithubApi` (818 actions → 8 pages after the first) in ONE wave while
 * still bounding what a lying `total_count` can fire. The deadline arithmetic is
 * `~1.19 s × (1 + ⌈remaining / 8⌉)`: under 10 s up to 56 remaining pages, a toolkit of ~5,700
 * actions, for the grants screen. Disconnect spends ~3 more sequential calls after this listing
 * (auth providers, connections, the DELETE; ~1.2 s each, not measured separately), which leaves
 * room for 32 remaining pages, a toolkit of ~3,300 actions — four times `GithubApi`. Past that is
 * the number to revisit.
 */
const CATALOGUE_CONCURRENCY = 8;
/** A runaway guard, not a bound. */
const CATALOGUE_MAX_PAGES = 1000;

/**
 * Page size for the WHOLE-DIRECTORY listing `listApps` reads, which is the "Browse Arcade" screen.
 *
 * THE ARITHMETIC, MEASURED BY HAND ON 2026-10-14 against a live Arcade project, through this
 * deployment's own directory screen, so the next person changing this does not re-probe. Nothing in
 * CI re-checks it, and the directory's size will drift:
 * - Arcade's directory reported `total_count` **8,320** tools.
 * - `limit=1000` is accepted (1,000 items in ~1.77 s); `limit=5000` is REJECTED (empty answer in
 *   ~0.17 s), so **1000 is at or near the vendor's ceiling** — do not raise this past it.
 * - A page costs **~1.8 s** at limit 1000 (~1.2 s at 100, ~1.8 s at 250): latency, not size,
 *   dominates, so fewer larger pages are nearly free.
 *
 * At the old page size of 100 that was 84 SEQUENTIAL pages, ~100 s, against a 10 s
 * `VENDOR_CALL_TIMEOUT_MS` that wraps the WHOLE `listApps` — so the directory could never load. At
 * 1000 it is 9 pages: one, then the remaining 8 at once under {@link DIRECTORY_CONCURRENCY}, ~3.6 s.
 */
const DIRECTORY_PAGE_SIZE = 1000;

/**
 * How many directory pages are in flight at once after page one has said how many there are.
 *
 * EIGHT, because it covers today's directory in ONE wave (8,320 tools → 8 pages after the first)
 * while still being a bound: a `total_count` of a million fires eight requests at a time, never a
 * thousand. The deadline arithmetic is `~1.8 s × (1 + ⌈remaining / 8⌉)`, which stays under the 10 s
 * `VENDOR_CALL_TIMEOUT_MS` up to 32 remaining pages — a directory of roughly 33,000 tools, four times
 * today's. Past that the listing will time out again, and that is the number to revisit.
 */
const DIRECTORY_CONCURRENCY = 8;

/**
 * WHAT ARCADE ITSELF SENT: the parsed response body, and never the SDK's page object.
 *
 * `OffsetPage`'s constructor MANUFACTURES DEFAULTS for the two fields every listing here reads —
 * `this.items = body.items || []` and `this.total_count = body.total_count || 0` — so a field the
 * vendor never sent presents on the page as a well-formed empty answer. Read off the page, "Arcade
 * sent no items" is INDISTINGUISHABLE FROM "Arcade sent an empty list" and "Arcade sent no total"
 * is INDISTINGUISHABLE FROM "Arcade said zero": the `Array.isArray` guards below can never fire,
 * every `typeof reported === "number"` test passes on an absent field, and a malformed or truncated
 * listing commits as a complete one.
 *
 * `AbstractPage` keeps the parsed body untouched beside it, so the honest values are read from
 * there. The answer's own properties are the fallback for an answer that has NO `body` at all,
 * which is what `admin.authProviders.list` (a plain `APIPromise`, not a page) and every hand-built
 * stub return — those were never passed through a page constructor, so nothing was manufactured.
 *
 * AND THE PRESENCE OF `body` IS WHAT DECIDES WHICH OF THE TWO THIS IS — never whether the body
 * happens to be readable. `AbstractPage`'s constructor always assigns `body`, so the property
 * existing is the answer saying "I went through a page constructor, and my own `items` and
 * `total_count` are that constructor's inventions". From there the body is the ONLY honest
 * reading, and a body that is not a record means THE ANSWER COULD NOT BE READ — it does not mean
 * the answer was empty.
 *
 * MEASURED, because this is the hole the fallback left and it is the live defect again: a 200
 * carrying `content-type: text/html` — a proxy's courtesy page — parses to a STRING
 * (`internal/parse.js` returns `response.text()` for anything that is not JSON), so no record
 * exists anywhere and a `?? page` fallback hands back the page's manufactured `items: []`.
 * `listApps` then answered `[]`, `isConnected` answered false, and `revoke` answered `false` WITH
 * NO DELETE SPENT while the caller deleted the local row — `broker.ts:712-717`'s forbidden
 * outcome, reached by a route neither contributing guard could see, because both were written
 * against MALFORMED JSON and this is the branch where the JSON was never parsed at all.
 *
 * ANSWERING `null` IS THE REFUSAL, and deliberately not a throw from here: every caller already
 * has this deployment's own sentence for an unreadable listing — {@link pagedItems}' per-listing
 * `malformed`, and the transport's own `Array.isArray` guard for `listTools` — and routing through
 * them is what keeps one vocabulary on this seam instead of a second error shape invented here.
 */
function sentBody(answer: unknown): Record<string, unknown> | null {
  const page = record(answer);
  if (!page) return null;
  if ("body" in page) return record(page.body);
  return page;
}

/** A count's decimal spelling and nothing else: no sign, no exponent, no separator, no point. */
const COUNT_TEXT = /^[0-9]+$/;

/**
 * A COUNT ARCADE SENT, READ AS THREE OUTCOMES AND NEVER TWO: the number, `undefined` for a field
 * the vendor did not send, and `"unreadable"` for one it DID send in a shape this cannot read.
 *
 * THE THIRD OUTCOME IS THE WHOLE POINT. The previous reading was `typeof raw === "number" ? raw :
 * undefined`, which folded "the vendor did not say" together with "the vendor said something this
 * deployment cannot read" — and every caller treats the first as "there is nothing to cross-check
 * against". Measured: a vendor that serves 100 of 250 connections and spells the claim
 * `"total_count": "250"` had its truncation cross-check silently switched off, and `revoke`
 * DELETED 100, ANSWERED `true`, AND LEFT 150 GRANTS LIVE with no signal anywhere that the
 * withdrawal was partial. That is strictly worse than the `false`-with-no-DELETE defect this file
 * is full of warnings about: that one is at least visibly wrong.
 *
 * A NUMERIC STRING IS A LEGITIMATE SPELLING AND IS COERCED. `"250"` is the vendor saying 250 — it
 * is unambiguous, it is what a serializer that renders integers as text sends, and refusing it
 * would take Disconnect permanently offline for a deployment whose vendor always spells it so,
 * trading a silent partial for a hard failure with no way through. Coercing instead makes the
 * cross-check FIRE, which is what actually protects the invariant: the 250-of-100 listing above
 * now throws the `incomplete` sentence, no DELETE is spent, and the local row survives.
 *
 * EVERYTHING ELSE PRESENT REFUSES, and the strictness is deliberate, because a lenient parse is
 * how this defect comes back. `"many"`, `null`, an object, `true`, `NaN`, `Infinity`, a negative,
 * a fraction and `"1e3"` are all unreadable: anything that is not a plain non-negative decimal
 * integer is a value whose meaning this deployment would be guessing at. `NaN` in particular was
 * already slipping through the old `typeof` test and disabling the cross-check the same way a
 * string did — `seen < NaN` is false — so the number branch checks the VALUE and not just the type.
 *
 * ABSENT STAYS ABSENT. `total_count` is optional on the wire and the listings here end on a short
 * page, never on a total; a missing field must go on meaning "the vendor did not say" or every
 * engine that omits it would refuse.
 */
function countOf(raw: unknown): number | "unreadable" | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!COUNT_TEXT.test(text)) return "unreadable";
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) ? parsed : "unreadable";
  }
  if (typeof raw !== "number") return "unreadable";
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : "unreadable";
}

/** What the vendor sent, written into a refusal without pasting an object into a sentence. */
function shownValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value !== null && typeof value === "object") return "an object";
  return String(value);
}

/**
 * The `total_count` Arcade itself sent, or nothing. Read through {@link sentBody}, for its reason,
 * and through {@link countOf}, for ITS reason: a total the vendor sent in a shape this cannot read
 * THROWS the caller's own sentence rather than answering `undefined` and disabling the only
 * cross-check that can tell a truncated listing from a whole one.
 */
function reportedTotalOf(
  answer: unknown,
  unreadable: (shown: string) => string,
): number | undefined {
  const raw = sentBody(answer)?.total_count;
  const count = countOf(raw);
  if (count === "unreadable") throw new Error(unreadable(shownValue(raw)));
  return count;
}

/**
 * The `items` Arcade itself sent, UNCHECKED — the caller's own guard is what decides whether this
 * is a list. Read through {@link sentBody}, for its reason: off the page object, a listing that
 * sent no `items` at all reads as an empty one and no guard anywhere can tell them apart.
 */
function sentItemsOf(answer: unknown): unknown {
  return sentBody(answer)?.items;
}

/**
 * The HIGHEST total any page reported, never the LAST one.
 *
 * Keeping the last page's value loses the same way `reportedTotalOf` describes, one step later: an
 * engine that truncates at 250 of 300 and drops `total_count` on its short page would otherwise
 * erase the 300 that page one reported, and the cross-check would have nothing to compare against.
 */
const highestTotal = (
  total: number | undefined,
  reported: number | undefined,
): number | undefined =>
  reported === undefined
    ? total
    : total === undefined
      ? reported
      : Math.max(total, reported);

/** One listing's page size, runaway guard, page call and the three sentences a failure carries. */
type Listing = {
  pageSize: number;
  maxPages: number;
  page: (offset: number) => Promise<unknown>;
  malformed: string;
  unending: string;
  incomplete: (seen: number, total: number) => string;
  /**
   * What this deployment says when the vendor sent a `total_count` it cannot read. A sentence of
   * its own rather than a reuse of `malformed`: the list itself was fine and the CLAIM ABOUT ITS
   * LENGTH was not, and a reader sent looking for a broken list would find a well-formed one.
   */
  unreadableTotal: (shown: string) => string;
  /**
   * How many pages may be in flight at once AFTER PAGE ONE. Absent or 1 is the strictly sequential
   * read the connection and auth-provider listings use. `listApps` and the per-toolkit action
   * listings (`grantsFor`, `authProvidersNamedBy`) turn it on. Above 1, page one's `total_count` decides which further
   * offsets are fetched ahead, at most this many at a time; see {@link pagedItems}.
   */
  concurrency?: number;
};

/**
 * `run`, at most `limit` at a time, and NOT AT ALL once `abandoned()` says the reader has stopped.
 *
 * The second half is what keeps a lying `total_count` from costing anything: a listing that claims
 * a million rows and then ends on page two must not go on firing the 998 requests queued behind it.
 */
function bounded(
  limit: number,
  abandoned: () => boolean,
): <T>(run: () => Promise<T>) => Promise<T | undefined> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return <T>(run: () => Promise<T>) =>
    new Promise<T | undefined>((resolve, reject) => {
      const start = () => {
        if (abandoned()) {
          resolve(undefined);
          waiting.shift()?.();
          return;
        }
        active += 1;
        // Through an executor, so a call that throws synchronously is a rejection like any other.
        new Promise<T>((answered) => answered(run()))
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            waiting.shift()?.();
          });
      };
      if (active < limit) start();
      else waiting.push(start);
    });
}

/**
 * ONE LISTING READ TO ITS END, as a stream of items.
 *
 * PAGINATION ENDS ON A SHORT PAGE, never on `total_count`, which is optional on the wire; the
 * reported total is a CROSS-CHECK and is taken through {@link reportedTotalOf} and
 * {@link highestTotal} so that "the vendor did not say" can never read as "the vendor said zero"
 * — nor, through {@link countOf}, as "the vendor said something unreadable". A cross-check with no
 * input is not a cross-check, and the listing it would have caught is the truncated one.
 *
 * THE SDK'S OWN AUTO-PAGINATION IS NOT USED by anything that goes through here, and that is the
 * point: `OffsetPage.nextPageRequestOptions` returns `null` the moment `total_count` is falsy, so
 * `for await (… of client.x.list(…))` silently stops after page one against any engine that omits
 * the field — and the caller cannot tell a complete answer from a first page of it.
 *
 * THE INCOMPLETENESS THROW IS THE LAST THING THIS YIELDS, after every item, so a caller that folds
 * items as they arrive still never sees a short listing finish as a whole one.
 *
 * FETCHING AHEAD ({@link Listing.concurrency}) CHANGES WHEN A PAGE IS ASKED FOR, NEVER HOW IT IS
 * READ. Page one is asked for alone; its `total_count` names the offsets that should exist, and
 * those are requested at once under the bound. The answers are then consumed IN OFFSET ORDER by
 * exactly the loop below, so every rule above still holds page by page: a short page still ends the
 * listing (the pages fetched past it are discarded unread and the queued ones never fire), a total
 * that UNDER-reports still reads on sequentially from where the prefetch ran out, and `seen < total`
 * still throws. A page ahead that FAILED fails the listing when the loop reaches it, and not before.
 * Without a readable total on page one there is nothing to fetch ahead of, and it reads sequentially.
 */
async function* pagedItems(listing: Listing): AsyncGenerator<unknown> {
  let seen = 0;
  let total: number | undefined;
  let ended = false;
  let stopped = false;
  const ahead = new Map<number, Promise<unknown>>();
  try {
    for (let index = 0; index < listing.maxPages; index += 1) {
      const fetched = ahead.get(seen);
      ahead.delete(seen);
      const answer = await (fetched ?? listing.page(seen));
      const items = sentItemsOf(answer);
      if (!Array.isArray(items)) throw new Error(listing.malformed);
      yield* items;
      seen += items.length;
      total = highestTotal(
        total,
        reportedTotalOf(answer, listing.unreadableTotal),
      );
      if (items.length < listing.pageSize) {
        ended = true;
        break;
      }
      if (
        index === 0 &&
        total !== undefined &&
        (listing.concurrency ?? 1) > 1
      ) {
        const slot = bounded(listing.concurrency ?? 1, () => stopped);
        // `floor`, not `ceil - 1`: a total that is an exact multiple of the page size still needs
        // the EMPTY page after it, because a short page — never the total — is what ends a listing.
        const last = Math.min(
          Math.floor(total / listing.pageSize),
          listing.maxPages - 1,
        );
        for (let page = 1; page <= last; page += 1) {
          const offset = page * listing.pageSize;
          const pending = slot(() => listing.page(offset));
          // Observed here so a page fetched past the end — or past a failure the loop throws on
          // first — never surfaces as an unhandled rejection. The loop still awaits the original.
          pending.catch(() => undefined);
          ahead.set(offset, pending);
        }
      }
    }
  } finally {
    stopped = true;
  }
  if (!ended) throw new Error(listing.unending);
  if (total !== undefined && seen < total) {
    throw new Error(listing.incomplete(seen, total));
  }
}

/** The verdict `classify` falls back to when it could not read a behaviour. See {@link isClassified}. */
const CLOSED_VERDICT = { effect: "write", destructive: true } as const;

/**
 * Whether ARCADE classified this action, as against this deployment falling back for it.
 *
 * `classify` from `./arcade` is the one reading of `metadata.behavior` anywhere here, and it is
 * deliberately TOTAL: anything it cannot read answers the closed `{ write, destructive }` verdict,
 * so an unannotated action is approved like a deletion. That fallback is exactly what must not be
 * counted — counted, `AirtableApi`'s `metadata: null` actions would report as classified, and the
 * coverage warning that exists to name them would never fire.
 *
 * AN EMPTY `behavior` IS NOT A CLASSIFICATION EITHER, and `classify` is where that is decided: a
 * block stating neither flag answers the closed verdict, so it arrives here as the fallback it is
 * and the `flagOf(behavior.destructive, false)` below — the collision-breaker, not a second reading
 * of the wire — answers `false` for it. Were `{}` read as a plain write, every such action would
 * report as classified and the coverage warning would miss exactly the actions it exists to name,
 * the same way `AirtableApi`'s `metadata: null` actions would.
 *
 * THE CLOSED VERDICT IS ALSO A REAL ANSWER, which is the only subtlety here: `Attio.RemoveFromList`
 * genuinely publishes `destructive: true` and lands on the same pair. So the verdict is read first,
 * and only that one collision is broken — by asking whether Arcade actually sent a `behavior` whose
 * `destructive` flag reads true, through `flagOf`, the same function `classify` reads it with and
 * never a second parse of the wire.
 *
 * NEVER THE `Api` SUFFIX (spec D8). `AirtableApi` and `GithubApi` are unannotated today and
 * `Apollo` is annotated, so the suffix correlates beautifully — and it is Arcade's naming
 * convention rather than a contract. A rule reading it is a guess wearing a measurement's clothes,
 * right until Arcade curates `DatadogApi`.
 */
function isClassified(metadata: unknown): boolean {
  const verdict = classify(metadata);
  if (
    verdict.effect !== CLOSED_VERDICT.effect ||
    verdict.destructive !== CLOSED_VERDICT.destructive
  ) {
    return true;
  }
  const behavior = record(record(metadata)?.behavior);
  return behavior !== null && flagOf(behavior.destructive, false) === true;
}

/**
 * The oauth2 scopes one listed action asks for, for the catalogue's counts — read through
 * {@link requiredScopesOf}, the one reading `grantStateOf` and the transport's listing share.
 *
 * AN UNREADABLE SCOPES BLOCK REFUSES, as {@link requiresAuthorization} refuses an unreadable
 * authorization block, and for its reason: `[]` here files the action as unscoped — "the connection
 * itself is the grant" — so a block this deployment could not read would be counted as the vendor
 * saying no separate permission exists. The SHAPE (`authorizationRequirementOf`, `shapeOf`) lives in
 * `./arcade` because the transport's own listing reads the same block for the scopes the gate checks.
 */
function scopesOf(item: unknown, toolkit: string): string[] {
  const read = requiredScopesOf(item);
  if (read.kind === "read") return read.scopes;
  throw new BrokerRefusalError(
    `Arcade sent ${read.shape} where the ${read.field === "requirements" || read.field === "authorization" ? read.field : `oauth2 ${read.field}`} of one of ${toolkit}'s actions belongs, and that is what says which permissions connecting ${toolkit} asks for. A shape this deployment cannot read is not "no separate permission", so the catalogue stops here rather than count it as one. That is a change in what Arcade answers rather than a setting an operator can correct, so upgrading this deployment's @arcadeai/arcadejs is what fixes it.`,
  );
}

/**
 * Whether ARCADE SAYS this action needs a person to authorize it — read, never assumed.
 *
 * THIS REPLACES A HARDCODED `{ kind: "consent" }` THAT WAS A CLAIM ABOUT THE VENDOR MADE WITHOUT
 * READING THE VENDOR. Every toolkit in the catalogue was announced to the rest of this deployment
 * as an app somebody connects by clicking through a consent screen, and the live listing says
 * otherwise about real apps: `Apollo` publishes NO `requirements.authorization` and one
 * deployment-wide secret (`APOLLO_API_KEY`) instead — verbatim in `fixtures/arcade-catalogue.json`
 * — so Connect sent somebody to a consent flow for a connection consent cannot complete, and
 * `tools.authorize` was minted for an action that requires no authorization at all.
 *
 * AN AUTHORIZATION BLOCK IS THE WHOLE OF THE QUESTION, AND SECRETS ARE NOT PART OF IT. The two are
 * different people's work and {@link grantStateOf} already keeps them apart for the same reason:
 * a secret is set ONCE FOR EVERYBODY by an operator in the Arcade dashboard — {@link FIELDS_REFUSAL}
 * is this deployment's standing sentence about that — so it is not something the person connecting
 * can supply, and an app that asks only for one asks THEM for nothing. It is therefore `no-auth`
 * here and `needs-operator` on the grants screen, which is the channel that already names the keys.
 * Calling it `fields` would draw a form collecting one person's answer and share it with everyone;
 * calling it `unsupported` would hide the app from the picker for good, including after the
 * operator sets the secret and the app works perfectly.
 *
 * ANY ONE ACTION'S AUTHORIZATION MAKES THE TOOLKIT A CONSENT APP, because the question this answers
 * is "how would somebody connect this app", and a toolkit with one authorized action has a consent
 * flow that is how they reach it. Arcade grants per action, so the grants screen is where an action
 * that needs nothing is told apart from one that does.
 *
 * AND A SHAPE THIS DEPLOYMENT CANNOT READ REFUSES RATHER THAN ANSWERING EITHER WAY. Both wrong
 * answers are silent: a guessed `consent` is the defect above, and a guessed `no-auth` records an
 * app as needing no connection, which hides the Connect button on an app that does. `routes.ts`
 * holds the catalogue for the picker and the enable path both, so one refusal an operator can act
 * on is worth more than several hundred rows, one of which is a guess — `connectionOf` in
 * `composio-adapter.ts` gives that reasoning in full. `null` and an absent field are NOT unreadable
 * shapes: they are the vendor saying this action requires nothing, which `AirtableApi`'s
 * `metadata: null` shows Arcade does say.
 */
function requiresAuthorization(item: unknown, toolkit: string): boolean {
  const read = authorizationRequirementOf(item);
  if (read.kind === "unreadable" && read.field === "requirements") {
    throw new BrokerRefusalError(
      `Arcade sent ${read.shape} where ${toolkit}'s requirements belong, and that field is what says whether somebody has to authorize this app at all. A shape this deployment cannot read is not the vendor saying "nothing to authorize", so it is not read as one — the catalogue stops here rather than offer ${toolkit} under a flow nobody established it has. That is a change in what Arcade answers rather than a setting an operator can correct, so upgrading this deployment's @arcadeai/arcadejs is what fixes it.`,
    );
  }
  if (read.kind === "unreadable") {
    throw new BrokerRefusalError(
      `Arcade sent ${read.shape} where ${toolkit}'s authorization requirement belongs, and this deployment reads that object to decide whether connecting ${toolkit} means sending somebody to a consent screen. A shape this deployment cannot read decides neither way, so the catalogue stops here rather than guess. That is a change in what Arcade answers rather than a setting an operator can correct, so upgrading this deployment's @arcadeai/arcadejs is what fixes it.`,
    );
  }
  return read.kind === "required";
}

/**
 * The flow an app gets, from the one fact {@link requiresAuthorization} measured over its actions.
 *
 * TWO OF THE FIVE KINDS AND NOT THE OTHER THREE, deliberately. `fields` and `self-registering` are
 * Composio's shapes: Arcade has no per-person field entry ({@link FIELDS_REFUSAL}) and registers no
 * client at consent time. `unsupported` is a verdict about an app this deployment cannot drive, and
 * both answers here are apps it drives — the unreadable case REFUSES rather than landing here.
 */
function connectionOf(authorizes: boolean): BrokerConnection {
  return authorizes ? { kind: "consent" } : { kind: "no-auth" };
}

/**
 * Every toolkit Arcade publishes, with `actionCount` taken from the FULL PAGED tool listing.
 *
 * COUNTED, NEVER READ OFF PAGE ONE: `GithubApi` publishes hundreds of actions where `Github`
 * publishes 43, so a first page of 100 would be a wrong answer in the picker. Pagination ends on a
 * short page; `total_count` is optional on the wire and is used only as a cross-check.
 *
 * THE OTHER THREE FACTS ARE COUNTED IN THIS SAME FOLD, BEFORE THE TOOLS ARE DISCARDED, and that is
 * the whole of why they are free: the listing is already paged to the end for `actionCount`, so no
 * second listing and NO EXTRA VENDOR CALL is made for them.
 *
 * `permissionCount` is the number of DISTINCT NON-EMPTY scope sets, held per toolkit as sorted,
 * joined strings — SORTED BEFORE JOINED, so `[a,b]` and `[b,a]` are one permission asked for twice.
 * An action with NO scopes joins no group: Github's 43 actions all carry an `oauth2` block with no
 * scopes and one read consent flipped 43 of 43 to `met: true`, so "no scopes" means "the connection
 * itself is the grant", not "needs nothing" — such an action is not separately approvable.
 * `scopedActionCount` is what keeps that from reading as one permission covering everything.
 */
async function listApps(client: Arcade): Promise<BrokerApp[]> {
  /**
   * The fold's own tally, with PLAIN NUMBERS. `BrokerApp`'s three counts are nullable because
   * another provider may not measure them; this provider does, on every action it folds, so a
   * nullable accumulator here would only be a null nothing can produce, narrowed at every `+= 1`.
   * `permissions` holds the sorted-and-joined scope sets; empty sets never enter it.
   */
  type Tally = Omit<
    BrokerApp,
    "classifiedCount" | "connection" | "permissionCount" | "scopedActionCount"
  > & {
    classifiedCount: number;
    scopedActionCount: number;
    permissions: Set<string>;
    /**
     * Whether any action folded so far carries an authorization requirement — the ONE fact
     * {@link connectionOf} turns into this app's flow, and a fold rather than a literal because the
     * listing is per ACTION and the flow is per TOOLKIT.
     */
    authorizes: boolean;
  };
  const counts = new Map<string, Tally>();
  for await (const item of pagedItems({
    pageSize: DIRECTORY_PAGE_SIZE,
    maxPages: CATALOGUE_MAX_PAGES,
    concurrency: DIRECTORY_CONCURRENCY,
    page: (offset) =>
      vendorCall("the app catalogue listing", () =>
        client.tools.list({ limit: DIRECTORY_PAGE_SIZE, offset }),
      ),
    malformed:
      "Arcade did not answer with a tool list, so its app catalogue could not be read.",
    unending: `Arcade's catalogue never ended after ${CATALOGUE_MAX_PAGES} pages, so it is not trusted.`,
    incomplete: (seen, total) =>
      `Arcade listed ${seen} of ${total} actions, so its app catalogue is incomplete.`,
    unreadableTotal: (shown) =>
      `Arcade reported its app catalogue's total_count as ${shown}, which is not a count, so whether the catalogue was listed in full could not be checked.`,
  })) {
    const toolkit = (
      item as { toolkit?: { name?: unknown; description?: unknown } } | null
    )?.toolkit;
    // AN EMPTY NAME IS NO NAME, the same judgement {@link textOf} makes: the name is this app's
    // SLUG as well as its label, so an action whose toolkit is named `""` would otherwise raise a
    // blank, unconnectable row in the picker rather than being skipped as unreadable.
    const name = textOf(toolkit?.name);
    if (!name) continue;
    const classified = isClassified(record(item)?.metadata);
    // READ OFF THIS ACTION, never written down for the catalogue; see {@link requiresAuthorization}.
    // Asked AFTER the name, so a refusal can say which app it is about, and BEFORE the scopes, so an
    // unreadable authorization block is refused in that function's words rather than the scopes'.
    const authorizes = requiresAuthorization(item, name);
    const scopes = scopesOf(item, name);
    const standing =
      counts.get(name) ??
      ({
        slug: name,
        name,
        // An absent description IS an empty one here: the field is a label with a blank default,
        // not an identity, so nothing is shadowed by the two reading alike.
        description: textOf(toolkit?.description) ?? "",
        // NEITHER IS A STAND-IN FOR SOMETHING UNREAD: a tool's `toolkit` object carries `name`,
        // `description` and `version` and nothing else — the SDK's `ToolDefinition.Toolkit` says
        // so and the live listing agrees — so these two are Arcade publishing no logo and no
        // category, which is what `BrokerApp.logo` is nullable for. A logo, where one exists, is
        // filled in afterwards by `backfillBrokeredLogos` from outside the vendor's listing.
        logo: null,
        categories: [],
        actionCount: 0,
        classifiedCount: 0,
        scopedActionCount: 0,
        permissions: new Set<string>(),
        authorizes: false,
      } satisfies Tally);
    standing.actionCount += 1;
    if (classified) standing.classifiedCount += 1;
    if (authorizes) standing.authorizes = true;
    if (scopes.length > 0) {
      standing.scopedActionCount += 1;
      // SORTED, THEN JOINED. The other order makes one permission into two the first time the
      // vendor lists the same scopes in a different sequence.
      standing.permissions.add([...scopes].sort().join(" "));
    }
    counts.set(name, standing);
  }
  // `permissionCount` IS READ OFF THE FINISHED SET, never kept per page: a size taken mid-listing
  // is a count of the sets seen so far, which is a different number on every page but the last.
  // `connection` IS READ OFF THE FINISHED FOLD for `permissionCount`'s reason: a kind decided
  // mid-listing is a verdict about the actions seen so far, and the action that carries the
  // authorization may be on the last page.
  return [...counts.values()].map(({ permissions, authorizes, ...app }) => ({
    ...app,
    permissionCount: permissions.size,
    connection: connectionOf(authorizes),
  }));
}

const FIELDS_REFUSAL =
  "Arcade has no per-person field entry: what it asks for is a deployment-wide secret (admin.secrets, e.g. GITHUB_SERVER_URL) that an operator sets once for everybody, so a form asking a person to type one would collect a value that is not theirs and share it with everyone. Set it in the Arcade dashboard instead.";

type ConnectionRow = Arcade.Admin.UserConnectionResponse;

/** Page size for the auth-provider configuration listing. A short page ends it, as `listApps`. */
const AUTH_PROVIDER_PAGE_SIZE = 100;
/** A runaway guard, not a bound. */
const AUTH_PROVIDER_MAX_PAGES = 100;

/** Page size for the user-connection listing. A short page ends it, as `listApps`. */
const CONNECTION_PAGE_SIZE = 100;
/** A runaway guard, not a bound. */
const CONNECTION_MAX_PAGES = 100;

/**
 * The INSTANCE ids of every auth provider this project has configured of one TYPE.
 *
 * THERE ARE THREE THINGS AND THEY NEED THREE WORDS. `provider` in this codebase is the BROKER
 * (`arcade`); `authProvider` is the vendor's OAuth provider TYPE (`google`); and this is the third,
 * the provider INSTANCE — an operator's configuration OF a type, which Arcade keys by its own id
 * (`google-openbot`, `arcade-google`, `cpk-poc`). On an auth-provider config `id` is the INSTANCE
 * and `provider_id` is the TYPE. Verbatim from the live project:
 *
 * ```
 * {"id":"cpk-poc",        "provider_id":"github", "type":"oauth2", "status":"active"}
 * {"id":"google-openbot", "provider_id":"google", "type":"oauth2", "status":"active"}
 * {"id":"arcade-google",  "provider_id":"google", "type":"oauth2", "status":"active"}
 * ```
 *
 * A SET AND NEVER ONE ID: `arcade-google` and `google-openbot` are both of type `google`, and a
 * person may hold a connection under either. Reducing to one would drop real connections.
 *
 * PAGED, AND A MALFORMED LISTING THROWS, on `listApps`' argument and with its guards: a truncated
 * config list would silently answer "not connected" for whoever is held under an instance that fell
 * off the end. Folded to lower case on the way in, so the comparison is Amendment 16's.
 */
async function authProviderInstances(
  client: Arcade,
  authProvider: string,
): Promise<Set<string>> {
  const wanted = authProvider.toLowerCase();
  const instances = new Set<string>();
  for await (const item of pagedItems({
    pageSize: AUTH_PROVIDER_PAGE_SIZE,
    maxPages: AUTH_PROVIDER_MAX_PAGES,
    page: (offset) =>
      vendorCall(
        `the auth-provider configuration listing for ${authProvider}`,
        () =>
          client.admin.authProviders.list({
            query: { limit: AUTH_PROVIDER_PAGE_SIZE, offset },
          }),
      ),
    malformed: `Arcade did not answer with an auth-provider list, so the configurations of ${authProvider} its connections are held under could not be read.`,
    unending: `Arcade's auth-provider list never ended after ${AUTH_PROVIDER_MAX_PAGES} pages, so it is not trusted.`,
    incomplete: (seen, total) =>
      `Arcade listed ${seen} of ${total} auth providers, so its configuration list is incomplete.`,
    unreadableTotal: (shown) =>
      `Arcade reported its auth-provider list's total_count as ${shown}, which is not a count, so whether the configurations of ${authProvider} were listed in full could not be checked.`,
  })) {
    const config = record(item);
    const instance = textOf(config?.id);
    if (instance && textOf(config?.provider_id)?.toLowerCase() === wanted) {
      instances.add(instance.toLowerCase());
    }
  }
  return instances;
}

/**
 * The connections an account holds under a toolkit's AUTH PROVIDER.
 *
 * FILTERED ON THE PROVIDER, NOT THE TOOLKIT NAME — AND NOT ON THE PROVIDER TYPE EITHER. Both halves
 * of that are measured, and the second is why this reads a third listing rather than comparing two
 * strings.
 *
 * THE TOOLKIT NAME IS THE WRONG SPELLING because a provider equals the toolkit only when an
 * operator happened to name it so (`Github`, `Asana`, `Attio`); one Google connection serves
 * `Gmail` and `GoogleCalendar` both. So the toolkit is resolved through `authProviderOf`, which is
 * where that mapping lives.
 *
 * AND `authProviderOf`'S ANSWER IS ALSO THE WRONG SPELLING FOR A CONNECTION ROW, because
 * `provider_id` MEANS TWO DIFFERENT THINGS ON THE TWO OBJECTS. Measured once, in the 2026-10-13 run
 * of `tests/arcade-live.test.ts` against a live Arcade project; nothing in CI re-checks it (see
 * `docs/plugins/arcade.md`):
 *
 * - on a tool listing, `requirements.authorization.provider_id` — what `authProviderOf` reads — is
 *   the provider TYPE: `"google"`;
 * - on a user-connection row, `provider_id` is the provider INSTANCE id, the operator's
 *   configuration: `"google-openbot"`, `"arcade-google"`, `"cpk-poc"`.
 *
 * A connection row's full key set, verbatim, carries NO vendor-type field at all: `id`,
 * `provider_type`, `connection_id`, `connection_status`, `scopes`, `user_id`, `provider_id`,
 * `provider_description`, `provider_user_info` — and `provider_type` is `"oauth2"`, the auth SCHEME
 * rather than the vendor. The instance id is the ONLY link to the vendor. So `"google"` never
 * equals `"google-openbot"`, a direct comparison matches nothing on any real deployment — with
 * Arcade's own default providers too, which are `arcade-google` and `arcade-github` and never the
 * bare type — and `isConnected` reads false, `accountName` null, and `revoke` false WITHOUT
 * SPENDING A DELETE, so nothing is ever revoked at the vendor. Do not "simplify" this back: every
 * fixture that spells the two sides alike hides it.
 *
 * The bridge is {@link authProviderInstances}: the type `authProviderOf` answered is expanded, once
 * per call, into the SET of configured instance ids of that type, and a row matches when its
 * `provider_id` is in that set (case-insensitively — Amendment 16's client-side fold stands). Both
 * the provider and the configuration list are read ONCE per call, never per row.
 *
 * PAGED THROUGH {@link pagedItems}, NEVER THROUGH THE SDK'S `for await (… of … .list(…))`. That
 * iterator asks `OffsetPage.nextPageRequestOptions`, which returns `null` the moment `total_count`
 * is falsy — and the constructor coerces an ABSENT `total_count` to `0`. So against any engine that
 * omits the field, the SDK's own auto-pagination stops after page one: measured at 30 connections
 * served 10 to a page, ONE request went out, `isConnected` answered `true`, `accountName` read a
 * name off page one, and `revoke` DELETED TEN AND ANSWERED `true` while twenty connections stayed
 * live at the vendor. That is the outcome `revoke`'s own comment forbids — a partial ask reading as
 * a clean success. Reading to a SHORT PAGE instead ends on evidence the engine cannot omit, and an
 * unverifiable listing THROWS rather than answering short, so no caller here can mistake a first
 * page for the whole of what somebody holds.
 *
 * A ROW UNDER AN INSTANCE THE CONFIG LIST DOES NOT NAME DOES NOT MATCH — a provider configuration
 * deleted while a connection outlives it. That is fail-closed: the row is left alone rather than
 * deleted on a guess about which vendor it belongs to.
 *
 * EVERY ATTRIBUTABLE ROW IS RETURNED, DEAD ONES INCLUDED, AND LIVENESS IS THE CALLER'S QUESTION.
 * A row carries its own `connection_status`, and {@link connectionIsLive} reads it — but here,
 * because the two kinds of caller need opposite things from a row the vendor reports as finished:
 * `isConnected` and `accountName` must not count it, and `revoke` must still delete it. Filtering it
 * out at this level would answer both at once, and the one it answered wrongly would be the
 * destructive one.
 *
 * AN UNRESOLVED TOOLKIT REFUSES, AND DOES NOT FALL BACK TO THE TOOLKIT NAME. The fallback is
 * refused for the reason it always was — it would silently restore the instance/type defect under
 * a different spelling, invisibly against every fixture in the tree. But ANSWERING NO ROWS IS NOT
 * THE OTHER OPTION, and that is this function's own measured defect. A toolkit whose actions name
 * ZERO provider ids, or TWO OR MORE of them, is not a toolkit with no connections: it is a listing
 * this deployment could not read an attribution out of. Answering `[]` for it made `isConnected`
 * false and `accountName` null for somebody genuinely connected — so Connect minted a SECOND
 * authorization beside the live one — and made `revoke` answer `false` ("there was nothing to
 * withdraw") WITHOUT SPENDING A SINGLE DELETE, while `store.ts`'s disconnect path deletes the
 * local `brokered_connections` row on that answer regardless. The outcome is the one
 * `broker.ts`'s `revoke` contract forbids outright: a LIVE grant at the vendor that no row this
 * deployment holds any longer names, and no way back but guessing which app it belonged to.
 *
 * So an unattributable toolkit throws a {@link BrokerRefusalError} naming what the listing said,
 * exactly as a malformed one does — `authProviderOf` and {@link authProviderInstances} THROW on a
 * listing that is malformed, truncated against its own reported total, or never-ending, and this
 * joins them. All three lifecycle members refuse together, which is the point: the refusal reaches
 * the Disconnect path BEFORE any local row is deleted, so the row is still standing on the second
 * press, and the Connect screen says why rather than offering a second grant.
 *
 * THE SEAM'S `authProviderOf` STILL ANSWERS `null`, and that is not the same decision. Its caller
 * is the sibling resolver in `store.ts`, which counts an unresolved app as `unanswered` and ends
 * NOTHING for it — fail-closed on a question that spends no delete. Here the question is the
 * destructive one.
 */
async function connectionsFor(
  client: Arcade,
  vendorUserId: string,
  toolkit: string,
): Promise<ConnectionRow[]> {
  const { named, unreadable } = await authProvidersNamedBy(client, toolkit);
  // FIRST, because an unreadable action makes both counts below unreliable: it may name none, the
  // one already read, or another.
  if (unreadable) {
    throw new BrokerRefusalError(
      unreadableProviderSentence(toolkit, unreadable),
    );
  }
  if (named.size !== 1) {
    throw new BrokerRefusalError(
      named.size === 0
        ? `Arcade's action listing for ${toolkit} names no auth provider at all, so which of this account's connections belong to ${toolkit} could not be read. Nothing was read as connected and nothing was withdrawn — a connection may still be live at the vendor. Give ${toolkit} an auth provider in the Arcade dashboard and try again.`
        : `Arcade's action listing for ${toolkit} names ${named.size} different auth providers (${[...named].sort().join(", ")}), so which of this account's connections belong to ${toolkit} could not be read. Nothing was read as connected and nothing was withdrawn — a connection may still be live at the vendor. Settle ${toolkit} on one auth provider in the Arcade dashboard and try again.`,
    );
  }
  // The one id, taken off the set the refusal above has already narrowed to exactly one.
  const [authProvider] = [...named];
  const instances = await authProviderInstances(client, authProvider);
  const rows: ConnectionRow[] = [];
  for await (const item of pagedItems({
    pageSize: CONNECTION_PAGE_SIZE,
    maxPages: CONNECTION_MAX_PAGES,
    page: (offset) =>
      vendorCall(`the connection listing for ${toolkit}`, () =>
        client.admin.userConnections.list({
          user_id: vendorUserId,
          limit: CONNECTION_PAGE_SIZE,
          offset,
        }),
      ),
    malformed: `Arcade did not answer with a connection list, so what this account holds at ${toolkit} could not be read.`,
    unending: `Arcade's connection list never ended after ${CONNECTION_MAX_PAGES} pages, so it is not trusted.`,
    incomplete: (seen, total) =>
      `Arcade listed ${seen} of ${total} connections, so what this account holds at ${toolkit} could not be read in full.`,
    unreadableTotal: (shown) =>
      `Arcade reported its connection list's total_count as ${shown}, which is not a count, so whether what this account holds at ${toolkit} was listed in full could not be checked.`,
  })) {
    /*
     * A ROW THAT IS NOT AN OBJECT IS A HOLE IN THE LISTING, AND A HOLE IS NOT A ROW TO SKIP.
     *
     * `items: [null]` is what the live API sent here, and `item as ConnectionRow` believed it: the
     * very next line read `row.provider_id` off `null` and raised a bare `TypeError`, which is the
     * wrong answer in both directions. It carries a stack trace onto the Disconnect path where
     * this deployment's own sentence belongs; and the only reason the revoke invariant held on
     * this shape was that a crash is technically "not answering" — make the cast defensive with a
     * skip or a `?? []` and the listing silently becomes two rows instead of three, which is
     * `revoke` answering off a listing it could not read whole, the exact outcome
     * `broker.ts:712-717` forbids.
     *
     * SO IT REFUSES, in the register of this listing's own `malformed` sentence one block up: the
     * unreadable row is not attributable to any provider instance, and a DELETE spent on the rows
     * BESIDE it would be a partial ask reported as a clean success.
     */
    // ARRAYS ARE REFUSED WITH THE REST, which {@link record} alone would not do — it answers a
    // list as an object, and a list has no `provider_id`, so the row would be dropped silently
    // and the listing would again be read short.
    const row = Array.isArray(item) ? null : record(item);
    if (!row) {
      throw new Error(
        `Arcade's connection list carried ${shapeOf(item)} where a connection belongs, so what this account holds at ${toolkit} could not be read.`,
      );
    }
    const instance = textOf(row.provider_id)?.toLowerCase();
    if (instance !== undefined && instances.has(instance))
      rows.push(row as ConnectionRow);
  }
  return rows;
}

/**
 * The one `connection_status` measured on a usable connection at the live API: `"active"`.
 *
 * AN ALLOWLIST OF THE LIVE SPELLING RATHER THAN A DENYLIST OF THE DEAD ONES, because the dead
 * vocabulary cannot be enumerated from here — the SDK declares the field as a bare
 * `connection_status?: string` with no union, and a denylist missing one spelling would go on
 * reading that spelling as connected, which is the defect itself.
 */
const LIVE_CONNECTION_STATUS = "active";

/**
 * The `status` spellings a FRESH MINT may answer under which sending somebody to the consent screen
 * is the right next step: the flow has not begun (`not_started`) or is waiting for them (`pending`).
 *
 * AN ALLOWLIST, AND NOT THE SDK'S UNION TURNED AROUND, for {@link LIVE_CONNECTION_STATUS}'s reason.
 * `AuthorizationResponse.status` is declared as a four-way union in the generated types, but the
 * union is a description of what Arcade sends today, not a constraint on what arrives: a spelling
 * outside it deserializes with no complaint from anybody. The two outcomes that are NOT a consent
 * screen — `completed` and `failed` — are therefore refused by absence rather than by name, so that
 * a fifth spelling is refused with them instead of being handed to a browser as a live redirect.
 *
 * SEPARATE FROM {@link grantStateOf}'S READING, deliberately. That one reads the LISTING's
 * `requirements.authorization`, whose vocabulary is `token_status` plus an `active`/`inactive`
 * status, and whose question is "what does this account already hold". This one reads a mint's own
 * answer, whose question is "is a consent screen what happens next". Sharing a table between them
 * would make one vendor's change to either vocabulary move the other answer too.
 */
const MINT_AWAITS_CONSENT_STATUSES = new Set(["not_started", "pending"]);

/**
 * The listing's `token_status` spellings under which this account holds no usable token and a
 * consent is what would give it one. `completed` is the held grant; anything else is `unknown`.
 * Kept apart from {@link MINT_AWAITS_CONSENT_STATUSES} for the reason that set's docblock gives,
 * even where the spellings overlap: `failed` belongs here (a failed token is one to consent again
 * for) and not there (a failed MINT is not a consent screen to send somebody to).
 */
const TOKEN_AWAITS_CONSENT_STATUSES = new Set([
  "not_started",
  "pending",
  "failed",
]);

/**
 * Whether a connection row is one somebody can actually USE, read off the row's OWN `connection_status`.
 *
 * THE ROW'S EXISTENCE IS NOT THE ANSWER, WHICH IS WHAT THIS IS FOR. A user-connection row carries
 * `connection_status` beside its ids — it is in the key set {@link connectionsFor} quotes verbatim
 * — and that field is the vendor saying whether the connection still works. Treating a row's mere
 * presence as a yes answers `isConnected: true`, with a name beside it, for a connection Arcade is
 * reporting as expired, revoked at the provider, pending or failed. Nothing then goes wrong until a
 * tool call fails, far from the screen that said Connected, with no way back but guessing.
 *
 * SILENCE IS NOT A NO. An ABSENT status — the key missing, `undefined` or `null` — reads as live,
 * deliberately: the field is OPTIONAL on the wire (`connection_status?: string`), so a pessimistic
 * reading would answer "not connected" for every real connection against any engine that omits it
 * — `isConnected` false and `accountName` null — which is precisely the live defect this seam
 * already suffered once when it compared a provider TYPE to a provider INSTANCE. The rule is
 * therefore: the vendor said something other than live → not live; the vendor said nothing → the
 * existence of the row is all the evidence there is, and it stands.
 *
 * BUT A STATUS THAT IS PRESENT AND CANNOT BE READ IS NOT SILENCE. `{}`, `false`, `0`, a list, or a
 * BLANK string is the vendor saying SOMETHING about this connection in a shape this deployment does
 * not read — and "live" is the one answer that would act on it. It reads as not live, by
 * {@link vendorStatusOf}'s rule: a blank string on a field whose value is a decision is unreadable,
 * the judgement `authProvidersNamedBy` already makes of a blank `provider_id`. (This file once said
 * "absent or empty reads as live"; the empty half is withdrawn, so that one rule — absent is
 * `undefined`/`null`, blank is unreadable — holds on every vendor authorization field.)
 *
 * FOLDED AND TRIMMED, Amendment 16's client-side fold, for the reason every other comparison in
 * this file is: a case the vendor changes must not change an answer about somebody's account.
 *
 * NOT A FILTER ON {@link connectionsFor}. `revoke` must still delete a dead row — it is a row at the
 * vendor, and leaving it behind as unreachable debris while answering `false` ("there was nothing")
 * is the failure mode `revoke`'s own contract forbids. So the listing stays whole and only the
 * POSITIVE reads — `isConnected`, `accountName` — ask this question.
 */
function connectionIsLive(row: ConnectionRow): boolean {
  const status = vendorStatusOf(row.connection_status);
  if (status.kind === "absent") return true;
  return status.kind === "text" && status.text === LIVE_CONNECTION_STATUS;
}

/**
 * DELETE TAKES `connection_id` (`ac_...`), NOT `id` (`at_...`). A user-connection row carries both
 * and the listing prints `id` FIRST; the SDK declares `delete(id: string)` and does not say which.
 * Measured by hand on 2026-10-12 against a live Arcade project, with a script that is not in this
 * repository, and re-checked by nothing in CI: `at_...` answers 500, `ac_...` answers 204. Reading
 * the obvious field fails only when somebody presses Disconnect, the worst time to find out.
 */
async function deleteConnection(
  client: Arcade,
  connectionId: string | undefined,
): Promise<void> {
  if (!connectionId) {
    throw new Error("Arcade connection has no connection_id to delete.");
  }
  await vendorCall("a connection delete", () =>
    client.admin.userConnections.delete(connectionId),
  );
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;

/**
 * One listed action read into this deployment's vocabulary, or nothing when it has no name.
 *
 * `requirements.met` IS A BOOLEAN WITH TWO UNRELATED CAUSES AND IS NEVER READ HERE. It is false
 * both when the person has not consented and when a deployment-wide secret is unset — the live
 * listing shows `Github` requiring `GITHUB_SERVER_URL`, which an operator sets once for everybody
 * and which no amount of consenting moves. Sending somebody to a consent screen over that one
 * sends them somewhere that cannot help them, so the secrets are read FIRST and answer
 * `needs-operator` with the keys they name.
 *
 * `unknown` IS ITS OWN STATE RATHER THAN A PESSIMISTIC `needs-consent`, because not knowing is not
 * the same as not connected: telling somebody to authorize something they already authorized sends
 * them round twice. So anything the listing does not say clearly answers `unknown` with the reason.
 */
function grantStateOf(item: unknown): GrantState[] {
  const tool = record(item);
  const action = textOf(tool?.qualified_name);
  if (!action) return [];
  const requirements = record(tool?.requirements);

  /*
   * A SECRETS FIELD THAT IS NOT A LIST IS UNREADABLE, NOT EMPTY — the same judgement `classify`
   * makes about an empty `behavior`, one requirement description along. `secrets` absent is the
   * ordinary case and genuinely means this action needs no deployment secret; `secrets: {}`, or any
   * other non-list, is Arcade describing requirements in a shape this cannot read, and silently
   * folding it to "no secrets, none missing" lets the function go on to answer `authorized` for an
   * action that may be waiting on an unset `GITHUB_SERVER_URL`. Nobody is then told to set it: the
   * `needs-operator` state that exists to name it cannot fire, and the person is left with an
   * action the screen says they hold and the vendor refuses. `unknown` with a reason is what the
   * docblock's "anything the listing does not say clearly" already promises.
   */
  const rawSecrets = requirements?.secrets;
  if (
    rawSecrets !== undefined &&
    rawSecrets !== null &&
    !Array.isArray(rawSecrets)
  ) {
    return [
      {
        action,
        state: "unknown",
        reason:
          "Arcade listed this action's deployment secrets as something other than a list, so whether any is unset could not be read.",
      },
    ];
  }
  const missing: string[] = [];
  let secretUnreadable = false;
  for (const raw of Array.isArray(rawSecrets) ? rawSecrets : []) {
    const secret = record(raw);
    const key = textOf(secret?.key);
    if (!key) {
      secretUnreadable = true;
      continue;
    }
    if (secret?.met === false) missing.push(key);
    else if (secret?.met !== true) secretUnreadable = true;
  }
  if (missing.length > 0) return [{ action, state: "needs-operator", missing }];
  if (secretUnreadable) {
    return [
      {
        action,
        state: "unknown",
        reason:
          "Arcade listed a deployment secret for this action without saying whether it is set.",
      },
    ];
  }

  // NO AUTHORIZATION BLOCK IS THE VENDOR SAYING THIS ACTION NEEDS NONE, with every secret it does
  // need already read as set above — so it is usable, and `authorized` with no scopes is the state
  // that says so. See {@link authorizationRequirementOf} for why this is the one reading.
  // `not-required`, NEVER `held`: nobody approved it and no approval reaches it, so the consent
  // copy must not count it among what an approval approves. See {@link GrantState}.
  const read = authorizationRequirementOf(item);
  if (read.kind === "none") {
    return [
      {
        action,
        state: "authorized",
        scopes: [],
        authorization: "not-required",
      },
    ];
  }
  if (read.kind === "unreadable") {
    return [
      {
        action,
        state: "unknown",
        reason:
          read.field === "requirements"
            ? `Arcade listed this action's requirements as ${read.shape}, so what this account holds could not be read.`
            : `Arcade listed this action's authorization as ${read.shape}, so what this account holds could not be read.`,
      },
    ];
  }
  // THE SCOPES BY THE ONE READING, see {@link requiredScopesOf}: an unreadable `oauth2` or
  // `scopes` is `unknown`, never `[]` — `authorized []` is "the connection is the whole grant",
  // which is an answer about this account the listing did not give.
  const scopesRead = requiredScopesOf(item);
  if (scopesRead.kind === "unreadable") {
    return [
      {
        action,
        state: "unknown",
        reason: `Arcade listed the permissions this action needs as ${scopesRead.shape}, so what this account holds could not be read.`,
      },
    ];
  }
  const { scopes } = scopesRead;
  /*
   * `token_status` IS THE WHOLE OF WHAT THIS ACCOUNT HOLDS, AND `status` IS NOT READ HERE AT ALL.
   * The two sit side by side and answer different questions: `status` (`active`/`inactive`, with a
   * `status_reason` such as "Provider not found" in `fixtures/arcade-catalogue.json`) is the AUTH
   * PROVIDER's standing at this deployment, and is the same for everybody; `token_status` is this
   * account's token. Reading `status: "active"` as a grant when `token_status` was missing marked
   * EVERY action of a configured provider as held by everyone the listing was asked about (A7c), and
   * reading `inactive` as "go and consent" sends somebody to a consent screen for a provider that
   * is not there. So an absent or unreadable `token_status` is `unknown`, with the reason, and the
   * text is FOLDED AND TRIMMED by {@link vendorStatusOf} as every other vendor status is.
   */
  const tokenStatus = vendorStatusOf(read.authorization.token_status);
  if (tokenStatus.kind !== "text") {
    return [
      {
        action,
        state: "unknown",
        reason:
          tokenStatus.kind === "absent"
            ? "Arcade's listing did not say whether this account holds a token for this action."
            : `Arcade's listing gave this account's token status for this action as ${tokenStatus.shape}, so whether it is held could not be read.`,
      },
    ];
  }
  if (tokenStatus.text === "completed") {
    return [{ action, state: "authorized", scopes, authorization: "held" }];
  }
  if (TOKEN_AWAITS_CONSENT_STATUSES.has(tokenStatus.text)) {
    return [{ action, state: "needs-consent", scopes }];
  }
  return [
    {
      action,
      state: "unknown",
      reason:
        "Arcade's listing gave this account's token status for this action in a spelling this deployment does not read.",
    },
  ];
}

/**
 * What one account holds at one app, action by action.
 *
 * THIS IS THE ONE PLACE A `user_id` IS SENT ON A LISTING. The transport's `listTools` sends none
 * and reads no per-person state off the answer, because a catalogue is the same for everybody and a
 * per-person listing would make it one person's. Here the question IS about a person, so the
 * account's vendor id goes out with it.
 *
 * PAGED TO THE END, as `listApps` is and for its reason: this answers ONE `GrantState` PER ACTION,
 * so a single first page would quietly drop every action past it — `GithubApi` publishes hundreds —
 * and the grants screen would show a partial holding as the whole of one. A short page ends it and
 * an unverifiable listing throws; see {@link pagedItems}.
 */
async function grantsFor(
  client: Arcade,
  vendorUserId: string,
  toolkit: string,
): Promise<GrantState[]> {
  const grants: GrantState[] = [];
  for await (const item of pagedItems({
    pageSize: CATALOGUE_PAGE_SIZE,
    maxPages: CATALOGUE_MAX_PAGES,
    concurrency: CATALOGUE_CONCURRENCY,
    page: (offset) =>
      vendorCall(`the action listing for ${toolkit}`, () =>
        client.tools.list({
          toolkit,
          user_id: vendorUserId,
          limit: CATALOGUE_PAGE_SIZE,
          offset,
        }),
      ),
    malformed: `Arcade did not answer with an action list for ${toolkit}, so what this account holds there could not be read.`,
    unending: `Arcade's action list for ${toolkit} never ended after ${CATALOGUE_MAX_PAGES} pages, so it is not trusted.`,
    incomplete: (seen, total) =>
      `Arcade listed ${seen} of ${total} actions for ${toolkit}, so what this account holds there could not be read in full.`,
    unreadableTotal: (shown) =>
      `Arcade reported the action list for ${toolkit} with a total_count of ${shown}, which is not a count, so whether what this account holds there was listed in full could not be checked.`,
  })) {
    grants.push(...grantStateOf(item));
  }
  return grants;
}

/**
 * The auth provider a toolkit's connections are held under, read off the LISTING ITSELF.
 *
 * READ, NEVER DERIVED FROM THE TOOLKIT NAME. `requirements.authorization.provider_id` is the field
 * the fixture already carries beside the auth-config `id`, and it names an auth-provider
 * configuration rather than a toolkit — one Google provider serves `Gmail` and `GoogleCalendar`
 * both. Reading it is correct under BOTH readings of the field: if it did turn out to equal the
 * toolkit slug, the listing would simply say so. Comparing it to the toolkit name is correct under
 * only one, and would be invisible against every fixture in this tree, where `Github`, `Asana` and
 * `Attio` all happen to be named after themselves. There is NO FALLBACK to the toolkit name.
 *
 * PAGED TO ITS END THROUGH {@link pagedItems}, LIKE EVERY OTHER LISTING IN THIS FILE. An earlier
 * revision read ONE unpaged request here and argued the saving was free: every tool in a toolkit
 * shares its auth provider, so a further page could only repeat what the first already said. THAT
 * ARGUMENT IS DISPROVEN, measured against a real HTTP engine — a 150-action `Gmail` listing whose
 * first 100 actions sit under `google` and whose last 50 under `microsoft` answered `google`, off
 * the single request `/v1/tools?toolkit=Gmail`. The guard below could not fire, because it was
 * reading a PREFIX and a prefix agrees with itself. "Every tool shares its provider" is a statement
 * about what a toolkit ought to be, not about what the vendor sends, and this function's whole job
 * is to read what the vendor sends. The request also carried NO `limit`, so the window it judged
 * from was the vendor's default rather than {@link CATALOGUE_PAGE_SIZE} — a number this deployment
 * never chose and the vendor may change.
 *
 * The cost is one extra request only on a toolkit larger than a page, and it buys the same property
 * `grantsFor` and `connectionsFor` are paged for: a first page can never present as the whole of
 * one. A TRUNCATED LISTING NOW THROWS here too, rather than resolving a provider off whatever
 * arrived — the `incomplete` sentence below — which is right for the reason `connectionsFor`'s
 * comment gives: these three callers spend deletes.
 *
 * AND IT GUARDS RATHER THAN ASSUMES. The DISTINCT non-null provider ids across the WHOLE listing
 * are collected and anything other than exactly one answers `null`, so a toolkit that disagrees
 * with itself is UNANSWERED rather than silently resolved to whichever action came first. Case is
 * carried through untouched, so two spellings of one provider count as two and are likewise
 * unanswered; whether they are the same provider is the caller's comparison, and
 * `connectionSiblings` folds case for the one caller that makes it. A listing carrying ANY action
 * whose authorization could not be read is unanswered too, however many ids sit beside it — see
 * {@link authProvidersNamedBy}.
 *
 * `null` IS WHAT UNANSWERED MEANS, AND IT IS NOT AN ANSWER ANY CALLER MAY SPEND. It is not "no
 * provider", and a toolkit with no provider id anywhere lands on it for the same reason an
 * ambiguous one does. What a caller must do with it depends on what its own answer costs:
 *
 * - {@link connectionsFor} — the connection lifecycle, where the answer spends DELETEs and decides
 *   whether somebody is shown as connected — REFUSES, and reads {@link authProvidersNamedBy}
 *   directly so its sentence can say whether the listing named none or several. Answering no rows
 *   there was the live defect: `revoke` said `false` ("nothing to withdraw") with no delete spent
 *   while the caller deleted the local row anyway, and `isConnected`/`accountName` sent somebody
 *   who is already connected round a second authorization. Its comment has that in full.
 * - The SEAM member below hands `null` on unchanged, for `store.ts`'s sibling resolver, which
 *   counts an unresolved app as `unanswered` and ends nothing for it. That question spends
 *   nothing, so fail-closed is a real answer there and the seam's `Promise<string | null>` stands.
 *
 * `requirements.met` IS NOT READ HERE EITHER, for `grantStateOf`'s reason: this reads a DIFFERENT
 * field of the same `requirements.authorization` object.
 */
async function authProviderOf(
  client: Arcade,
  toolkit: string,
): Promise<string | null> {
  const { named, unreadable } = await authProvidersNamedBy(client, toolkit);
  // An unreadable block is UNANSWERED, for the reason several ids are: the one id beside it is not
  // the whole of what the listing says.
  if (unreadable) return null;
  return named.size === 1 ? [...named][0] : null;
}

/**
 * What a toolkit's listing says about its auth provider: the DISTINCT ids it names, and the first
 * action whose authorization this deployment could not read, if any.
 *
 * `unreadable` IS A THIRD ANSWER, NOT AN EMPTY CONTRIBUTION. An action whose `requirements` or
 * `requirements.authorization` arrives as a shape this deployment cannot read — or whose
 * `provider_id` is present and is not a name — might name ANY provider, so the set beside it is
 * not the whole of what the listing says. {@link authorizationRequirementOf} draws the same line for
 * the catalogue and the grants screen; this is that line applied to `provider_id`.
 */
type AuthProvidersNamed = {
  named: Set<string>;
  unreadable: {
    action: string | undefined;
    field: "requirements" | "authorization" | "provider_id";
    shape: string;
  } | null;
};

/**
 * Why a toolkit's provider could not be read off one unreadable action, for a refusal to say.
 * Names the FIELD and the SHAPE that arrived there, never the value, for {@link shapeOf}'s reason.
 */
function unreadableProviderSentence(
  toolkit: string,
  unreadable: NonNullable<AuthProvidersNamed["unreadable"]>,
): string {
  const where = unreadable.action
    ? `${toolkit}'s action ${unreadable.action}`
    : `one of ${toolkit}'s actions`;
  const field =
    unreadable.field === "provider_id"
      ? "auth provider id"
      : unreadable.field === "authorization"
        ? "authorization requirement"
        : "requirements";
  return `Arcade sent ${unreadable.shape} where ${where} carries its ${field}, so which auth provider ${toolkit}'s connections are held under could not be read — that action may name a provider the rest of the listing does not. Nothing was read as connected and nothing was withdrawn — a connection may still be live at the vendor. That is a change in what Arcade answers rather than a setting an operator can correct, so upgrading this deployment's @arcadeai/arcadejs is what fixes it.`;
}

/**
 * The DISTINCT auth provider ids a toolkit's listing names, read to the listing's end — and the
 * first action whose authorization could not be read.
 *
 * SEPARATED FROM {@link authProviderOf} SO THAT THE VERDICT AND THE EVIDENCE ARE TWO THINGS. The
 * seam's `authProviderOf` answers a provider or `null`, and `null` is a verdict with the evidence
 * thrown away — zero ids, nine ids and an unreadable block arrive at its caller as the same word.
 * {@link connectionsFor} REFUSES on any of them, and a refusal has to say which one happened and
 * name what it read, so it reads the evidence and `authProviderOf` folds it to its verdict. There is
 * still ONE reading of the wire.
 *
 * AN UNREADABLE BLOCK IS NO LONGER SKIPPED. It once contributed nothing and raised nothing, so a
 * `Gmail` listing of one `google` action beside one whose authorization arrived as a string
 * resolved to `google` — a single provider asserted off a listing this deployment did not read
 * whole, which is the fail-open direction for callers that spend DELETEs on the answer. ABSENCE is
 * still not unreadability: an action with no authorization block, or a block with no `provider_id`
 * (the live `Airtable` shape in `fixtures/arcade-catalogue.json`), names no provider and is read as
 * naming none, exactly as {@link authorizationRequirementOf} reads it.
 */
async function authProvidersNamedBy(
  client: Arcade,
  toolkit: string,
): Promise<AuthProvidersNamed> {
  const named = new Set<string>();
  let unreadable: AuthProvidersNamed["unreadable"] = null;
  for await (const item of pagedItems({
    pageSize: CATALOGUE_PAGE_SIZE,
    maxPages: CATALOGUE_MAX_PAGES,
    concurrency: CATALOGUE_CONCURRENCY,
    page: (offset) =>
      vendorCall(`the action listing for ${toolkit}`, () =>
        client.tools.list({ toolkit, limit: CATALOGUE_PAGE_SIZE, offset }),
      ),
    malformed: `Arcade did not answer with an action list for ${toolkit}, so the auth provider its connections are held under could not be read.`,
    unending: `Arcade's action list for ${toolkit} never ended after ${CATALOGUE_MAX_PAGES} pages, so the auth provider its connections are held under is not trusted.`,
    incomplete: (seen, total) =>
      `Arcade listed ${seen} of ${total} actions for ${toolkit}, so the auth provider its connections are held under could not be read in full.`,
    unreadableTotal: (shown) =>
      `Arcade reported the action list for ${toolkit} with a total_count of ${shown}, which is not a count, so whether the auth provider its connections are held under could be read in full is not known.`,
  })) {
    // Read to the END even after an unreadable action, so a truncated or malformed listing still
    // throws its own sentence rather than being reported as one unreadable row.
    const read = authorizationRequirementOf(item);
    if (read.kind === "none") continue;
    const action = textOf(record(item)?.qualified_name);
    if (read.kind === "unreadable") {
      unreadable ??= { action, field: read.field, shape: read.shape };
      continue;
    }
    const providerId = read.authorization.provider_id;
    if (providerId === undefined || providerId === null) continue;
    const provider = textOf(providerId);
    if (provider) named.add(provider);
    else
      unreadable ??= {
        action,
        field: "provider_id",
        shape: shapeOf(providerId),
      };
  }
  return { named, unreadable };
}

/**
 * The Arcade client, in the shape `createComposioClient` returns. `new Arcade({ apiKey })` opens no
 * socket and sends no request, so tests replace the SDK's PROTOTYPE methods before calling this.
 *
 * EVERY CALL TO THE VENDOR GOES THROUGH {@link vendorCall}, which is where a refusal becomes this
 * deployment's own sentence and the vendor's body stops. `callTool` still reaches the body's
 * `error.name` — a raw `APIError`'s `name` is the CLASS name through the prototype chain, never the
 * body's, so without the normalization the authorize prompt would be unreachable — but it reaches
 * it through {@link ArcadeFailureError}, not through a bare object thrown as if it were an error.
 */
export function createArcadeClient(apiKey: string): {
  actions: ArcadeActions;
  broker: ConnectedAppBroker;
} {
  const client = new Arcade({ apiKey });
  const actions: ArcadeActions = {
    // `total_count` IS NORMALIZED HERE, and this is the only place it can be. The transport
    // (`./arcade`) must not import this file — that direction is a cycle — so it cannot reach
    // {@link reportedTotalOf}, and what it receives has to already tell "the vendor did not say"
    // apart from "the vendor said zero". Handing it the SDK's `OffsetPage` does not: that object's
    // `total_count` is `body.total_count || 0`, so `listTools` read a `0` off an answer that
    // carried no total and its `raw.length < total` cross-check could never fire. The FIELD IS
    // OMITTED when the vendor omitted it, which is what the declared `total_count?: number` means.
    listTools: async (q) => {
      const answer = await vendorCall(
        `the action listing for ${q.toolkit}`,
        () =>
          client.tools.list({
            toolkit: q.toolkit,
            limit: q.limit,
            offset: q.offset,
          }),
      );
      // Passed through unchecked: a malformed listing is the transport's sentence to write, and
      // its own `Array.isArray` guard is what writes it. THE ITEMS ARE READ OFF THE RAW BODY for
      // {@link sentItemsOf}'s reason — handing over the page's manufactured `[]` would leave that
      // guard as dead as the totals the comment above describes, and a listing that answered no
      // items at all would refresh an app's actions down to none.
      const items = sentItemsOf(answer) as unknown[];
      // AND A TOTAL THIS CANNOT READ REFUSES HERE TOO, rather than being dropped on the way out.
      // The declared `total_count?: number` leaves the transport exactly two readings — a number
      // to cross-check against, or "the vendor did not say" — so a value that is neither has
      // nowhere honest to go: omitting it would switch off the transport's own
      // `raw.length < total` check and commit a truncated refresh as a whole catalogue.
      const total = reportedTotalOf(
        answer,
        (shown) =>
          `Arcade reported the action listing for ${q.toolkit} with a total_count of ${shown}, which is not a count, so whether the listing is whole could not be checked. Nothing was refreshed and the actions already recorded for this app are kept.`,
      );
      return total === undefined ? { items } : { items, total_count: total };
    },
    execute: async (r) =>
      vendorCall(`running ${r.tool_name}`, () =>
        client.tools.execute({
          tool_name: r.tool_name,
          input: r.input,
          user_id: r.user_id,
        }),
      ),
  };
  const broker: ConnectedAppBroker = {
    grantIsLocal: false,
    listApps: () => listApps(client),
    // 5.3: no auth config per app. Arcade's equivalent is an auth provider registered once in the
    // dashboard for the whole project, so there is nothing to create or delete here.
    ensureAuthConfig: async () => "not-needed",
    deleteAuthConfig: async () => {},
    // The field-entry pair REFUSES. Composio's field schemes are a person typing their own API key;
    // `admin.secrets` is a deployment-wide secret an operator sets once for everybody.
    connectionFields: () =>
      Promise.reject(new BrokerRefusalError(FIELDS_REFUSAL)),
    connectWithFields: () =>
      Promise.reject(new BrokerRefusalError(FIELDS_REFUSAL)),
    accountName: async ({ account, toolkit }) => {
      // Filtered by the row's own provider, as Composio's `accountsFor(..., toolkit, ...)` is: a
      // person connected to two apps must never be shown the OTHER app's name on this app's screen.
      //
      // AND BY THE ROW'S OWN `connection_status`, through {@link connectionIsLive}: this name is
      // shown beside "Connected", so a name read off a row the vendor reports as expired or revoked
      // says the connection is live in the one place somebody looks to check.
      for (const row of await connectionsFor(
        client,
        account.vendorUserId,
        toolkit,
      )) {
        if (!connectionIsLive(row)) continue;
        const info = row.provider_user_info as
          | { name?: unknown; login?: unknown }
          | null
          | undefined;
        const name = textOf(info?.name) ?? textOf(info?.login);
        if (name) return name;
      }
      return null;
    },
    // The mint. Stays a TOP-LEVEL member: the Composio connect flow calls it from routes.ts, so it
    // cannot move behind the nullable `authorizations` sub-surface.
    authorize: async ({ account, action }) => {
      if (!action) {
        throw new BrokerRefusalError(
          "Arcade grants per action, so an authorization needs the action it is for and none was given.",
        );
      }
      // NEVER SEND `next_uri`. THIS LOOKS LIKE A BUG AND IS A MEASUREMENT. The SDK declares the
      // field (`ToolAuthorizeParams.next_uri`), but against the live API it refuses EVERY value and
      // the mint answers `500 "error starting authorization challenge: invalid next URI"`: an app
      // page, the verifier's own origin, `cloud.arcade.dev` and a localhost address alike. Do not
      // "fix" this by passing a return address.
      //
      // `returnUrl` IS ACCEPTED AND IGNORED, for the same reason: the landing page comes from the
      // attempt row (spec D18), not from a parameter this vendor will take.
      //
      // THE REFUSAL IS MEDIATED, AND ON THIS CALL THAT IS NOT A STYLE POINT: the body an
      // authorization answers with is the one that carries a bearer `url`, and the SDK's `APIError`
      // puts the body it could not read a `message` off into its own `message`. See
      // {@link vendorCall}; the route's definite-or-uncertain decision reads `status` through
      // `normalizeArcadeError` and is unaffected.
      // THROUGH {@link requireBody}: a mint that answered an empty body, or a body of literal
      // `null`, has `answer === null` wearing `AuthorizationResponse`, and the `status` read below
      // would raise a bare `TypeError` rather than the sentence this route shows somebody.
      const answer = requireBody(
        `the authorization for ${action}`,
        await vendorCall(`the authorization for ${action}`, () =>
          client.tools.authorize({
            tool_name: action,
            user_id: account.vendorUserId,
          }),
        ),
      );
      // WHAT THE VENDOR SAID ABOUT THIS AUTHORIZATION, READ BEFORE ITS URL IS READ AS A NEXT STEP.
      // `tools.authorize` does not only answer "go to this screen": it answers `completed` for an
      // account that already holds the grant, `failed` for one the vendor could not begin — and it
      // may answer either WITH a `url` beside it, so the absent-url refusal below is not this guard
      // in disguise. Unread, both were handed back as a live consent link: somebody already
      // connected is sent round a screen they finished, and a failed authorization is dressed up
      // as a working one, with an `ar_…` recorded against the attempt that can never complete.
      //
      // AN ALLOWLIST OF THE SPELLINGS UNDER WHICH CONSENT IS GENUINELY THE NEXT STEP, for the
      // reason {@link LIVE_CONNECTION_STATUS} gives: the dead vocabulary cannot be enumerated from
      // here. The SDK's declared union is a convenience, not a promise about the wire — an engine
      // answering `revoked` or `expired` type-checks as nothing and a denylist missing that
      // spelling goes on sending a browser to it, which is the defect itself.
      //
      // SILENCE IS NOT A NO, as it is not in {@link connectionIsLive}: `status` is OPTIONAL on the
      // wire, so an ABSENT field (missing, `undefined`, `null`) leaves the url and the id as the
      // whole of the evidence and they stand. A status that is PRESENT AND UNREADABLE — `{}`,
      // `false`, a number, a blank string — is not silence: the vendor said something about this
      // authorization and this deployment cannot tell what, so the bearer url beside it is NOT
      // handed on as a live redirect. {@link vendorStatusOf} is the one reading of both, and it
      // FOLDS AND TRIMS the text for this file's standing reason: a case the vendor changes must not
      // change what somebody is told about their own account.
      //
      // A `BrokerRefusalError` AND NOT A BARE `Error`, which is the difference between being told
      // and being locked out. The mint route keys its three outcomes on what was thrown: an
      // authored refusal is DEFINITE, so the attempt is discarded and the actor may press Authorize
      // again at once, with this sentence shown; a bare `Error` normalizes to `null` and is read as
      // "the mint may be live", leaving the attempt standing for its fifteen-minute TTL. Nothing
      // IS live here — the vendor answered, and said this is not a consent to walk through.
      const read = vendorStatusOf(answer.status);
      if (read.kind === "unreadable") {
        throw new BrokerRefusalError(
          `Arcade answered this account's authorization for ${action} with ${read.shape} where its status belongs, so whether a consent screen is the next step could not be read and nobody was sent anywhere. Press Authorize again to start a fresh one.`,
        );
      }
      const status = read.kind === "text" ? read.text : undefined;
      if (status !== undefined && !MINT_AWAITS_CONSENT_STATUSES.has(status)) {
        throw new BrokerRefusalError(
          status === "completed"
            ? `Arcade answered that this account's authorization for ${action} is already completed, so nobody was sent to a consent screen. Reload this page: the grant it is reporting is already in place.`
            : `Arcade answered that this account's authorization for ${action} is "${status}" rather than one waiting for consent, so nobody was sent anywhere and nothing was connected. Press Authorize again to start a fresh one.`,
        );
      }
      // The url is a bearer capability: it goes back to the caller and nowhere else.
      const url = answer.url;
      if (typeof url !== "string" || url === "") {
        throw new Error(
          "Arcade answered an authorization with no url to visit.",
        );
      }
      // The mint's own `ar_…` id: spec D24 binds it to the callback's `auth_id`. A mint that
      // answered none is not a success, and the refusal is here so that a null can never be
      // minted from an Arcade answer — `authorizationId` is non-null for every Arcade mint.
      const authorizationId = answer.id;
      if (typeof authorizationId !== "string" || authorizationId === "") {
        throw new Error("Arcade answered an authorization with no id.");
      }
      return { redirectUrl: url, authorizationId };
    },
    // 6.2: the connection-lifecycle trio.
    // A LIVE ROW AND NOT MERELY A ROW. The seam's word is "currently attached to this app at the
    // vendor", and a row Arcade reports as expired, revoked, pending or failed is not that; see
    // {@link connectionIsLive}, which also says why a row with NO status still counts.
    isConnected: async ({ account, toolkit }) =>
      (await connectionsFor(client, account.vendorUserId, toolkit)).some(
        connectionIsLive,
      ),
    // Answers what was REQUESTED: true when something was found and every delete was accepted,
    // false when there was nothing. Every delete is attempted, then ANY failure throws: a partial
    // ask must not read as `false` ("nothing there") nor as a clean `true`.
    //
    // AND `false` IS ONLY EVER SAID OFF A LISTING READ WHOLE, which is {@link connectionsFor}'s
    // promise rather than this one's: an unreadable, truncated or UNATTRIBUTABLE listing throws out
    // of it before this line, so `rows.length === 0` here means the vendor said so. `false` with no
    // delete spent is the live defect's exact signature — the caller deletes the local row on it —
    // and `arcade-revoke-invariant.test.ts` asserts the outcome rather than any one mechanism.
    //
    // ON EVERY ROW, LIVE OR NOT, WHICH IS WHY THIS DOES NOT ASK {@link connectionIsLive}. A dead row
    // is still a row at the vendor: skipping it would leave it standing while this answered `false`
    // ("there was nothing to withdraw"), and a reconnect would then be made beside debris nobody can
    // see. Deleting a connection the vendor already considers finished costs one call and is the
    // only reading under which Disconnect means what it says.
    revoke: async ({ account, toolkit }) => {
      const rows = await connectionsFor(client, account.vendorUserId, toolkit);
      if (rows.length === 0) return false;
      const outcomes = await Promise.allSettled(
        rows.map((row) => deleteConnection(client, row.connection_id)),
      );
      const failed = outcomes.filter((o) => o.status === "rejected");
      if (failed.length > 0) {
        throw new Error(
          `Arcade revoke failed for ${failed.length} of ${rows.length} connections.`,
          { cause: (failed[0] as PromiseRejectedResult).reason },
        );
      }
      return true;
    },
    revokeAccount: (accountId) => deleteConnection(client, accountId),
    // 6.3: the read-only status pair. Both are DECLARED here because the seam requires them —
    // `grantsFor` is a member every broker answers, and `authorizations` is the sub-surface Arcade
    // alone runs, so a null here would say Arcade mints nothing to poll, which is false. The
    // bodies are 6.3's. `status` must narrow to `{ status, userId, scopes }` and nothing else: the
    // raw `auth.status` response carries `context.token`, a live provider access token, plus the
    // person's full profile.
    grantsFor: ({ account, toolkit }) =>
      grantsFor(client, account.vendorUserId, toolkit),
    // Read off the listing's own `requirements.authorization.provider_id`, never derived from the
    // toolkit name and never falling back to it. See `authProviderOf` above.
    authProviderOf: (toolkit) => authProviderOf(client, toolkit),
    authorizations: {
      /**
       * Where one minted authorization has got to — THREE FIELDS READ OUT AND THE RESPONSE OBJECT
       * DROPPED HERE, inside the adapter, so nothing outside this file ever holds it.
       *
       * THIS DELIBERATELY INVERTS THIS CODEBASE'S CARRY-THE-VENDOR-ERROR-AS-`cause` CONVENTION.
       * That convention is right everywhere else: a vendor's own words are what a maintainer needs
       * when a call fails. It is wrong here, because `auth.status` answers with `context.token` — a
       * LIVE, WORKING provider access token for the person who just consented — and their full
       * `user_info` profile beside it, while `url` is a bearer capability of its own. A status
       * response LOOKS LIKE METADATA, which is exactly how the throwaway harness that proved this
       * flow came to write the token to a file on its first run.
       *
       * So the protection is the RETURN TYPE and not a comment asking the next person to remember:
       * what is not returned cannot be logged, attached as a `cause`, or written into an audit
       * payload by code that never sees it. Do not widen this, and do not add `url`.
       */
      status: async (id, options) => {
        // THE REFUSAL IS MEDIATED TOO, for the same reason the RESPONSE is: a status this vendor
        // would not answer is answered ABOUT a flow whose body carries the token and the url.
        //
        // AND THE CALLER'S DEADLINE REACHES THE WIRE: an abandoned poll closes its socket rather
        // than leaving this deployment holding one open against a vendor nobody is waiting on.
        //
        // AND THROUGH {@link requireBody}, for `authorize`'s reason: an empty body arrives here
        // as `null` wearing the declared response type, and the three field reads below would
        // raise a bare `TypeError` instead of saying what happened.
        const answer = requireBody(
          "an authorization status read",
          await vendorCall("an authorization status read", () =>
            client.auth.status({ id }, { signal: options?.signal }),
          ),
        );
        const scopes = answer.scopes;
        // THE ONE STATUS READING ({@link vendorStatusOf}): folded and trimmed, and an absent or
        // unreadable status is `"unknown"`, which the return leg refuses as not finished.
        const settled = vendorStatusOf(answer.status);
        return {
          status: settled.kind === "text" ? settled.text : "unknown",
          userId: textOf(answer.user_id) ?? null,
          scopes: Array.isArray(scopes)
            ? scopes.filter((s): s is string => typeof s === "string")
            : [],
        };
      },
      // `handle` is opaque to the seam; `flow_id` is Arcade's word for it and stops in this file.
      // A `user_mismatch` answer is an ANSWER, so it surfaces as `{ mismatch: true }`; any other
      // failure is an outage or a bug and is rethrown as the sentence {@link vendorCall} wrote for
      // it — `user_mismatch` is still read, because the body's `error.name` survives the mediation
      // and `normalizeArcadeError` answers off the carried failure.
      confirmReturn: async ({ handle, vendorUserId }, options) => {
        let answer: { auth_id?: unknown };
        try {
          // THROUGH {@link requireBody}, for `authorize`'s reason. The refusal it writes is
          // raised INSIDE the try, which is deliberate and harmless: `normalizeArcadeError`
          // answers `null` for it, so it is not read as `user_mismatch` and is rethrown as
          // itself by the `throw error` below — an unreadable body is an outage, which is the
          // same judgement the `auth_id` check further down already states.
          answer = requireBody(
            "the return-leg confirmation",
            await vendorCall("the return-leg confirmation", () =>
              client.auth.confirmUser(
                {
                  flow_id: handle,
                  user_id: vendorUserId,
                },
                { signal: options?.signal },
              ),
            ),
          );
        } catch (error) {
          if (normalizeArcadeError(error)?.name === "user_mismatch") {
            return { mismatch: true };
          }
          throw error;
        }
        // THE WHOLE SUBJECT OF THE BINDING, CHECKED HERE AS THE MINT CHECKS ITS OWN — see
        // `authorize` above. `ConfirmUserResponse.auth_id` is DECLARED required by the SDK's types
        // and is VALIDATED by nothing in it, so an answer that omits the field arrives as
        // `undefined` wearing the type `string`, and `{ authorizationId: undefined }` would be a
        // confirmation made against nothing that the seam's own type says is an id.
        //
        // AND IT THROWS RATHER THAN ANSWERING `{ mismatch: true }`, which is the contract routes.ts
        // states at its binding: where the vendor's real shape differs from what was assumed, this
        // does NOT answer a clean refusal — the return leg surfaces an outage, which is honest,
        // because an id that could not be read is not evidence that the handle belongs to somebody
        // else. A refusal reading "not your authorization" would blame the person for an answer
        // their vendor failed to make.
        const authorizationId = answer.auth_id;
        if (typeof authorizationId !== "string" || authorizationId === "") {
          throw new Error(
            "Arcade confirmed a return with no authorization id.",
          );
        }
        return { authorizationId };
      },
    },
  };
  return { actions, broker };
}

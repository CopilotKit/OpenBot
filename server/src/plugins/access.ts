import { toolkitOf as arcadeToolkitOf } from "./arcade";
import { schemeKind } from "./broker";
import type { CatalogueEntry } from "./catalogue";
import { toolkitOf as composioToolkitOf } from "./composio";
import type { TransportKind } from "./transport";

/**
 * How one server row is reached: which protocol, whose credential, which app at a broker, and whose
 * name the trail records.
 *
 * WHY THIS EXISTS AS ONE THING. These three questions were asked separately, in three places, each
 * deriving its own answer from whichever field was nearest. That was complete while every server
 * either had a frozen catalogue entry or was somebody's MCP endpoint. A Composio app is neither: it
 * is a row an operator enabled, with no entry to carry a transport field and no OAuth kind to read,
 * so all three questions answered wrongly by default and each failed silently in its own direction.
 *
 * The fourth question arrived the same way. Which app a brokered row is was read from the row id by
 * the gate that checks whether a person has connected it, from the url by the transport that dials
 * it, and described as a third thing by the schema column that records the connection — with nothing
 * comparing the three, so a row whose id and url slug differed was checked against one app and run
 * against another.
 *
 * Resolved once, here, and read as a field everywhere else. A fourth kind of server cannot be added
 * without filling in this function, and the test beside it enumerates every row shape that exists —
 * which is the exhaustiveness the previous arrangement could not offer, since nothing connects three
 * independent string comparisons.
 *
 * AND THIS IS THE ONE MODULE ALLOWED TO SPELL A BROKER'S NAME, which `brokered-provenance.test.ts`
 * enforces by exempting this file and no other. A second broker turned `row.provenance === "composio"`
 * from a reading of one column into a claim that there is only one broker — a claim each copy of the
 * comparison made separately, in a module that had no reason to be edited when the second one
 * arrived. So the name stops being a comparison anybody can write and becomes {@link BrokerProvider}
 * and {@link brokeredProvenance}, asked here; everywhere else reads the resolved fields below. The
 * exemption is not a privilege, it is the cost of having somewhere for the vocabulary to live.
 */

/** Whose credential a call goes out on. */
export type CredentialSource =
  /** One token the deployment holds, used for everybody. */
  | "deployment-token"
  /** The asking person's own OAuth grant, exchanged per call. */
  | "person-oauth"
  /** One key the deployment holds, with the broker keeping people apart by an id we send. */
  | "brokered"
  /** None at all, because the call never leaves this process. */
  | "none";

export type ServerAccess = {
  transport: TransportKind;
  credential: CredentialSource;
  /**
   * Whose account the call reached, as the audit row names it.
   *
   * `person` is the asking person's id, and it is only correct where the call actually landed
   * somewhere that person alone can see: their own OAuth grant, their own mailbox behind a broker —
   * where the deployment holds the key but the call runs in one person's mailbox, which is the whole
   * point of the connector and therefore the only useful thing the trail can say about it — or this
   * deployment's own tables read as them. `deployment` means the opposite: not any one person's
   * account. That covers a shared token, a server an administrator added by URL, and a public
   * endpoint reached with no credential at all, where every person's call sees the same data and
   * naming the asker would assert an attribution that does not exist.
   */
  reachedAs: "person" | "deployment";
  /**
   * Which app at the broker this row is, and null for a row that is not brokered at all.
   *
   * Read from the URL, because the URL is what the transport dials — so the app a person is checked
   * against is the same app the call runs in, by construction rather than by two spellings agreeing.
   * The row id is a display key: it is what an operator sees and what a grant names, and nothing
   * keeps it equal to the slug in the URL. Deriving the app from it meant a row could pass the "has
   * this person connected this app" gate on one spelling and run against another.
   *
   * Null everywhere else, because there is no app: an MCP endpoint and a per-person OAuth vendor are
   * reached at an address, not at a broker, and a caller that finds null where it needs a toolkit is
   * looking at a row it should not be brokering.
   */
  toolkit: string | null;
};

const CREDENTIAL_BY_AUTH: Record<
  CatalogueEntry["auth"]["kind"],
  CredentialSource
> = {
  none: "none",
  "deployment-bearer": "deployment-token",
  "user-oauth": "person-oauth",
  builtin: "none",
};

/**
 * Whose account each auth kind reaches. Keyed on the auth kind, NOT on the credential source above.
 *
 * `none` and `builtin` collapse to the same credential source — there is no credential either way —
 * and they do not share an answer. A public endpoint touches nobody's account, so the trail says
 * `deployment`, the same thing it says for a server added by URL. The builtin one runs against this
 * deployment's own tables as the person whose turn it is, so the trail says `person`. Deriving this
 * from `CREDENTIAL_BY_AUTH` made the two indistinguishable at exactly the point they differ, and
 * answered `person` for both.
 *
 * A second table rather than a branch, so the compiler forces the question to be answered for any
 * auth kind added later — which is what this module claims above and could not deliver while this
 * field was inferred from something coarser than the thing it depends on.
 */
const REACHED_AS_BY_AUTH: Record<
  CatalogueEntry["auth"]["kind"],
  ServerAccess["reachedAs"]
> = {
  none: "deployment",
  "deployment-bearer": "deployment",
  "user-oauth": "person",
  builtin: "person",
};

/**
 * The shelf both refusals below sit on: this deployment cannot say how to reach a row, and will
 * not guess.
 *
 * CRITERION. Nothing on this shelf is a vendor's doing, a credential's doing, or anything the
 * person asking can act on. An operator gets the sentence, because it names two of our own columns
 * and what to do about them; every other audience — a model's context, a person's browser — gets
 * the fact that the call did not happen, and none of the sentence.
 *
 * REASON. `store.ts` draws exactly this line already, between {@link PluginRefusedError} — a
 * refusal somebody CAN act on, and the one class the codebase relays verbatim — and
 * `PluginInvariantError`, a state this deployment's own code says cannot exist. These two are that
 * second kind, found one step earlier: in resolving the row rather than in querying against it.
 *
 * A BASE CLASS RATHER THAN A LIST AT EACH AUDIENCE. `ServerRowAmbiguousError` shipped with no
 * `catch` anywhere, so the refresh route rethrew it into the default handler — an administrator
 * got a 500 with no body and a page that said "That did not work" — and `grantedTools` copied its
 * message into a model's context, offering an end user's Bot a sentence about correcting a
 * provenance column. A third contradiction added here has to be refused everywhere without a
 * second edit, so the audiences ask one question: `isDeploymentFault` in `store.ts`.
 */
export abstract class ServerUnresolvableError extends Error {}

/**
 * A row that claims to be two servers at once, which makes it neither.
 *
 * CRITERION. A row whose provenance says `composio` and whose id is a curated catalogue slug is
 * refused, not resolved — in either direction.
 *
 * REASON. {@link accessFor} holds two facts and no third: the row, and the entry that row's id
 * looked up. A curated row whose provenance column was edited to `composio` and a genuinely
 * brokered app that happens to be named `notion` arrive here identically, so every answer is right
 * about one of them and wrong about the other. Entry-wins picked the first reading and therefore
 * dialled the second as MCP at the curated vendor's pinned host, spending the deployment's own
 * grant instead of the asking person's brokered connection — the wrong vendor on the wrong
 * credential, recorded in the trail as an ordinary call to a reviewed server.
 *
 * THE SAME COLLISION IS ALREADY REFUSED AT THE OTHER END, at three writes rather than one.
 * `addCustomServer` will not let a row take a curated slug, because the slug prefixes tool names and
 * is what a grant and a policy rule are written against; it will not take the `composio-` namespace
 * `addBrokeredApp` mints into either; and both add paths refuse an id whose row is already brokered,
 * rather than writing a url of their own over the one place the app slug is recorded. `store.ts`'s
 * `requireNotBrokered` is where that last one is argued. `addBrokeredApp` does write `composio` rows
 * — it is how an app is enabled — but never at a curated slug, so a row colliding with an ENTRY
 * still arrives only by hand edit or restore, and only a check at resolution sees one.
 *
 * NOBODY ASKED FOR THIS REFUSAL, so it is not a person's to act on mid-call: it is two of our own
 * columns contradicting each other, the same shelf `PluginInvariantError` sits on. Declared here
 * rather than imported from `store.ts` because this module is a leaf — `store.ts` imports it, and
 * it imports nothing back.
 */
export class ServerRowAmbiguousError extends ServerUnresolvableError {
  constructor(message: string) {
    super(message);
    this.name = "ServerRowAmbiguousError";
  }
}

/**
 * A reviewed entry that names a transport no entry can be reached over.
 *
 * CRITERION. An entry declaring `transport: "composio"` is refused at resolution, and no answer is
 * produced for it.
 *
 * REASON. {@link CuratedTransportKind} already keeps the value out of the catalogue at compile
 * time, which is where it belongs — nothing writes an entry at runtime. This is what stands behind
 * a cast, a JSON fixture in a test, or a future loader that reads entries from somewhere: what the
 * unrefused answer WAS is a Composio dial with `toolkit: null` and a `reachedAs` copied from the
 * entry's auth kind, so both store gates that keep one person's brokered account out of another's
 * were skipped and the trail said the wrong thing about whose account was reached. Fail-closed
 * costs one comparison; the alternative is a hole that opens the first time the type is bypassed.
 */
export class CatalogueTransportUnroutableError extends ServerUnresolvableError {
  constructor(message: string) {
    super(message);
    this.name = "CatalogueTransportUnroutableError";
  }
}

/**
 * Whether a kind is the broker's, asked through a function so the question survives being answered.
 *
 * CRITERION. This comparison must stay live even though {@link CuratedTransportKind} makes it
 * unreachable from the catalogue as the catalogue stands today.
 *
 * REASON. Written inline against `entry.transport`, the compiler narrows the operand to the three
 * curated kinds and rejects the comparison as pointless — correctly, and only while nothing
 * bypasses the type. A cast, a test fixture, or a loader that ever reads entries from outside the
 * build would each produce the state this refuses, and each arrives at runtime where a type says
 * nothing. Widening to {@link TransportKind} at a parameter costs one call and keeps both the
 * compile-time door and the runtime one shut, rather than trading the second for the first.
 */
function isBrokerTransport(kind: TransportKind): boolean {
  return brokeredProvenance(kind);
}

/**
 * Which broker a row is reached through, for a row that is reached through one at all.
 *
 * A NAMED UNION RATHER THAN THE STRING THE COLUMN HOLDS, because the column holds every provenance
 * there is — `first-party`, `custom`, a broker's name — and only these two mean "an app somebody
 * enabled at a broker, reached with the deployment's key and kept apart by an id we send". Code that
 * compared the column to a literal could not say which of those it meant, so the comparison had to be
 * re-derived wherever it was needed, and re-derived wrongly once a second broker existed.
 *
 * THE VALUES ARE THE COLUMN'S OWN SPELLINGS, not a mapping away from them. `brokered_connections.provider`
 * is constrained to exactly `composio` and `arcade`, and `mcp_servers.provenance` writes the same two
 * words, so a translation table here would be a second vocabulary to keep in step with the database's
 * for no gain. What this type adds is that the compiler now knows the set is closed: a third broker is
 * a change to this line, and every `Record<BrokerProvider, …>` below stops compiling until it is
 * answered for.
 */
export type BrokerProvider = Extract<TransportKind, "composio" | "arcade">;

/**
 * Whether a provenance names a broker — the one place that question is asked.
 *
 * CRITERION. No module outside this one compares a provenance or a provider column to a vendor's
 * name. `brokered-provenance.test.ts` is what says so, and this predicate is what that test leaves
 * callers with instead.
 *
 * REASON. The comparison it replaces was correct and complete for as long as there was one broker,
 * and every copy of it became a silent `false` for Arcade rows on the day there were two — not a
 * failure, a row quietly resolving as somebody's MCP endpoint and being dialled as one. A function
 * cannot do that: adding a broker to the union above changes every caller's answer at once, and the
 * ones that must NOT change are then the ones that have to say so explicitly.
 *
 * TAKES A `string`, NOT A `BrokerProvider`, because every caller is holding a database column. A
 * parameter narrowed to the union would push the unsafe cast back out to each call site, which is
 * precisely the thing being collected here. The type predicate is the point: `row.provenance` goes
 * in as a string and comes out narrowed, so the tables keyed on the union below are reachable
 * without an assertion.
 */
export function brokeredProvenance(p: string): p is BrokerProvider {
  return p === "composio" || p === "arcade";
}

/**
 * Which app at which broker, read from the url by the parser belonging to that broker.
 *
 * ONE PARSER PER PROVIDER, AND THEY ARE NOT INTERCHANGEABLE. `composio://gmail` and `arcade://Gmail`
 * are different schemes naming apps under different rules: Composio's slugs are lower case by
 * convention and Arcade's toolkit names are case-sensitive and dotted, so each module's `toolkitOf`
 * answers null for the other's url by design. Dispatching on the provider rather than trying both
 * parsers is what keeps that null meaning "this row's url does not name an app at its own broker" —
 * the thing the brokered gate needs — instead of "no broker recognised it", which would let a row
 * provenanced at one broker resolve against the other's parse of the same string.
 *
 * A `Record` keyed on {@link BrokerProvider} rather than a branch, so a broker added to the union
 * cannot be resolved until the url it is dialled at can be read.
 */
const TOOLKIT_OF: Record<BrokerProvider, (url: string) => string | null> = {
  composio: composioToolkitOf,
  arcade: arcadeToolkitOf,
};

/**
 * What each broker's rows are minted as: the url scheme, the id namespace and the vendor label.
 *
 * ONE ROW PER PROVIDER, KEYED ON {@link BrokerProvider}, so a third broker cannot be enabled until
 * it says how its rows are spelled. The provenance column is the provider's own name and needs no
 * entry here. The id prefix is what prefixes every tool name and what a grant and a policy rule are
 * written against, which is why `store.ts` reserves EVERY provider's and not only the active one's:
 * a deployment that switches broker must not find a typed server already sitting in the namespace
 * the other path mints into. The scheme is reserved the same way one step in — the screen name
 * `/admin/plugins/<provider>` is a static route on each broker — and that reservation is derived
 * from these keys rather than spelled again, because a reservation spelled twice is the one that
 * gets added to once.
 *
 * AND IT LIVES HERE RATHER THAN IN `store.ts`, BESIDE {@link TOOLKIT_OF}, for that table's reason.
 * This module is where a broker's vocabulary is allowed to be spelled, and it is the one file
 * `brokered-provenance.test.ts` exempts. A scheme literal in `store.ts` is a second home for the
 * same word, and the guard that keeps the first home the only one cannot be absolute while the
 * record it reads from sits outside it. `shared-use-store.ts` had to derive its own `${provider}://`
 * for exactly as long as this was private here, which is what two homes costs: one table, one
 * spelling, read by everybody.
 */
export const BROKERED_PROFILE: Record<
  BrokerProvider,
  { scheme: string; idPrefix: string; vendor: string; envVar: string }
> = {
  composio: {
    scheme: "composio://",
    idPrefix: "composio-",
    vendor: "Composio",
    envVar: "COMPOSIO_API_KEY",
  },
  arcade: {
    scheme: "arcade://",
    idPrefix: "arcade-",
    vendor: "Arcade",
    envVar: "ARCADE_API_KEY",
  },
};

/**
 * {@link TOOLKIT_OF}, reachable. A function so a caller cannot index the table with a widened
 * string, and so the table stays private to the one module that argues for it: a second dispatch
 * anywhere else is a second place for a provider to be missed.
 */
export function toolkitOfFor(
  provider: BrokerProvider,
  url: string,
): string | null {
  return TOOLKIT_OF[provider](url);
}

/**
 * A reviewed entry decides for itself; otherwise the row decides — and a row that claims both is
 * refused rather than resolved.
 *
 * THE ENTRY WINS, AND THAT ORDER IS THE SECURITY PROPERTY. A curated slug's behaviour comes from code
 * that was reviewed, so a row whose provenance column says something else — edited by hand, restored
 * from an old backup, written by a bug — cannot turn a reviewed vendor into a brokered one and start
 * sending its calls somewhere else. The row only ever answers where the catalogue is silent.
 *
 * IT CUTS BOTH WAYS, WHICH IS WHY A BROKERED PROVENANCE IS REFUSED RATHER THAN OVERRULED. Only one direction
 * was considered when that order was written: a brokered row whose id collides with a curated slug
 * was quietly answered as the curated vendor. Nothing in these two arguments tells that row apart
 * from a tampered curated one, so the only answer that is not wrong in one of the two worlds is no
 * answer. See {@link ServerRowAmbiguousError}. Every other provenance value still loses to the
 * entry, because none of them proposes a different vendor to reach.
 *
 * MCP stays the fallback, which is still right for a server an administrator added by URL: that is
 * somebody else's MCP endpoint by definition, reached on the one token the deployment holds for it.
 */
export function accessFor(
  row: {
    provenance: string;
    url: string;
    /**
     * What the app's authorization config was created as, which is the only thing on the row that
     * says whether a brokered call lands in an ACCOUNT at all. See the `reachedAs` branch below.
     */
    authScheme: string | null;
    /**
     * Whether the app was switched to Shared, which is the other thing on the row that says a
     * brokered call lands in nobody's account in particular. See the `reachedAs` branch below.
     */
    accountMode?: string | null;
  },
  entry: CatalogueEntry | null,
): ServerAccess {
  if (entry && brokeredProvenance(row.provenance)) {
    throw new ServerRowAmbiguousError(
      `${entry.key} is a server this deployment ships an entry for, and a row with that id says its provenance is ${row.provenance}. Nothing can tell an edited column from a brokered app that took the name, so this row is not resolved at all: rename it, or correct its provenance.`,
    );
  }

  if (entry) {
    if (isBrokerTransport(entry.transport ?? "mcp")) {
      throw new CatalogueTransportUnroutableError(
        `${entry.key} is a catalogue entry declaring the ${entry.transport ?? "mcp"} transport, which is a broker's and is reached from a row's provenance and the app slug in its url — neither of which an entry has. There is no app to broker to and no connection to check, so this entry is not resolved at all: give it the transport it is actually reached over.`,
      );
    }

    return {
      transport: entry.transport ?? "mcp",
      credential: CREDENTIAL_BY_AUTH[entry.auth.kind],
      reachedAs: REACHED_AS_BY_AUTH[entry.auth.kind],
      toolkit: null,
    };
  }

  if (brokeredProvenance(row.provenance)) {
    /*
     * AND A BROKERED APP THAT NEEDS NO CREDENTIAL IS REACHED AS THE DEPLOYMENT, NOT AS THE ASKER.
     *
     * This answered `person` for every brokered row, because the only fields it had were the
     * provenance and the url and neither can tell. A `NO_AUTH` app has no account and no
     * `composio_connections` row: `connectionTokenFor` deliberately lets such a call through with no
     * row at all, and `/servers/:id/connect` refuses to ever create one. So for Hacker News —
     * Composio's own `NO_AUTH` — the audit row wrote `reachedAs: <actorId>` for every person who
     * asked, each one claiming the call ran in that person's own account at the vendor: an account
     * they never connected, cannot disconnect, and which does not exist.
     *
     * That is exactly the case this field's own docblock names as `deployment` — "a public endpoint
     * reached with no credential at all, where every person's call sees the same data and naming the
     * asker would assert an attribution that does not exist" — arriving at the one row kind that
     * could not answer it. The scheme is on the row, so now it can.
     *
     * EVERYTHING ELSE STAYS `person`, AN UNREADABLE SCHEME INCLUDED. A key or consent app IS one
     * person's account, which is the whole point of the connector; a brokered row whose scheme
     * column was never written is far likelier to be one of those than a no-auth app, and `person`
     * is the answer that does not under-attribute a call that really did run in somebody's mailbox.
     *
     * A Shared app is reached as the deployment for the same reason a no-auth app is: whoever
     * asked, the call lands in one account that is nobody's in particular, and naming the asker as
     * the account would assert an attribution that does not exist. The asker is still on the row as
     * `actor`.
     *
     * NEITHER OF THOSE TWO READINGS IS THE BROKER'S, which is why adding a second broker leaves this
     * branch alone. `schemeKind` and `accountMode` are columns on OUR row describing what the app was
     * created as and whether it was switched to Shared, and both answer the same question about an
     * Arcade app that they answer about a Composio one. Only WHICH broker and WHICH app are the
     * provider's business, and those are the two fields below.
     */
    const provider = row.provenance;
    return {
      transport: provider,
      credential: "brokered",
      reachedAs:
        schemeKind(row.authScheme) === "none" || row.accountMode === "shared"
          ? "deployment"
          : "person",
      toolkit: TOOLKIT_OF[provider](row.url),
    };
  }

  return {
    transport: "mcp",
    credential: "deployment-token",
    reachedAs: "deployment",
    toolkit: null,
  };
}

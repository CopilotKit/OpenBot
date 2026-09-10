import type { CatalogueEntry } from "./catalogue";
import { toolkitOf } from "./composio";
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
 * THE SAME COLLISION IS ALREADY REFUSED AT THE OTHER END. `addCustomServer` will not let a row take
 * a curated slug, because the slug prefixes tool names and is what a grant and a policy rule are
 * written against. There is no `addComposioServer` to copy that guard into — nothing in the shipped
 * product writes a `composio` row at all — so a colliding row arrives only by hand edit or restore,
 * and only a check at resolution sees one.
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
  return kind === "composio";
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
 * IT CUTS BOTH WAYS, WHICH IS WHY `composio` IS REFUSED RATHER THAN OVERRULED. Only one direction
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
  row: { provenance: string; url: string },
  entry: CatalogueEntry | null,
): ServerAccess {
  if (entry && row.provenance === "composio") {
    throw new ServerRowAmbiguousError(
      `${entry.key} is a server this deployment ships an entry for, and a row with that id says its provenance is composio. Nothing can tell an edited column from a brokered app that took the name, so this row is not resolved at all: rename it, or correct its provenance.`,
    );
  }

  if (entry) {
    if (isBrokerTransport(entry.transport ?? "mcp")) {
      throw new CatalogueTransportUnroutableError(
        `${entry.key} is a catalogue entry declaring the composio transport, which is reached from a row's provenance and the app slug in its url — neither of which an entry has. There is no app to broker to and no connection to check, so this entry is not resolved at all: give it the transport it is actually reached over.`,
      );
    }

    return {
      transport: entry.transport ?? "mcp",
      credential: CREDENTIAL_BY_AUTH[entry.auth.kind],
      reachedAs: REACHED_AS_BY_AUTH[entry.auth.kind],
      toolkit: null,
    };
  }

  if (row.provenance === "composio") {
    return {
      transport: "composio",
      credential: "brokered",
      reachedAs: "person",
      toolkit: toolkitOf(row.url),
    };
  }

  return {
    transport: "mcp",
    credential: "deployment-token",
    reachedAs: "deployment",
    toolkit: null,
  };
}

import * as builtinRoutines from "./builtin-routines";
import * as composio from "./composio";
import * as driveRest from "./google-drive-rest";
import type { ListedTool, McpCallResult } from "./mcp";
import * as mcp from "./mcp";

/**
 * How this deployment reaches one vendor: which protocol, from the kind `./access` resolved.
 *
 * WHY THIS EXISTS. Every connector used to be MCP, so "the transport" was an import. Google's Drive
 * MCP server turned out to be gated behind a developer preview, and the same product's ordinary REST
 * API is generally available — so one vendor needed a second way in, and a second way in wants a
 * seam rather than a branch at each call site.
 *
 * The interface STARTED as MCP's OWN: `listTools` and `callTool`, the two functions {@link ./mcp}
 * already exported, with the shapes it already used. That direction matters. Had the REST adapter
 * been given its own interface with MCP adapted to fit, MCP would have become a special case of a
 * shape invented for Drive. As it is, MCP is the contract the adapters conform to, which is why
 * swapping Drive back is one field on one catalogue entry and not a refactor.
 *
 * What has been added since is a SUPERSET of that shape rather than a departure from it, so an
 * MCP-shaped implementation still satisfies the seam unchanged. `listTools` answers `ListedTool[]`,
 * which is `McpTool` plus optional fields a broker publishes and an MCP server does not; the
 * connection carries an `actorId` and a `botId` for the transports whose authorization is the
 * actor rather than a credential; and one reserved key on `args` hands a transport the recorded
 * version of the action being called. Every addition is optional, which is why `mcp.ts` reads none
 * of them and is still an implementation of this interface rather than an exception to it.
 *
 * There are exactly two call sites in the whole system — the tool listing and the tool call — and
 * both take a transport from here. Nothing else reads a `TransportKind` at all: the OAuth flow,
 * the grants, the policy engine and the audit trail are written without one. Whose credential a
 * row goes out on is a SEPARATE axis — `./access`'s `CredentialSource` — and that one is NOT
 * protocol-blind, since the brokered branch of the credential selection looks a person's
 * connection up in `composio_connections` by name. Read the blindness as a claim about this union
 * and not about the store.
 */
export type VendorTransport = {
  /**
   * Whether discovering the tool list needs somebody's credential.
   *
   * True for MCP, where the list is an answer from a remote server that will not give it up
   * unauthenticated. False whenever no credential has to be SELECTED for the listing: either
   * because the list is this code, as it is for Drive and Routines, or because the transport
   * already holds the one key it lists on and never receives it through the connection, as
   * Composio does — a broker publishes an action's schema to anybody who asks with the
   * deployment's own key.
   *
   * It is on the transport rather than assumed by the caller because getting it wrong is a whole
   * broken setup flow. Assumed true, an administrator configuring Drive was sent to their own
   * settings page to connect a personal account, purely so a token could be minted, passed to a
   * function that ignores it, and discarded — then sent back to press refresh. Nothing about that
   * sequence hinted that the middle step was doing no work.
   */
  listNeedsCredential: boolean;
  listTools(connection: {
    url: string;
    token?: string;
    /**
     * Declared by the shared connection shape, and never supplied on THIS path.
     *
     * `refreshTools` is the only caller of `listTools` in the system, and it passes `{url, token}`.
     * No implementation here even accepts either field: `builtin-routines` takes no argument at
     * all, Composio takes only `url`, and MCP and Drive take `{url, token}`. So a transport that
     * read one would read `undefined` every time, and nothing on the listing path may be
     * authorized by them.
     *
     * The actor is the authorization on the CALLING path instead — see {@link callTool} below,
     * where Routines and Composio each refuse a run attributed to nobody. Listing is not
     * somebody's: it is what this deployment offers everybody. A list that insisted on an actor
     * would be asked without one, store zero tools, and leave the vendor advertising nothing to
     * anybody.
     */
    actorId?: string;
    botId?: string;
  }): Promise<ListedTool[]>;
  callTool(
    connection: {
      url: string;
      token?: string;
      /**
       * Who this call is for, and which Bot is making it.
       *
       * Ignored where a CREDENTIAL is the authorization: MCP and Drive answer to a token, and whose
       * it is was settled before the connection was built, so neither module's `Connection` type
       * carries these at all. Read where the ACTOR is the authorization: Routines acts on this
       * deployment's own tables, and Composio opens one person's account with a key the deployment
       * holds for everybody, so both refuse a run attributed to nobody rather than run it as
       * somebody. A routine is somebody's; so is a mailbox.
       *
       * They come off the connection, which the call path derives from the session, and are never
       * read out of `args`. A model that could name either could schedule work as another person or
       * read another person's mail.
       */
      actorId?: string;
      /** The Bot the run belongs to. A routine runs as its Bot, which is never a name a model supplies. */
      botId?: string;
    },
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult>;
};

/**
 * The protocols this deployment can dial.
 *
 * A closed union rather than a string, so adding one is a change to this file and to the registry
 * below together. Named by a catalogue entry for a curated vendor and by `./access` from the row's
 * provenance for a Composio app; either way, a kind that does not exist should not typecheck.
 */
export type TransportKind =
  | "mcp"
  | "google-drive-rest"
  | "builtin-routines"
  | "composio";

/**
 * The kinds a CATALOGUE ENTRY may name, which is every one except the broker's.
 *
 * CRITERION. `composio` is not writable in a reviewed entry, and the compiler is what says so.
 *
 * REASON. A brokered row is reached by an app slug read off its url and a per-person connection
 * looked up by that slug; a catalogue entry has neither, and `accessFor` answers `toolkit: null`
 * and `credential` from the entry's auth kind for everything it resolves. So an entry declaring
 * `transport: "composio"` yielded a Composio dial with no app named, no brokered gate, and
 * `reachedAs` taken from an auth kind that has nothing to do with whose account the broker would
 * have run in — a row that walks past both store gates while satisfying every type in the module
 * that claims to enumerate how a row can be reached. No entry declares it, which is why this is a
 * door being shut rather than a bug being fixed, and why shutting it costs nothing.
 *
 * `Exclude` rather than a hand-written second union, so a kind added above is offered to the
 * catalogue automatically and only the broker stays out.
 */
export type CuratedTransportKind = Exclude<TransportKind, "composio">;

const TRANSPORTS: Record<TransportKind, VendorTransport> = {
  mcp,
  "google-drive-rest": driveRest,
  "builtin-routines": builtinRoutines,
  composio,
};

/**
 * The transport for a resolved kind.
 *
 * A kind rather than a catalogue entry, because deciding the kind is no longer this file's business.
 * It used to read `entry?.transport ?? "mcp"`, which was complete while every server either had an
 * entry or was somebody's MCP endpoint — and silently wrong for a Composio app, which has no entry
 * and would have had `composio://gmail` dialled as an HTTP server. `./access` decides now, once, for
 * every row shape; this is the lookup that follows.
 */
export function transportFor(kind: TransportKind): VendorTransport {
  return TRANSPORTS[kind];
}

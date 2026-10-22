/**
 * The Arcade transport's vendor-free half. Imports no vendor package and nothing from
 * `arcade-adapter.ts`: the adapter imports this module, never the reverse (see `./broker`, which
 * records that the other direction is a cycle).
 */

import { cutAtCodeUnits } from "../channels/text";
import { flagOf } from "./broker";
import { type ListedTool, MAX_RESULT_CHARS, type McpCallResult } from "./mcp";

/**
 * Whether listing tools needs somebody's credential. It does not: the listing uses the deployment's
 * own Arcade key, and a listing is not a person's.
 */
export const listNeedsCredential = false;

const TOOLKIT_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Which toolkit this connection is about, from `arcade://Toolkit`.
 *
 * CASE IS PRESERVED AND NOTHING IS NORMALIZED. Arcade's toolkit and action names are case-sensitive,
 * and action names are dotted (`Apollo.EnrichOrganization`: the dot separates toolkit from action,
 * so a toolkit name never contains one and `TOOLKIT_NAME` rightly rejects it), where Composio's
 * slugs are neither, so a lowercased toolkit reaches nothing:
 * `arcade://Gmail` and `arcade://gmail` are distinct apps.
 *
 * ONE TOOLKIT OR NOTHING. This answer is the name the brokered gate looks a person's row up by, so a
 * url read loosely is one app's connection satisfying a call against another.
 * `arcade://Gmail/messages` must not answer `"Gmail/messages"`: a path segment is not an app.
 *
 * TRIMMED BEFORE THE SLASHES COME OFF, as `composio.ts` does: the other order leaves a space as the
 * last character, so the slash is not at the end and nothing matches.
 */
export function toolkitOf(url: string): string | null {
  const prefix = "arcade://";
  if (!url.startsWith(prefix)) return null;
  const name = url.slice(prefix.length).trim().replace(/\/+$/, "");
  return TOOLKIT_NAME.test(name) ? name : null;
}

/**
 * What a tool does, from `metadata.behavior`. DESTRUCTIVE IS READ FIRST, and the order is the
 * decision: a reading that checked `read_only` first would record a both-flagged tool as a READ,
 * the one direction nothing downstream recovers from, since nothing ever asks again.
 *
 * ABSENT METADATA, OR A FLAG THAT `flagOf` ANSWERS NULL (a vendor publishing a string where it
 * documents a boolean), IS A DESTRUCTIVE WRITE, which is also what a listing that would not say
 * already records in `./mcp`. It fails safe by putting an approval in front of a read, which is
 * annoying and correct; the alternative lets a deletion through unannounced.
 *
 * AN EMPTY BEHAVIOUR OBJECT IS A VENDOR THAT SAID NOTHING, AND IS READ EXACTLY AS AN ABSENT ONE.
 * `{}` — or a block carrying only `idempotent` and the like — states NEITHER flag, so the two
 * `flagOf(…, false)` defaults below would otherwise manufacture "not destructive, not read-only"
 * out of nothing and answer the plain-write verdict: a container Arcade opened and put nothing in,
 * read as Arcade declaring the action safe to run unannounced. The absence of a stated restriction
 * is not the absence of a restriction, and an EMPTY container cannot be allowed to be worth more
 * than NO container two lines above it.
 *
 * NOT THE SAME CALL AS `arcade-adapter.ts`'s `connectionIsLive`, WHERE SILENCE IS DELIBERATELY
 * PERMISSIVE AND SAYS SO AT LENGTH. There
 * the silent field is `connection_status`, optional on the wire, and a pessimistic reading
 * un-connects every real connection against any engine that omits it — the cost of failing closed
 * falls on people who did nothing wrong. Here the cost of failing closed is one approval prompt in
 * front of an action that may turn out to be a read; the cost of failing open is a deletion that
 * nobody was asked about. The flags' per-field defaults stand once EITHER flag is stated, which is
 * the vendor describing this action rather than saying nothing at all.
 */
export function classify(metadata: unknown): {
  effect: "read" | "write";
  destructive: boolean;
} {
  const closed = { effect: "write", destructive: true } as const;
  if (typeof metadata !== "object" || metadata === null) return closed;
  const behavior = (metadata as { behavior?: unknown }).behavior;
  if (typeof behavior !== "object" || behavior === null) return closed;
  const flags = behavior as { destructive?: unknown; read_only?: unknown };
  const stated = (value: unknown) => value !== undefined && value !== null;
  if (!stated(flags.destructive) && !stated(flags.read_only)) return closed;
  const destructive = flagOf(flags.destructive, false);
  const readOnly = flagOf(flags.read_only, false);
  if (destructive === null || readOnly === null) return closed;
  if (destructive) return { effect: "write", destructive: true };
  if (readOnly) return { effect: "read", destructive: false };
  return { effect: "write", destructive: false };
}

/**
 * What this transport needs of Arcade's client, and nothing more: `./arcade-adapter` maps the
 * vendor's SDK onto it, so this file imports no vendor package. Mirrors `ComposioActions`.
 *
 * `listTools` carries no `user_id` by construction: the query type has no such field.
 */
export type ArcadeActions = {
  listTools(q: {
    toolkit: string;
    limit: number;
    offset: number;
  }): Promise<{ items: unknown[]; total_count?: number }>;
  execute(r: {
    tool_name: string;
    input: Record<string, unknown>;
    user_id: string;
  }): Promise<{
    success?: boolean;
    output?: {
      value?: unknown;
      error?: { message?: string };
      authorization?: unknown;
    };
  }>;
};

let installed: ArcadeActions | null = null;

/** Installs (or, with `null`, removes) the Arcade client. Null is also the unconfigured state. */
export function useArcadeClient(client: ArcadeActions | null): void {
  installed = client;
}

export type ArcadeListedTool = ListedTool & { scopes: string[] };

const PAGE_SIZE = 100;
/** A runaway guard, not a bound: 1000 pages of 100 is far past any one toolkit. */
const MAX_PAGES = 1000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * WHAT ARRIVED WHERE A SHAPE BELONGED, named without quoting it.
 *
 * A listing row carries whatever the vendor chose to put on it, and a refusal from here is read off
 * an admin page, so the SHAPE is the part that is both safe to say and the part that helps —
 * `sent` in `composio-adapter.ts` says this at length and this is the same judgement, kept local
 * because that file is the other vendor's door and neither imports the other.
 */
export function shapeOf(value: unknown): string {
  if (Array.isArray(value)) return "a list";
  // `typeof null` IS `"object"`, so the bare template would write "a object" — the wrong grammar
  // and, worse, the wrong fact: a hole is not a shape this deployment read and could not use, it
  // is the absence of one. The callers that pass a present-but-unreadable field guard both of
  // these before asking; `connectionsFor`'s unreadable ROW is the one that can carry a `null`.
  if (value === null || value === undefined) return "nothing";
  if (typeof value === "string" && value.trim() === "") return "a blank string";
  return `a ${typeof value}`;
}

/*
 * ---------------------------------------------------------------------------------------------
 * THE ONE READING OF A VENDOR AUTHORIZATION FIELD — absent, unreadable, or read.
 *
 * Every Arcade field this deployment draws an AUTHORIZATION conclusion from is read through one of
 * the three functions below, and all three apply the same rule, stated once here:
 *
 *   ABSENT — the key missing, `undefined`, or `null` — is the vendor saying nothing, and answers the
 *   field's documented default. `null` IS ABSENCE ON EVERY FIELD, NOT ON SOME: the SDK declares
 *   these fields optional, Arcade sends `metadata: null` and `requirements: null` for "none"
 *   (`AirtableApi`, `Apollo` in `fixtures/arcade-catalogue.json`), and a serializer that writes an
 *   unset optional as `null` rather than dropping the key is saying what a missing key says. A rule
 *   under which `null` meant "absent" on one field and "a value I cannot read" on the next would
 *   make the same vendor answer mean opposite things one line apart.
 *
 *   UNREADABLE — present, but not the field's shape — is NEITHER default. Each caller decides what
 *   an unreadable field costs it, and every caller fails CLOSED: the catalogue and the transport
 *   listing refuse, the grants screen says `unknown`, a connection is not live, a mint is refused.
 *   A BLANK STRING IS UNREADABLE on a field whose value is a decision. It is present (so it is not
 *   absence) and carries no value (so it is not text); `authProvidersNamedBy` already refuses a
 *   blank `provider_id` for exactly this reason. `textOf` in `arcade-adapter.ts` reads a blank
 *   LABEL as absence, which is right for a display name and is not the question asked here.
 *
 *   READ — the value in this deployment's vocabulary: a status FOLDED AND TRIMMED (a case or a
 *   space the vendor changes must not change an answer about somebody's account), a scope list
 *   whose every element is a scope.
 *
 * WHY ONE READING. `authorizationRequirementOf` (C2) answered this tri-state for the authorization
 * block, and every OTHER reader of a field inside or beside it picked its own default for what it
 * could not read — the permissive one, each time: a missing `token_status` fell back to the
 * PROVIDER's `status: "active"` and drew every action as held; an unreadable `oauth2`/`scopes`
 * became `[]`, which the gate reads as "the connection itself is the grant"; a non-text
 * `connection_status` read as live; a non-text mint `status` handed a bearer url on as a live
 * redirect. One reading means a new reader cannot pick a sixth default by accident.
 * ---------------------------------------------------------------------------------------------
 */

/**
 * What one listed action's `requirements.authorization` SAYS, read once for every caller that asks.
 *
 * THE ONE READING OF THIS FIELD'S ABSENCE. Two readers once reached opposite answers on the same
 * row: `requiresAuthorization` read a missing block as "needs nothing" and filed the app as
 * `no-auth`, while `grantStateOf` read the same silence as "could not be read" and drew every
 * action of that app as a broker outage on the grants screen, forever. The vendor's own listing
 * settles which is right — `Apollo` publishes NO authorization block and a deployment secret
 * instead, verbatim in `fixtures/arcade-catalogue.json` — so `null` and an absent field are
 * `none`, here and therefore everywhere.
 *
 * A PRESENT FIELD THIS DEPLOYMENT CANNOT READ IS NEITHER ANSWER. It is `unreadable`, with WHICH
 * field and the shape that arrived there, and each caller decides what an unreadable row costs it:
 * the catalogue refuses, the grants screen says `unknown`.
 *
 * HERE, IN THE TRANSPORT, AND NOT IN THE ADAPTER, because the transport's own listing reads the same
 * block for the scopes the gate checks, and the adapter imports this module, never the reverse.
 */
export type AuthorizationRequirement =
  | { kind: "none" }
  | {
      kind: "unreadable";
      field: "requirements" | "authorization";
      shape: string;
    }
  | { kind: "required"; authorization: Record<string, unknown> };

export function authorizationRequirementOf(
  item: unknown,
): AuthorizationRequirement {
  const requirements = record(item)?.requirements;
  if (requirements === undefined || requirements === null) {
    return { kind: "none" };
  }
  if (typeof requirements !== "object" || Array.isArray(requirements)) {
    return {
      kind: "unreadable",
      field: "requirements",
      shape: shapeOf(requirements),
    };
  }
  const authorization = (requirements as Record<string, unknown>).authorization;
  if (authorization === undefined || authorization === null) {
    return { kind: "none" };
  }
  if (typeof authorization !== "object" || Array.isArray(authorization)) {
    return {
      kind: "unreadable",
      field: "authorization",
      shape: shapeOf(authorization),
    };
  }
  return {
    kind: "required",
    authorization: authorization as Record<string, unknown>,
  };
}

/**
 * The OAuth scopes one listed action asks for — `requirements.authorization.oauth2.scopes` — read
 * by {@link authorizationRequirementOf}'s rule, one level further in.
 *
 * `[]` IS A CLAIM, NOT A SHRUG. An action whose scopes are `[]` is one whose connection IS the
 * grant (Github's 43 actions publish exactly that), and the gate, the catalogue's counts and the
 * grants screen all read it so. So `[]` is answered only when the vendor SAID it: no authorization
 * block, an `oauth2` absent or `{}`, a `scopes` absent or `[]`. An `oauth2` or a `scopes` in any
 * other shape is `unreadable`, and so is a list holding anything but scope text: `["repo", 5]`
 * read as `["repo"]` would be a narrower grant than the one the vendor described, which is the same
 * fail-open answer one element at a time.
 */
export type ScopesRequirement =
  | { kind: "read"; scopes: string[] }
  | {
      kind: "unreadable";
      field: "requirements" | "authorization" | "oauth2" | "scopes";
      shape: string;
    };

export function requiredScopesOf(item: unknown): ScopesRequirement {
  const read = authorizationRequirementOf(item);
  if (read.kind === "none") return { kind: "read", scopes: [] };
  if (read.kind === "unreadable") return read;
  const oauth2 = read.authorization.oauth2;
  if (oauth2 === undefined || oauth2 === null) {
    return { kind: "read", scopes: [] };
  }
  if (typeof oauth2 !== "object" || Array.isArray(oauth2)) {
    return { kind: "unreadable", field: "oauth2", shape: shapeOf(oauth2) };
  }
  const scopes = (oauth2 as Record<string, unknown>).scopes;
  if (scopes === undefined || scopes === null) {
    return { kind: "read", scopes: [] };
  }
  if (!Array.isArray(scopes)) {
    return { kind: "unreadable", field: "scopes", shape: shapeOf(scopes) };
  }
  const odd = scopes.findIndex(
    (scope) => typeof scope !== "string" || scope.trim() === "",
  );
  if (odd !== -1) {
    return {
      kind: "unreadable",
      field: "scopes",
      shape: `a list holding ${shapeOf(scopes[odd])}`,
    };
  }
  return { kind: "read", scopes: scopes as string[] };
}

/**
 * One vendor STATUS field — `token_status`, `connection_status`, a mint's or a flow's `status` —
 * read by the rule above: absent, unreadable, or its text FOLDED AND TRIMMED.
 *
 * NOT `textOf`, deliberately: `textOf` answers a blank string as absence, which is right for a
 * label and wrong for a decision, and it does not fold. Each status reader once spelled its own
 * `textOf(x)?.trim().toLowerCase()` (or forgot to), and the one that forgot answered a vendor-side
 * change of case differently from the ones that did.
 */
export type VendorStatus =
  | { kind: "absent" }
  | { kind: "unreadable"; shape: string }
  | { kind: "text"; text: string };

export function vendorStatusOf(value: unknown): VendorStatus {
  if (value === undefined || value === null) return { kind: "absent" };
  if (typeof value !== "string" || value.trim() === "") {
    return { kind: "unreadable", shape: shapeOf(value) };
  }
  return { kind: "text", text: value.trim().toLowerCase() };
}

/** Where on the action a {@link ScopesRequirement} could not be read, in words. */
function scopesFieldOf(
  field: Extract<ScopesRequirement, { kind: "unreadable" }>["field"],
): string {
  return field === "requirements"
    ? "requirements"
    : field === "authorization"
      ? "authorization requirement"
      : `authorization ${field}`;
}

/**
 * The OAuth scopes an action needs, for the tool the gate checks.
 *
 * NEVER `requirements.met`. The two sit in the same object and behave oppositely: `met` is a
 * per-person claim that answers TRUE FOR EVERYBODY when asked without a `user_id` (and this
 * listing sends none), while `scopes` is a static property of the action that carries no identity.
 * Reading `met` here would record every person as connected to everything, and nothing else would
 * go red: the gate would pass, the call would be made, and the first sign would be somebody
 * else's mailbox.
 *
 * AN UNREADABLE SCOPES BLOCK REFUSES THE LISTING; IT IS NEVER `[]`. `[]` on a listed tool is what
 * the gate reads as "the connection is the grant", so answering it for a block this deployment
 * could not read would let any connection run an action whose real scopes nobody read. See
 * {@link requiredScopesOf}. The refusal names the shape, never the vendor's value.
 */
function scopesOf(tool: Record<string, unknown>, toolkit: string): string[] {
  const read = requiredScopesOf(tool);
  if (read.kind === "read") return read.scopes;
  throw new Error(
    `Arcade listed one of ${toolkit}'s actions with ${read.shape} where its ${scopesFieldOf(read.field)} belongs, and that is what says which permissions it needs. A shape this deployment cannot read is not "no permissions", so nothing was refreshed and the actions already recorded for this app are kept.`,
  );
}

function inputSchemaOf(input: unknown): Record<string, unknown> {
  const parameters = record(input)?.parameters;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const raw of Array.isArray(parameters) ? parameters : []) {
    const parameter = record(raw);
    if (!parameter || typeof parameter.name !== "string") continue;
    const valType = record(parameter.value_schema)?.val_type;
    properties[parameter.name] = {
      type: valType === "json" ? "object" : (valType ?? "string"),
      description:
        typeof parameter.description === "string" ? parameter.description : "",
    };
    if (parameter.required === true) required.push(parameter.name);
  }
  return { type: "object", properties, required };
}

/**
 * Every action of one toolkit, read to the end.
 *
 * NO `user_id` IS SENT. A listing is not somebody's: it is what this deployment offers everybody.
 *
 * PAGINATION STOPS ON A SHORT PAGE, never on `total_count`. That field is optional; an earlier draft
 * fell back to `?? tools.length` and so exited after one page. It is used only as a cross-check.
 */
export async function listTools(connection: {
  url: string;
}): Promise<ArcadeListedTool[]> {
  const toolkit = toolkitOf(connection.url);
  if (!toolkit) {
    throw new Error(
      `${connection.url} does not name an Arcade toolkit, so nothing was asked what it offers. The url has to be arcade:// followed by a toolkit name; correct it on the Plugins page.`,
    );
  }
  if (!installed) {
    throw new Error(
      `Arcade is not configured for this deployment, so nothing could be asked what ${toolkit} offers. The actions already recorded for this app are kept rather than cleared.`,
    );
  }

  const raw: unknown[] = [];
  let total: number | undefined;
  let exhausted = true;
  for (let page = 0; page < MAX_PAGES; page++) {
    let answer: { items: unknown[]; total_count?: number };
    try {
      answer = await installed.listTools({
        toolkit,
        limit: PAGE_SIZE,
        offset: raw.length,
      });
    } catch (error) {
      /*
       * A SENTENCE, NOT THE VENDOR'S OBJECT, as `composio.ts`'s listing does. `refreshTools` puts
       * `error.message` on the admin page and into a model's context, and an SDK `APIError` builds
       * its message from the whole response body: an unsanitised vendor payload. The original is
       * kept as `cause` for a log.
       */
      throw new Error(listingSentence(toolkit, error), { cause: error });
    }
    const items = (answer as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) {
      throw new Error(
        `Arcade did not answer with an action list for ${toolkit}. Nothing was refreshed and the actions already recorded for this app are kept.`,
      );
    }
    raw.push(...items);
    // THE HIGHEST ANY PAGE REPORTED, NEVER THE LAST. An engine that truncates at 250 of 300 drops
    // `total_count` from its short final page, and keeping the last value would erase the 300 page
    // one reported and commit 250 actions as a complete listing. (`total_count` reaching here is
    // already honest about absence: `createArcadeClient` omits the field when the vendor omitted
    // it, because the SDK's page object coerces an absent total to `0`.)
    if (typeof answer.total_count === "number") {
      total =
        total === undefined
          ? answer.total_count
          : Math.max(total, answer.total_count);
    }
    if (items.length < PAGE_SIZE) {
      exhausted = false;
      break;
    }
  }
  if (exhausted) {
    throw new Error(
      `Arcade's listing for ${toolkit} never ended after ${MAX_PAGES} pages, so it is not trusted to be a list of this app's actions. Nothing was refreshed and the actions already recorded for this app are kept.`,
    );
  }
  if (total !== undefined && raw.length < total) {
    throw new Error(
      `Arcade listed ${raw.length} of ${total} actions for ${toolkit}, so the listing is incomplete. Nothing was refreshed and the actions already recorded for this app are kept.`,
    );
  }

  return raw.flatMap((item) => {
    const tool = record(item);
    if (!tool || typeof tool.qualified_name !== "string") return [];
    const offerable = offerableName(tool.qualified_name, toolkit);
    if (offerable === null) return [];
    return [
      {
        name: offerable,
        /*
         * WHAT THE VENDOR IS CALLED BY, kept beside the name this deployment records rather than in
         * place of it. `execute` sends this and the refusal sentences in this file quote it; the
         * model is offered `name`. See {@link ListedTool.vendorName}.
         */
        vendorName: tool.qualified_name,
        description:
          typeof tool.description === "string" ? tool.description : "",
        inputSchema: inputSchemaOf(tool.input),
        ...classify(tool.metadata),
        scopes: scopesOf(tool, toolkit),
      },
    ];
  });
}

/**
 * The part of an Arcade `qualified_name` this deployment records as the action's name, or null when
 * the listing offers nothing that can be one.
 *
 * ARCADE QUALIFIES EVERY ACTION WITH ITS TOOLKIT — `Gmail.ListEmails` — and the toolkit is already
 * the server id, so carrying the prefix would spell the app twice in every ref and every offered
 * name. More to the point the dot is ILLEGAL in a model tool name (`^[a-zA-Z0-9_-]+$`), which is
 * the defect this function exists to close: recorded whole, the qualified name went into
 * `mcp__arcade-Gmail__Gmail.ListEmails` and the model API refused the entire request, every tool in
 * it, on the first granted Arcade action.
 *
 * ONLY THE VENDOR'S OWN PREFIX IS REMOVED, and only when the remainder stands on its own. Anything
 * else — a differently-qualified name, a second dot, a character no tool name may carry — is left
 * for the guard in `storableTools`, which leaves that one action out and names it on the app's page
 * while the rest of the toolkit is recorded, because a listing this does not recognise is not
 * something to repair by guessing. That guard is the safety net this function relies on: whatever
 * passes through here unrepaired never reaches a model. Dropped here rather than skipped there for
 * the one case the vendor's own schema permits and this deployment can do nothing with: an empty
 * remainder.
 */
function offerableName(qualifiedName: string, toolkit: string): string | null {
  const prefix = `${toolkit}.`;
  const bare = qualifiedName.toLowerCase().startsWith(prefix.toLowerCase())
    ? qualifiedName.slice(prefix.length)
    : qualifiedName;
  return bare.trim().length === 0 ? null : bare;
}

/** What this deployment says when Arcade's listing could not be read. Never the vendor's words. */
function listingSentence(toolkit: string, _error: unknown): string {
  return `Arcade's action list for ${toolkit} could not be read, so nothing was refreshed and the actions already recorded for this app are kept.`;
}

/**
 * A failure from Arcade, already normalized and cause-unwrapped by `./arcade-adapter`, so nothing
 * here sees an SDK class. `name` is the RESPONSE BODY's `error.name`.
 */
export type ArcadeFailure = {
  status: number | undefined;
  name: string | undefined;
  message: string | undefined;
};

/**
 * A REFUSAL FROM ARCADE AS A REAL `Error`, CARRYING THIS DEPLOYMENT'S SENTENCE AND NOT THE VENDOR'S.
 *
 * TWO DEFECTS IN ONE CLASS, and both were measured rather than imagined.
 *
 * A BARE OBJECT IS NOT A REASON. `createArcadeClient`'s `execute` used to `throw` the normalized
 * failure itself — a plain `{ status, name, message }`. `reasonWithoutStatement`, which is the one
 * door every log line in `routes.ts` copies a reason through, answers `String(thrown)` for anything
 * that is not an `Error`: the literal text `[object Object]`. So the single log line written at the
 * moment a tool call failed carried no information whatsoever, and there was no stack beside it.
 *
 * AND THE VENDOR'S WORDS ARE DROPPED HERE, which is the half the type enforces. The SDK's `APIError`
 * builds its own `message` as `${status} ${body.message ?? JSON.stringify(body)}`
 * (`@arcadeai/arcadejs`, `core/error.js: makeMessage`), so an `APIError` allowed to escape the
 * adapter puts the vendor's RESPONSE BODY into every reader that quotes a message — an admin page,
 * a log line, a model's context, an audit row. On this vendor that body is not inert: the auth
 * paths answer with an `authorization` whose `url` is a bearer capability and whose `context.token`
 * is a live provider access token, and the adapter's `authorizations.status` already inverts this
 * codebase's carry-the-vendor-error-as-`cause` convention for exactly that reason. This is the same
 * refusal one layer out: the constructor keeps `status` and the body's `error.name` — the two
 * MACHINE fields this deployment keys decisions on, in {@link isAuthorizationRequired} and in the
 * route that decides whether a failed mint is definite — and drops the vendor's PROSE on the floor.
 * Nothing that is not stored cannot be logged.
 *
 * `status` IS ALSO A TOP-LEVEL FIELD, because that is what an `APIError` presents and callers that
 * read it off the thrown value go on working across this change.
 */
export class ArcadeFailureError extends Error {
  readonly status: number | undefined;
  readonly failure: ArcadeFailure;
  constructor(sentence: string, failure: ArcadeFailure) {
    super(sentence);
    this.name = "ArcadeFailureError";
    this.status = failure.status;
    // THE ONE DOOR THE VENDOR'S PROSE DOES NOT COME THROUGH. Written here rather than at each
    // construction site so that a later caller cannot pass it on by forgetting to.
    this.failure = {
      status: failure.status,
      name: failure.name,
      message: undefined,
    };
  }
}

/**
 * KEYED ON THE BODY'S NAME, NEVER ON THE 403. A 403 is also what a revoked key, a disabled project
 * and a rate limit look like; keyed on the status, this would tell somebody to authorize an action
 * when the deployment's key is what is wrong.
 */
export function isAuthorizationRequired(failure: ArcadeFailure): boolean {
  return failure.name === "tool_authorization_required";
}

/**
 * The thrown value, READ AS A SHAPE rather than cast into one. `record` is a plain-object coercion
 * that normalizes nothing and walks no `cause`, so a cast through it would let any object at all
 * stand in for a normalized failure. Only a `name` string is required, since that is the one field
 * `isAuthorizationRequired` keys on; the rest are read as-is or left undefined.
 *
 * {@link ArcadeFailureError} IS ASKED FIRST AND BY TYPE, because the shape reading cannot see it:
 * an `Error`'s `name` is its CLASS name through the prototype chain, so a duck-typed read of one
 * answers `"ArcadeFailureError"` for every refusal and the authorize prompt below would be
 * unreachable — which is the same trap the adapter's own comment records for a raw `APIError`.
 */
function arcadeFailure(thrown: unknown): ArcadeFailure | null {
  if (thrown instanceof ArcadeFailureError) return thrown.failure;
  const raw = record(thrown);
  if (!raw || typeof raw.name !== "string") return null;
  return {
    status: typeof raw.status === "number" ? raw.status : undefined,
    name: raw.name,
    message: typeof raw.message === "string" ? raw.message : undefined,
  };
}

/**
 * The cap every string this module puts in front of a model goes through, as `composio.ts`'s
 * `cap()` does, with the same limit and the same marker.
 *
 * A tool result is read by a model AND copied into the audit row, so an unbounded one is somebody
 * else's server deciding how much of our context window to spend and how large a durable record
 * grows — and the text is attacker-influenceable, since it is whatever the mailbox, issue or
 * document the action read happens to contain. Truncated visibly, never silently: `truncated` is
 * the field that says it happened, and reporting `false` unconditionally made it a field that
 * structurally could not.
 *
 * BOTH ANSWERS GO THROUGH IT. A refusal lands in a model's context exactly as a result does, and
 * this file's refusals quote `toolName`, which is a `qualified_name` the vendor's listing supplied.
 */
function cap(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_RESULT_CHARS) return { text, truncated: false };
  return {
    text: `${cutAtCodeUnits(text, MAX_RESULT_CHARS)}\n\n[truncated]`,
    truncated: true,
  };
}

const failureResult = (text: string): McpCallResult => ({
  ...cap(text),
  isError: true,
});

/**
 * Call one Arcade action as the connection's actor.
 *
 * THE ACTION IN THE REFUSAL COMES FROM THE CALL SITE, never from the error: `APIError` in
 * `@arcadeai/arcadejs@2.4.1` carries `status`, `headers` and `error` and nothing naming the tool.
 *
 * NO URL IS EVER IN THE SENTENCE, ON ANY PATH. The `authorization.url` is a bearer capability:
 * whoever opens it attaches an account to the identity the flow was minted for. It is never
 * returned to a model, logged, put in an error body or written to an audit row. The refusal names
 * the Settings page, where the link is minted by an authenticated request whose actor is known.
 *
 * THE SUCCESS PATH IS COVERED BY THAT SAME PROMISE, and this is where it is easiest to break. A 200
 * is not a safe envelope: `ExecuteToolResponse.output.authorization` is the SAME
 * `AuthorizationResponse` the 403 carries, with the url and a `context.token` that is a LIVE OAUTH
 * ACCESS TOKEN for the end user's account. `output.value` IS THE ONLY PART OF THE ENVELOPE THAT MAY
 * CROSS INTO `text`; the envelope is never stringified whole, because `text` is returned to a model
 * and copied into the audit row. An answer carrying an `authorization` at all is the refusal, not a
 * result: it means the call was not run as an authorized actor.
 *
 * NOTHING THE VENDOR SAID IS REPEATED either: the ordinary failure is this deployment's sentence,
 * and `output.error` is read only as a BOOLEAN — its `message`, `developer_message` and
 * `stacktrace` are the vendor's words and stay out of `text`.
 */
export async function callTool(
  connection: { url: string; actorId?: string },
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  if (!installed) {
    return failureResult(
      `Arcade is not configured for this deployment, so ${toolName} was not run.`,
    );
  }
  if (!connection.actorId) {
    return failureResult(
      `${toolName} was not run: no account was named to run it as.`,
    );
  }
  try {
    const answer = await installed.execute({
      tool_name: toolName,
      input: args,
      user_id: connection.actorId,
    });
    if (answer.output?.authorization) {
      return failureResult(
        `${toolName} has not been authorized on this account yet. Authorize it in Connections and ask again.`,
      );
    }
    if (answer.success === false || answer.output?.error) {
      return failureResult(`Arcade could not run ${toolName}.`);
    }
    const value = JSON.stringify(answer.output?.value ?? null, null, 2);
    /*
     * `JSON.stringify` ANSWERS `undefined` RATHER THAN THROWING for a value with no JSON form — a
     * function, a symbol — and `output.value` is the vendor's field while the `unknown` saying
     * anything may be there is ours. `??` does not catch it: a function is not nullish. Named here
     * so the refusal is this deployment's sentence rather than a `text.length` TypeError raised
     * inside {@link cap} and caught below as if Arcade had failed.
     */
    if (value === undefined) {
      return failureResult(
        `${toolName} ran, but its answer has no JSON form, so there is nothing to show.`,
      );
    }
    return { ...cap(value), isError: false };
  } catch (thrown) {
    const failure = arcadeFailure(thrown);
    if (failure && isAuthorizationRequired(failure)) {
      return failureResult(
        `${toolName} has not been authorized on this account yet. Authorize it in Connections and ask again.`,
      );
    }
    return failureResult(`Arcade could not run ${toolName}.`);
  }
}

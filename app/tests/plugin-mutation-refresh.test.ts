import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type MutationFunctionContext,
  MutationObserver,
  QueryClient,
} from "@tanstack/react-query";
import * as pluginMutations from "../src/lib/plugins/mutations";
import {
  addCuratedServerMutationOptions,
  addCustomServerMutationOptions,
  brokeredConnectionFieldsMutationOptions,
  confirmBrokeredConnectionMutationOptions,
  connectAccountMutationOptions,
  connectBrokeredWithFieldsMutationOptions,
  disconnectBrokeredMutationOptions,
  enableComposioAppMutationOptions,
  recheckBrokeredConnectionMutationOptions,
  refreshPluginServerMutationOptions,
  registerOAuthClientMutationOptions,
  removePluginServerMutationOptions,
  removeSkillMutationOptions,
  saveSkillMutationOptions,
  setPluginGrantMutationOptions,
} from "../src/lib/plugins/mutations";
import { pluginKeys } from "../src/lib/plugins/queries";

/**
 * What every plugin write does about the screen when the server says no.
 *
 * THE PROPERTY, STATED ONCE FOR A WHOLE FILE. Not one of these endpoints is atomic. Every one of
 * them writes — a row, an audit entry, a revoke at another company — and then does something else
 * that can fail, and Hono answers the failure with a status while the write stands. `POST /servers`
 * inserts the row and then refreshes its tools, and answers 409 when that refresh faults;
 * `POST /grants` upserts the grant and then files the trail row, and answers 500 when that insert
 * does; `DELETE /servers/:id/connection` revokes the account at Composio and then deletes the row.
 * A refusal from any of them is therefore NOT evidence that nothing changed, and a mutation that
 * refetched only on success left the screen asserting a state the deployment had already left.
 *
 * IT IS THE SAME DEFECT TWO REVIEWERS FOUND ON TWO ROUTES, and the reason it is tested here rather
 * than only where they found it: the shape is a property of the file, so a test per symptom would
 * have pinned two of fourteen and left the next one to be found the same way. Both of theirs are
 * below — a re-check the vendor refused, whose verdict the store wrote before raising, and a key
 * whose account Composio would not take back — beside the twelve that share their shape.
 *
 * THE STATUS EACH CASE SENDS IS THE ONE ITS OWN ROUTE SENDS, read off `server/src/plugins/routes.ts`
 * rather than chosen for convenience. A stub answering a shape a route cannot produce is what let
 * the two findings survive a review in the first place, and repeating that here would buy a green
 * file and nothing else.
 *
 * THROUGH A REAL `MutationObserver`, SO REACT QUERY DECIDES WHICH CALLBACKS RUN. Calling
 * `options.onSettled` by hand would pass against a file that merely declares the property, which is
 * not the question — the question is what happens to the screen when a press is refused.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * A deployment that refuses every request with the status the route under test really sends.
 *
 * A body with `error` on it, because that is the envelope `client` unwraps and the sentence a
 * person reads — and because a refusal with no readable reason is a different test.
 */
function refusing(status: number, message: string) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

/**
 * Drive one mutation to its refusal and report what it asked to be refetched.
 *
 * The rejection is swallowed here rather than allowed to fail the test: a refusal IS the case under
 * test, and what is being asserted is what the mutation did about the screen on its way out.
 */
async function refetchedOnRefusal<TVariables>(
  build: (queryClient: QueryClient) => unknown,
  variables: TVariables,
): Promise<unknown[]> {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const asked: unknown[] = [];
  const invalidate = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filters: never) => {
    asked.push(filters);
    return invalidate(filters);
  }) as typeof queryClient.invalidateQueries;

  const observer = new MutationObserver(
    queryClient,
    build(queryClient) as never,
  );
  let refused = false;
  await observer.mutate(variables as never).catch(() => {
    refused = true;
  });
  expect(refused).toBe(true);
  return asked;
}

/** What every one of these mutations has to ask for, and the only thing any of them asks for. */
const EVERY_PLUGIN_QUERY = [{ queryKey: pluginKeys.all }];

/**
 * The second argument react-query hands a `mutationFn`, for the one case below that calls one by hand.
 *
 * Spelled out rather than cast away, because `app/tests` sits outside `app/tsconfig.json` and
 * `bun test` does not typecheck — so a call written to the wrong arity here is a green test against
 * a signature that does not exist. None of these mutation functions reads it.
 */
function mutationContext(): MutationFunctionContext {
  return { client: new QueryClient(), meta: undefined };
}

/*
 * ONE CASE PER WRITE, AND THE STATUS IS EACH ROUTE'S OWN.
 *
 * 409 is `isDeploymentFault` on the admin routes that write a row and then refresh it. 500 is the
 * four routes with no catch at all, where the write lands and the audit insert behind it is what
 * throws. 502 is `brokerRefusal`'s generic arm on the brokered routes, and 400 is a refusal the
 * store itself authored — which on both brokered write paths is raised AFTER the row is written.
 */
const REFUSALS: {
  name: string;
  route: string;
  status: number;
  message: string;
  /**
   * THE FACTORY ITSELF, NOT A CLOSURE THAT CALLS ONE AND NOT ITS NAME AS A STRING.
   *
   * Because the completeness test below matches these against `mutations.ts`'s exported VALUES by
   * identity. A name written out here would be a third copy of the same list — the export, the
   * import at the top of this file, and a string — and a factory renamed at the source would leave
   * a case pointing at a name nothing exports, which is the failure mode this whole file is about.
   */
  factory: (queryClient: QueryClient) => unknown;
  variables: unknown;
}[] = [
  {
    name: "granting a plugin to a Bot",
    route: "POST /api/plugins/grants",
    status: 500,
    message: "That Agent could not be changed.",
    factory: setPluginGrantMutationOptions,
    variables: {
      agentId: "bot-1",
      granted: true,
      kind: "mcp" as const,
      ref: "linear/create_issue",
    },
  },
  {
    name: "withholding a plugin from a Bot",
    route: "DELETE /api/plugins/grants",
    status: 500,
    message: "That Agent could not be changed.",
    factory: setPluginGrantMutationOptions,
    variables: {
      agentId: "bot-1",
      granted: false,
      kind: "mcp" as const,
      ref: "linear/create_issue",
    },
  },
  {
    name: "adding a curated server",
    route: "POST /api/plugins/servers",
    status: 409,
    message: "That server was added but its tools could not be read.",
    factory: addCuratedServerMutationOptions,
    variables: { key: "linear" },
  },
  {
    name: "adding a server by URL",
    route: "POST /api/plugins/servers/custom",
    status: 409,
    message: "That server was added but its tools could not be read.",
    factory: addCustomServerMutationOptions,
    variables: {
      id: "in-house",
      title: "In house",
      url: "https://example.invalid/mcp",
    },
  },
  {
    name: "enabling a Composio app",
    route: "POST /api/plugins/composio/apps",
    status: 409,
    message:
      "The app was added, but its tools could not be read just now. Press Refresh on the Plugins page.",
    factory: enableComposioAppMutationOptions,
    variables: { slug: "linear" },
  },
  {
    name: "refreshing a server's tools",
    route: "POST /api/plugins/servers/:id/refresh",
    status: 409,
    message: "That server's tools could not be recorded.",
    factory: refreshPluginServerMutationOptions,
    variables: "linear",
  },
  {
    name: "removing a server",
    route: "DELETE /api/plugins/servers/:id",
    status: 409,
    message: "That server could not be removed.",
    factory: removePluginServerMutationOptions,
    variables: "linear",
  },
  {
    name: "saving a skill",
    route: "POST /api/plugins/skills",
    status: 500,
    message: "The skill could not be saved.",
    factory: saveSkillMutationOptions,
    variables: {
      instructions: "Do the thing.",
      slug: "triage",
      title: "Triage",
      tools: [],
    },
  },
  {
    name: "removing a skill",
    route: "DELETE /api/plugins/skills/:slug",
    status: 500,
    message: "That did not work.",
    factory: removeSkillMutationOptions,
    variables: "triage",
  },
  {
    name: "registering an OAuth client",
    route: "POST /api/plugins/servers/:id/oauth-client",
    status: 409,
    message: "That OAuth client could not be registered.",
    factory: registerOAuthClientMutationOptions,
    variables: {
      clientId: "abc",
      clientSecret: "shh",
      serverId: "linear",
    },
  },
  {
    name: "confirming a brokered connection",
    route: "POST /api/plugins/servers/:id/connection/confirm",
    status: 502,
    message: "Composio would not say whether this account is connected.",
    factory: confirmBrokeredConnectionMutationOptions,
    variables: "gmail",
  },
  {
    name: "disconnecting a brokered account",
    route: "DELETE /api/plugins/servers/:id/connection",
    status: 502,
    message: "Composio would not end this account, and gave no reason.",
    factory: disconnectBrokeredMutationOptions,
    variables: "gmail",
  },
  {
    name: "handing over a typed key",
    route: "POST /api/plugins/servers/:id/connect",
    status: 400,
    message:
      "What you entered for gmail did not work, and Composio would not take the account back either. Disconnect it on the Plugins page and try again.",
    factory: connectBrokeredWithFieldsMutationOptions,
    variables: {
      serverId: "gmail",
      values: { api_key: "wrong" },
    },
  },
  {
    name: "re-checking a key",
    route: "POST /api/plugins/servers/:id/connection/recheck",
    status: 400,
    message: "gmail would not answer with the key it is holding.",
    factory: recheckBrokeredConnectionMutationOptions,
    variables: "gmail",
  },
];

for (const refusal of REFUSALS) {
  test(`${refusal.name} refetches the plugin screens even when the write is refused`, async () => {
    refusing(refusal.status, refusal.message);
    expect(
      await refetchedOnRefusal(refusal.factory, refusal.variables),
    ).toEqual(EVERY_PLUGIN_QUERY);
  });
}

test("asking an app what it wants refetches nothing, because it writes nothing", async () => {
  /*
   * THE ONE WRITE-SHAPED PRESS THAT IS NOT A WRITE, and the reason this file does not simply say
   * "every mutation invalidates". The first press on an app whose key somebody types is a question
   * about the APP — `POST /connect` with no body — and the route answers it out of Composio's
   * published field list without touching a row. Nothing changed, so there is nothing to refetch,
   * and a refusal here is the same fact as a success: this deployment now knows no more than it did.
   *
   * Which is also why this factory takes no `QueryClient` at all. The property is structural rather
   * than a decision repeated in a callback: there is no client here to invalidate with.
   */
  refusing(502, "Composio would not say what Gmail asks for.");
  const options = brokeredConnectionFieldsMutationOptions();
  expect("onSuccess" in options).toBe(false);
  expect("onSettled" in options).toBe(false);
  await expect(
    options.mutationFn?.("gmail", mutationContext()),
  ).rejects.toThrow("Composio would not say what Gmail asks for.");
});

/**
 * The exported functions that are NOT a mutation factory at all, each with why.
 *
 * Named rather than filtered out by a rule about their shape, because "it does not look like a
 * mutation factory" is precisely the judgement that let a real one go uncovered: this file had no
 * case for `connectAccountMutationOptions` for two rounds and nothing anywhere said so.
 */
const NOT_A_MUTATION_FACTORY: Record<string, string> = {
  invalidatePlugins:
    "The refetch itself — the thing every case above asserts was asked for, not a press.",
  grantPlugin:
    "The bare write, for a caller granting a batch and refreshing once at the end. It carries no refetch on purpose, and the mutation that wraps it is covered above.",
};

/**
 * The mutation factories the property above does not apply to, each with why it does not.
 *
 * AN EXEMPTION IS A CLAIM AND IT IS WRITTEN DOWN AS ONE. Both of these are structural rather than a
 * decision somebody made in a callback — neither factory has a `QueryClient` to invalidate with —
 * so an exemption here can be checked against the code rather than taken on trust, and a factory
 * that grows a client later stops qualifying and has to move into `REFUSALS`.
 */
const NOT_A_REFUSABLE_WRITE: Record<string, string> = {
  brokeredConnectionFieldsMutationOptions:
    "Asks an app what it wants typed in. `POST /connect` with no body writes nothing on either outcome, and the factory takes no QueryClient. Its own test is above.",
  connectAccountMutationOptions:
    "Starts a consent connection and hands back the vendor's URL for the browser to leave for. Nothing on this screen survives that navigation to be refetched, and this factory takes no QueryClient either — it takes which screen to come back to.",
};

test("every mutation factory `mutations.ts` exports is answered for by this file", () => {
  /*
   * THE COMPLETENESS CHECK, AND THE REASON THIS FILE NEEDED ONE. Both sibling drift tests count
   * their roster against the declaration it mirrors; this one counted nothing, so a fifteenth
   * factory added to `mutations.ts` with `onSuccess` where `onSettled` belongs was a case nobody
   * wrote and nobody missed. Adding the count is what turned up `connectAccountMutationOptions`,
   * which had been exported and unanswered-for the whole time.
   *
   * READ OFF THE MODULE'S RUNTIME EXPORTS, not off a list of names in this file. A namespace import
   * is the one thing here that cannot fall behind the source: a factory added, renamed or deleted
   * changes this list on the next run. Every exported function has to land in exactly one of three
   * places — a refusal case, a declared exemption, or a declared non-factory — and membership of
   * the first is matched BY VALUE, so a rename cannot leave a case pointing at a ghost.
   *
   * `typeof value === "function"` is the whole of the filter DELIBERATELY, rather than a name
   * ending in `MutationOptions`. The types this module exports are erased and never reach here, so
   * the filter costs nothing; a factory named something else entirely still shows up, which a
   * suffix rule would have let through — and a suffix rule is a convention, which is the kind of
   * thing the next file breaks without noticing.
   */
  const exported = Object.entries(pluginMutations)
    .filter(([, value]) => typeof value === "function")
    .map(([name]) => name)
    .sort();

  const covered = new Set<unknown>(REFUSALS.map((refusal) => refusal.factory));
  const answeredFor = Object.entries(pluginMutations)
    .filter(
      ([name, value]) =>
        typeof value === "function" &&
        (covered.has(value) ||
          name in NOT_A_REFUSABLE_WRITE ||
          name in NOT_A_MUTATION_FACTORY),
    )
    .map(([name]) => name)
    .sort();

  expect(answeredFor).toEqual(exported);

  /*
   * AND NEITHER EXEMPTION LIST OUTLIVES WHAT IT EXEMPTS. An entry naming a function this module no
   * longer exports, or one a refusal case now covers, is a claim about nothing — and a stale
   * exemption is how a roster goes on looking complete while the thing it excused was quietly
   * replaced by something that does need a case.
   */
  const unclaimed = exported.filter(
    (name) => !covered.has((pluginMutations as Record<string, unknown>)[name]),
  );
  expect(
    [
      ...Object.keys(NOT_A_REFUSABLE_WRITE),
      ...Object.keys(NOT_A_MUTATION_FACTORY),
    ].sort(),
  ).toEqual(unclaimed);
});

/**
 * WHAT THESE WRITES PUT IN A URL, AND WHOSE TEXT IT IS.
 *
 * NONE OF THESE IDS IS THIS APP'S TO CHOOSE. A server id is whatever an administrator typed when
 * they added a server by URL, a skill slug is whatever somebody named a skill, and a brokered id is
 * Composio's own app slug. Interpolated raw, a `/` in one of them adds a path segment — so a
 * refresh of a server called `a/../b` is a POST to a route nobody meant, resolved by the URL parser
 * before any handler is reached — and a `?` turns the rest of the id into a query string, silently
 * truncating the id the route then looks up.
 *
 * REPORTED THREE TIMES AND CLASSED AS COSMETIC THREE TIMES, which is what the pair of tests below
 * is really about. The first is the behaviour, one case per write that puts a caller's text in a
 * URL; the second is the lever, because a roster of cases only ever covers the writes that existed
 * when somebody wrote it — and the defect here was one new line forgetting the call its ten
 * neighbours all make.
 */

/**
 * An id that is all three kinds of trouble at once, so one assertion answers for each of them.
 *
 * `/` re-segments the path, `?` truncates it into a query, and `#` truncates it again into a
 * fragment the server never receives. Encoded, it is one opaque segment and the route's own `:id`
 * catches exactly it.
 */
const HOSTILE_ID = "acme/../gmail?returnTo=admin#x";

/** The same id as a single path segment, which is what every URL below has to carry. */
const ENCODED_ID = encodeURIComponent(HOSTILE_ID);

/**
 * Drive one mutation and report the URLs it asked for.
 *
 * THROUGH A REAL `MutationObserver` for {@link refetchedOnRefusal}'s reason, and answering 200 for
 * one of its own: what is under test is the path a write builds, and a refusal would make every
 * case below have to say something about its rejection as well.
 */
async function requestedBy(
  build: (queryClient: QueryClient) => unknown,
  variables: unknown,
): Promise<string[]> {
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(typeof input === "string" ? input : String(input));
    return new Response("{}", {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const observer = new MutationObserver(
    queryClient,
    build(queryClient) as never,
  );
  await observer.mutate(variables as never).catch(() => undefined);
  return asked;
}

/**
 * One case per URL a caller's own text reaches, and the whole URL it has to produce.
 *
 * THE EXPECTATION IS THE FULL STRING rather than a `toContain`, because half of what an unencoded
 * id does is to the REST of the path: `.../servers/acme/../gmail/refresh` contains the id and is
 * not the route.
 */
const ENCODED_REQUESTS: {
  name: string;
  url: string;
  build: (queryClient: QueryClient) => unknown;
  variables: unknown;
}[] = [
  {
    name: "refreshing a server's tools",
    url: `/api/plugins/servers/${ENCODED_ID}/refresh`,
    build: refreshPluginServerMutationOptions,
    variables: HOSTILE_ID,
  },
  {
    name: "removing a server",
    url: `/api/plugins/servers/${ENCODED_ID}`,
    build: removePluginServerMutationOptions,
    variables: HOSTILE_ID,
  },
  {
    name: "registering an OAuth client",
    url: `/api/plugins/servers/${ENCODED_ID}/oauth-client`,
    build: registerOAuthClientMutationOptions,
    variables: { clientId: "abc", clientSecret: "shh", serverId: HOSTILE_ID },
  },
  {
    name: "starting a consent flow",
    url: `/api/plugins/servers/${ENCODED_ID}/connect?returnTo=settings`,
    build: () => connectAccountMutationOptions(),
    variables: HOSTILE_ID,
  },
  {
    name: "confirming a brokered connection",
    url: `/api/plugins/servers/${ENCODED_ID}/connection/confirm`,
    build: confirmBrokeredConnectionMutationOptions,
    variables: HOSTILE_ID,
  },
  {
    name: "disconnecting a brokered account",
    url: `/api/plugins/servers/${ENCODED_ID}/connection`,
    build: disconnectBrokeredMutationOptions,
    variables: HOSTILE_ID,
  },
  {
    name: "asking an app what it wants typed in",
    url: `/api/plugins/servers/${ENCODED_ID}/connect`,
    build: () => brokeredConnectionFieldsMutationOptions(),
    variables: HOSTILE_ID,
  },
  {
    name: "handing over a typed key",
    url: `/api/plugins/servers/${ENCODED_ID}/connect`,
    build: connectBrokeredWithFieldsMutationOptions,
    variables: { serverId: HOSTILE_ID, values: { api_key: "typed" } },
  },
  {
    name: "re-checking a key",
    url: `/api/plugins/servers/${ENCODED_ID}/connection/recheck`,
    build: recheckBrokeredConnectionMutationOptions,
    variables: HOSTILE_ID,
  },
  {
    name: "removing a skill",
    url: `/api/plugins/skills/${ENCODED_ID}`,
    build: removeSkillMutationOptions,
    variables: HOSTILE_ID,
  },
  {
    /*
     * The one write whose caller text goes in a QUERY rather than a path, and it takes the same
     * care: an unencoded `&` in a ref adds a parameter the route reads as one of its own. `kind`
     * beside it is not a caller's text — it is this module's own two-member union — which is why it
     * is one of the two interpolations the lever below lets through.
     */
    name: "withholding a plugin from a Bot",
    url: `/api/plugins/grants?kind=mcp&ref=${ENCODED_ID}&agentId=${ENCODED_ID}`,
    build: setPluginGrantMutationOptions,
    variables: {
      agentId: HOSTILE_ID,
      granted: false,
      kind: "mcp" as const,
      ref: HOSTILE_ID,
    },
  },
];

for (const request of ENCODED_REQUESTS) {
  test(`${request.name} keeps the id in one segment, whatever is in it`, async () => {
    expect(await requestedBy(request.build, request.variables)).toEqual([
      request.url,
    ]);
  });
}

test("every id these writes interpolate into a URL goes through encodeURIComponent", () => {
  /*
   * THE LEVER, AND WHY THE ROSTER ABOVE IS NOT ENOUGH ON ITS OWN. A case list covers the writes
   * that existed when it was written, and the defect it is about is a new one forgetting what its
   * neighbours do. There is no way to enumerate from the outside every path a module MIGHT build —
   * the roster is that attempt, and it can only ever be a list — but every interpolation the file
   * contains can be enumerated, and that is the set this asks the question of.
   *
   * THE MODULE BUILDS ITS URLS NOWHERE ELSE: no base, no join helper, no concatenation. So every
   * backticked string beginning `/api/` is the whole surface rather than a sample of it, and this
   * assumption is itself pinned by the count below.
   */
  const source = readFileSync(
    join(import.meta.dir, "../src/lib/plugins/mutations.ts"),
    "utf8",
  );
  const paths = [...source.matchAll(/`(\/api\/[^`]*)`/g)].map(
    (match) => match[1] ?? "",
  );
  /*
   * AND THE ROSTER ABOVE IS THE SAME SET, COUNTED. A path with nothing interpolated into it is a
   * plain quoted string in this module and is not matched here at all, so every path this finds
   * carries somebody's text and has a case above naming the URL it must produce. A new interpolated
   * path added with no case beside it fails here, which is what keeps the roster from quietly
   * becoming a sample.
   */
  expect(paths.length).toBe(ENCODED_REQUESTS.length);

  /*
   * THE TWO NAMES THAT MAY GO IN RAW, AND WHY NEITHER IS A CALLER'S TEXT. `variables.kind` is
   * `PluginKind` and `returnTo` is `"settings" | "admin"` — two closed unions this module declares
   * itself, each narrowed again by the server before it decides anything. Anything else in this
   * position is somebody's typed id, and there are exactly two ways for one of those to be safe:
   * the call this test is named for, or a new entry here that somebody had to argue for.
   */
  const closedUnions = ["variables.kind", "returnTo"];

  const raw = paths.flatMap((path) =>
    [...path.matchAll(/\$\{([^}]*)\}/g)]
      .map((match) => (match[1] ?? "").trim())
      .filter(
        (interpolation) =>
          !interpolation.startsWith("encodeURIComponent(") &&
          !closedUnions.includes(interpolation),
      ),
  );

  expect(raw).toEqual([]);
});

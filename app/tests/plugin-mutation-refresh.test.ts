import { afterEach, expect, test } from "bun:test";
import {
  type MutationFunctionContext,
  MutationObserver,
  mutationOptions,
  QueryClient,
} from "@tanstack/react-query";
import { authorizeActionMutationOptions } from "../src/lib/plugins/grants";
import {
  accountModePreview,
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
  setAccountModeMutationOptions,
  setOwnerGrantsMutationOptions,
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
  {
    name: "switching a server's account mode",
    route: "PUT /api/plugins/servers/:id/account-mode",
    status: 500,
    message: "The switch did not finish, and nothing was changed.",
    factory: setAccountModeMutationOptions,
    variables: {
      serverId: "linear",
      mode: "shared" as const,
    },
  },
  {
    name: "choosing who may give an app to a Bot",
    route: "PUT /api/plugins/servers/:id/owner-grants",
    status: 404,
    message: "That app hasn't been added.",
    factory: setOwnerGrantsMutationOptions,
    variables: { serverId: "linear", ownerGrants: "admin" as const },
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
 * WHAT THESE WRITES PUT IN A URL, AND WHOSE TEXT IT IS.
 *
 * NONE OF THESE IDS IS THIS APP'S TO CHOOSE. A server id is whatever an administrator typed when
 * they added a server by URL, a skill slug is whatever somebody named a skill, and a brokered id is
 * Composio's own app slug. Interpolated raw, a `/` in one of them adds a path segment — so a
 * refresh of a server called `a/../b` is a POST to a route nobody meant, resolved by the URL parser
 * before any handler is reached — and a `?` turns the rest of the id into a query string, silently
 * truncating the id the route then looks up.
 *
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
    name: "previewing an account mode switch",
    url: `/api/plugins/servers/${ENCODED_ID}/account-mode`,
    build: () =>
      mutationOptions({
        mutationFn: (variables: {
          serverId: string;
          mode: "personal" | "shared";
        }) => accountModePreview(variables.serverId, variables.mode),
      }),
    variables: { serverId: HOSTILE_ID, mode: "shared" as const },
  },
  {
    name: "switching a server's account mode",
    url: `/api/plugins/servers/${ENCODED_ID}/account-mode`,
    build: setAccountModeMutationOptions,
    variables: { serverId: HOSTILE_ID, mode: "shared" as const },
  },
  {
    name: "choosing who may give an app to a Bot",
    url: `/api/plugins/servers/${ENCODED_ID}/owner-grants`,
    build: setOwnerGrantsMutationOptions,
    variables: { serverId: HOSTILE_ID, ownerGrants: "any" as const },
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

/**
 * Where the vendor's callback puts somebody down is the caller's to say, and only the default was
 * ever pinned.
 *
 * The roster above drives both consent starts with no argument, so `?returnTo=settings` is all any
 * assertion in this file has ever seen. A body that ignored its parameter and wrote `settings`
 * itself would pass every one of them — and the defect that hides is an administrator who presses
 * Connect on the connector's admin page, finishes consent at the vendor, and is put down in their
 * own personal settings: the round trip the inline row exists to remove. One call each, with the
 * value the default cannot be confused with.
 */
test("the consent starts carry the screen they were started from", async () => {
  expect(
    await requestedBy(() => connectAccountMutationOptions("admin"), HOSTILE_ID),
  ).toEqual([`/api/plugins/servers/${ENCODED_ID}/connect?returnTo=admin`]);

  expect(
    await requestedBy(() => authorizeActionMutationOptions("admin"), {
      serverId: HOSTILE_ID,
      action: "GMAIL_SEND_EMAIL",
    }),
  ).toEqual([`/api/plugins/servers/${ENCODED_ID}/authorize?returnTo=admin`]);
});

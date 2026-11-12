---
name: openbot-data-access
description: Governs how the OpenBot browser app reads and writes server data. An operation in api/openapi.yaml is called only through the client generated from it (app/src/lib/api/generated), anything else through `client` in app/src/lib/client.ts; every read is a queryOptions factory in app/src/lib/<entity>/queries.ts, every write a mutationOptions factory in app/src/lib/<entity>/mutations.ts, consumed through useQuery/useMutation. Use when adding or changing a screen that loads server data, calling a /api/... endpoint from the browser, changing api/openapi.yaml, adding a query key, writing a create/update/delete flow, deciding where a fetch belongs, or reviewing a diff that contains the word fetch under app/src. Don't use for server-side route handlers under server/ (that is not browser code), for form validation schemas (those live in lib/<entity>/form.ts), for page layout and Item rows, or for the AG-UI stream itself, which the runtime carries rather than the client.
---

# OpenBot Data Access

## When To Use

This skill applies to any change under `app/src` that moves data between the browser and the API
server. It fires on new screens, new endpoints, new query keys, on any change to `api/openapi.yaml`,
and on any diff that introduces `fetch` anywhere but `app/src/lib/client.ts`.

It does not cover server handlers under `server/`, zod form schemas (`lib/<entity>/form.ts`), or page
layout. It does cover `lib/copilot/`: the conversation itself streams over AG-UI, but the tool calls a
Bot makes during a turn are ordinary authenticated requests and go through the client like everything
else.

## API First

OpenBot's API is described in `api/openapi.yaml` (OpenAPI 3.1), and that file is the single source of
truth: the browser's client, its types, the server's types, the docs and the contract tests all come
from it. It follows CopilotKit Intelligence's v2 conventions so the two read as one API: every
resource under `/api/v2/organizations/{organizationId}/`, errors as `application/problem+json`, lists
paged with `cursor` and `limit` (answering `nextCursor`), and an `Idempotency-Key` on every write.

Resources move into the spec one at a time. Bots are in it (list, create, read, change, delete);
everything else is still reached the older way, through `client`, until its turn. So there are two
kinds of request, and which one a call is depends only on whether its operation is in the spec:

1. **An operation in the spec** is called through the function Orval generated for it
   (`listBots`, `createBot`, …, in `@/lib/api/generated/<tag>/<tag>`), with types from
   `@/lib/api/generated/model`. Never `client(path, …)`, never a hand-written type for its payload.
2. **Anything else** goes through `client` exactly as described below.

The generated functions all run through `apiRequest` in `lib/api/request.ts` (Orval's mutator), which
is built on `clientRequest` in `lib/client.ts`: the same session cookie, and a refusal is the same
`ClientError` carrying the server's own sentence (`error` today, `detail` in problem details) or the
`fallback` the caller passes. A screen cannot tell which kind of request it made.

The generated code is checked in. CI regenerates it and fails when it differs, lints the spec, and
fails a pull request that breaks a client of the base branch's spec (oasdiff).

## The Shape

Every entity the browser knows about owns a directory under `app/src/lib/`:

```
api/openapi.yaml           # the contract
app/src/lib/
  client.ts                # the only fetch in the app
  api/
    request.ts             # Orval's mutator: apiRequest, ORGANIZATION_ID, idempotencyKey()
    served-today.ts        # where today's server answers a spec operation, until it serves /api/v2
    generated/             # Orval's output: functions, hooks, types, Zod schemas, MSW handlers
  <entity>/
    queries.ts   # read types, key factory, queryOptions factories
    mutations.ts # input type, mutationOptions factories
    form.ts      # zod schema (a different skill's territory)
```

`client.ts` owns the transport: credentials, the JSON content type, body serialisation, and turning a
failed status into an `Error` carrying the server's own message. It owns nothing about meaning — the
envelope key and the sentence a person reads stay at the call site, because those are facts about one
endpoint rather than about requests in general.

```ts
client<T>(path, key, options?): Promise<T>    // parsed, and `key` unwrapped
client(path, options?): Promise<Response>     // for a caller that only needed it to work
tryClient(path, options?): Promise<Response>  // never throws; the status is the answer
```

`options` is `{ method?, body?, fallback?, signal? }`. `body` is serialised by the client, which is
also what sets the content type — so a caller passes an object, never a string. Passing
`JSON.stringify(x)` sends a JSON string of a JSON string, which no endpoint accepts.

### Three kinds of request

Not everything crossing the wire is cached state, and the shape follows from which kind it is.

1. **A cached read** is a `queryOptions` factory in `queries.ts`. It has a key, and something can
   invalidate it.
2. **A write somebody asked for** is a `mutationOptions` factory in `mutations.ts`. It invalidates on
   success.
3. **Everything else is a plain exported function**, living beside the factories for its entity.
   A verdict about this moment (`decideComponent`, `testAgentConnection`), a tool call during a
   Bot's turn (`callPluginTool`, the computer control surface), a frame of a screen, a step inside
   another write (`storeMcpToken`). These fail closed and return a value rather than throwing,
   because a refusal is usually the answer. Giving one a cache key would create a key nothing reads
   and an invalidation nothing triggers.

The third kind still lives under `lib/`. It is not licence to call the server from a component.

There are thirteen of these today — `agents`, `audit`, `auth`, `channels`, `components`, `computers`,
`connectors`, `credentials`, `package`, `plugins`, `sandboxed`, `skills`, `copilot`. They all look the
same on purpose. `lib/agents/queries.ts` and `lib/agents/mutations.ts` are the reference pair; read them
before writing a new one.

**The one rule that matters:** a React component never calls `fetch`. If a component file contains
`fetch`, the change is wrong regardless of whether it works.

**And its companion:** a component never imports from `lib/api/generated` either. The generated
functions are called from the entity's factories, which give the result the entity's own cache key.
The generated `use*` hooks and `get*QueryOptions` key their cache by URL, which no `<entity>Keys.all`
invalidation reaches, so a screen on a generated hook shows a second, stale copy of data the
factories already hold.

## Procedures

### Procedure 0: Add or change an operation in the spec

1. Write it in `api/openapi.yaml` first, before any client or server code. Copy the shape of an
   operation already there: the shared `OrganizationId`, `Limit`, `Cursor` and `IdempotencyKey`
   parameters, a `Problem` response for every 4xx and 5xx, `security` naming who may call it. Describe
   what the server does; never invent a field it does not return.
2. `bun run api:lint`. It refuses a path outside `/api/v2/organizations/{organizationId}/`, a path
   Intelligence already serves (`api/intelligence-reserved.yaml`), a write with no `Idempotency-Key`,
   an error that is not problem details, and a list that does not page.
3. `bun run api:generate`, and commit the spec and `app/src/lib/api/generated` together. Never edit a
   generated file: change the spec and generate again.
4. Call the new function from the entity's factory (Procedures 1 and 2): pass `ORGANIZATION_ID`, a
   `fallback` sentence, and on a write `{ "Idempotency-Key": idempotencyKey() }`. Unwrap the
   envelope (`.bot`, `.bots`) in the factory, so components see the payload. A list reads every page
   until `nextCursor` is null (`everyBot` in `lib/agents/queries.ts`).
5. Make the entity's type the generated one (`export type AgentProfile = Bot`), so the browser's type
   and the spec cannot drift. Test fixtures typed with it then need every field the spec requires.
6. If today's server still answers the operation at an older address, add it to the table in
   `lib/api/served-today.ts`: its address there and how to put its answer in the spec's shape. That
   table goes, entry by entry, as the back end serves `/api/v2` itself.
7. Changing a published operation: removing or renaming a field, making a request field required, or
   removing an operation fails CI's breaking-change check. Add instead: a new optional field, a new
   operation.

### Procedure 1: Add a read

1. Create or open `app/src/lib/<entity>/queries.ts`.
2. Declare the browser-shaped type for the payload — `<Entity>Profile`, `<Entity>Status`,
   `<Entity>Summary`, or `<Entity>Record`, matching whichever sibling name fits. This type describes
   what the browser receives, not what the database stores.
3. Include the server's authorization verdicts as fields on that type (`canManage`, `systemOwned`,
   `mine`, `hasAuth`) and document them. The browser renders these flags; it never recomputes
   ownership or permission rules from other fields.
4. Never put a secret's value in a read type. A credential is `hasAuth: boolean` or a
   `revokedAt` timestamp. Secrets are write-only in this codebase.
5. Add or extend the key factory, named `<entity>Keys`:

   ```ts
   export const agentKeys = {
     all: ["agents"] as const,
     list: (hidden = false) => ["agents", "list", { hidden }] as const,
     detail: (agentId: string) => ["agents", "detail", agentId] as const,
   };
   ```

   `all` is always the bare entity name and is the invalidation root. List keys carry their
   parameters as a trailing object so two filters are two cache entries. Every array is `as const`.
   A single-key entity still gets a factory: `export const packageKeys = { active: ["tenant-package", "active"] as const };`.

6. Export a factory function returning `queryOptions({ queryKey, queryFn })`, named
   `<subject>QueryOptions`. Existing spellings: `agentListQueryOptions`, `agentQueryOptions`,
   `agentComponentsQueryOptions`, `activePackageQueryOptions`.
7. Inside `queryFn`, call the generated function when the operation is in the spec (Procedure 0,
   step 4):

   ```ts
   queryFn: async (): Promise<AgentProfile> =>
     (await getBot(ORGANIZATION_ID, agentId, { fallback: "Couldn't load this Bot." })).bot,
   ```

   Otherwise call `client` with the path, the envelope key, and a `fallback` sentence. It
   sends the credentials, checks the status, raises the server's message when there is one, and
   unwraps the key so the caller receives the payload rather than the wrapper:

   ```ts
   queryFn: (): Promise<AgentProfile[]> =>
     client("/api/agents", "agents", { fallback: "Could not load coworkers" }),
   ```

   Where the whole body is the payload, omit the key and read it: `(await client(path, { fallback
   })).json()`. Where a failed status is an *answer* rather than an error — a refused component call,
   a 401 that means "not signed in" — use `tryClient` and read the status.

8. Annotate the `queryFn` return type explicitly (`(): Promise<AgentProfile[]>`). `client` is generic
   in its payload, so the annotation is what fixes what the key unwraps to.

### Procedure 2: Add a write

1. Create or open `app/src/lib/<entity>/mutations.ts`.
2. Declare the input type as `<Entity>Input` — the shape the API accepts, which is not the form's
   shape. Mapping between them is `form.ts`'s job (`agentInputFrom`).
3. Call the generated function when the operation is in the spec, with a fresh `Idempotency-Key`
   for each write a person asks for:

   ```ts
   mutationFn: async (input: AgentInput): Promise<AgentProfile> =>
     (await createBot(ORGANIZATION_ID, input, { "Idempotency-Key": idempotencyKey() }, {
       fallback: FALLBACK,
     })).bot,
   ```

   `idempotencyKey()`, never `crypto.randomUUID()`: the latter exists only in a secure context, and a
   self-hosted OpenBot opened at a plain-HTTP address is not one.

   Otherwise call `client`. Do **not** write a per-entity request helper — `agentRequest`,
   `componentRequest` and two others each owned a private copy of the same credentials, headers and
   error extraction, and one of the four had quietly dropped the extraction. `client` owns it now:

   ```ts
   mutationFn: (input: AgentInput): Promise<AgentProfile> =>
     client("/api/agents", "agent", { method: "POST", body: input, fallback: FALLBACK }),
   ```

   Where the write returns nothing a caller needs, omit the key and `await client(path, { ... })`.
   Keep one `const FALLBACK` per file rather than repeating the sentence: the reader of the failure
   cares which entity failed, and within one file that never changes.

4. Export one factory per write, named `<verb><Entity>MutationOptions(queryClient)`, returning
   `mutationOptions({ mutationFn, onSuccess })`. Existing spellings: `createAgentMutationOptions`,
   `updateAgentMutationOptions`, `duplicateAgentMutationOptions`, `setAgentHiddenMutationOptions`,
   `deleteAgentMutationOptions`.
5. Give `mutationFn` exactly one parameter. For a single value that is the value
   (`agentId: string`); for more than one it is a named `variables` object
   (`{ agentId: string; input: AgentInput }`).
6. Invalidate on success — never patch the cache by hand:

   ```ts
   onSuccess: () => queryClient.invalidateQueries({ queryKey: agentKeys.all })
   ```

   With several writes in one file, wrap that in a private `invalidate<Entity>(queryClient)` helper.
   Server-derived fields are the reason: a hand-patched cache entry is a guess at what the server
   decided, and it is wrong the first time the server adds a rule.
7. `queryClient.removeQueries` instead of `invalidateQueries` when the data should stop existing
   rather than be refetched. Sign-out is the only current case
   (`lib/auth/mutations.ts`).
8. A fire-and-forget write takes no `queryClient` and has no `onSuccess`
   (`recordChannelActivityMutationOptions`). Deliberate, and it carries a comment saying why the
   failure is acceptable. Do not reach for this to avoid writing error handling.

### Procedure 3: Consume from a component

1. Import the factories, never the endpoint — and import the `queryClient`, never call
   `useQueryClient()`:

   ```ts
   import { queryClient } from "@/query-client";

   const credentials = useQuery(credentialListQueryOptions());
   const createCredential = useMutation(createCredentialMutationOptions(queryClient));
   ```

2. **`useQueryClient()` is not the convention here.** There is exactly one client: constructed at
   module scope in `app/src/query-client.ts` and handed to both `QueryClientProvider` and the router
   context in `main.tsx`. The hook therefore resolves to the same object the import already holds,
   at the cost of a hook call and a `const` line. The import also works where a hook cannot — a
   plain event handler, a module with no component around it, a test — which is why mutation
   factories take a `QueryClient` parameter rather than reaching for the hook themselves.
3. Import with the `@/` alias — `@/lib/credentials/queries`, not `../../../lib/credentials/queries`.
   Both spellings exist in the tree today; the alias is the correct one.
4. Branch on all four states in order, every time — pending, error, empty, rows — and never
   dereference `data` without having handled the first three:

   ```tsx
   {credentials.isPending ? null : credentials.error ? (
     <p className="text-destructive text-sm" role="alert">Could not load credentials.</p>
   ) : credentials.data?.length === 0 ? (
     <PageEmpty>No credentials are configured.</PageEmpty>
   ) : (
     <PageRows>{/* rows */}</PageRows>
   )}
   ```

5. **The pending branch renders nothing.** OpenBot has no loading placeholder — no "Loading…"
   text, no spinner, no skeleton, no shimmer. The section's heading is already on screen; what
   arrives underneath it is the answer, and a placeholder that appears and vanishes inside a
   local round-trip is a flicker rather than information. A few screens still carry
   `<PageEmpty>Loading …</PageEmpty>` and one carries a `Skeleton` block, both from before this
   decision. They are not the pattern to copy.
6. `isPending` is still branched on, and branched on **first**. Deleting the branch instead of
   returning `null` from it would show the empty-state sentence — "No credentials are
   configured." — for the whole duration of the fetch, which states something false.
7. This says nothing about mutations. A button the person just pressed still says `"Saving…"` or
   `"Deleting…"`, because that is feedback for an action they took rather than a placeholder for
   data they are waiting on. Derive it from the mutation, not from `useState`:
   `disabled={... || createCredential.isPending}`.
8. Read `credentials.tsx` in `app/src/routes/_authed/admin/` for the whole pattern end to end —
   with the caveat that its pending branch still renders text.

### Procedure 4: Preload in a route

1. When data gates navigation, load it in `beforeLoad` with `ensureQueryData` and the same options
   factory the component uses:

   ```ts
   const user = await context.queryClient.ensureQueryData(currentUserQueryOptions());
   if (!user) throw redirect({ to: "/sign" });
   ```

2. The factory is shared between the guard and the component on purpose — one key, one fetch, and
   the component's `useQuery` is already warm.
3. Authorization decided here, not inside a component (`routes/_authed.tsx`,
   `routes/_authed/admin/route.tsx`).
4. Inside `beforeLoad` and `loader`, use `context.queryClient` — the router's typed handle, and the
   same singleton `main.tsx` put there. No import needed at those two call sites; everywhere else,
   import it.

### Procedure 5: Test a screen against the spec

1. Existing tests stub `global.fetch` at today's addresses (`/api/agents`), and keep working: the
   generated client reaches those through `served-today.ts`, as the app does.
2. To prove a screen reads and writes through the generated client, serve it the spec's own mocks:
   `setupServer(...get<Tag>Mock())` from `@/lib/api/generated/<tag>/<tag>.msw`, with
   `todayRoutes.on = false` for the file (restored in `afterAll`) and happy-dom given a page address
   (`GlobalRegistrator.register({ url: "http://openbot.invalid/" })`) so relative requests resolve.
   `app/tests/bots-generated-client.test.tsx` is the reference.
3. Use `msw` 2. MSW 3 intercepts at Node's socket layer, which Bun's `fetch` does not go through, so
   under `bun test` its handlers never run.
4. To prove the spec describes what the server answers, run the real route handlers behind the
   generated client and parse each answer with the generated Zod schema
   (`app/tests/bots-api-today.test.ts`).

## Decision Tree

- Adding or changing an operation the API should offer → Procedure 0 first, then 1 or 2.
- Adding a screen that displays server data → Procedure 1, then Procedure 3.
- Adding a create, update, delete, or toggle → Procedure 2, then Procedure 3.
- The data decides whether the person is allowed on the page at all → Procedure 4.
- Changing an existing payload's shape → Procedure 1, step 2, and check every consumer of the type.
- Filtering or paginating an existing list → Procedure 1, step 5: a new parameter goes in the
  trailing object of the list key, not into a second key factory.
- The data is form input rather than server state → not this skill; `lib/<entity>/form.ts`.
- The data arrives over the CopilotKit runtime → not this skill; `lib/copilot/`.

## Red Flags

| Signal | What it means | Do instead |
|--------|---------------|------------|
| `fetch(` anywhere but `lib/client.ts` | Either the read has no key and nothing can invalidate it, or the transport has been rewritten by hand | Move it into `lib/<entity>/` behind a factory, and call `client` |
| `client("/api/agents…")` for an operation that is in `api/openapi.yaml` | A second, hand-written path to something the generated client already reaches | Call the generated function (`getBot`, `updateBot`, …) |
| A hand-written type for a payload the spec describes | Drifts from the contract the first time the spec changes | `import type { Bot } from "@/lib/api/generated/model"` |
| An edit inside `app/src/lib/api/generated` | Overwritten by the next `api:generate`, and CI's drift check fails | Change `api/openapi.yaml`, then `bun run api:generate` |
| A component importing `@/lib/api/generated` or calling a generated `use*` hook | A second cache keyed by URL that no `<entity>Keys` invalidation reaches | Call the entity's factory |
| A write with no `Idempotency-Key`, or one built with `crypto.randomUUID()` | The spec requires one; `randomUUID` throws outside a secure context | `{ "Idempotency-Key": idempotencyKey() }` |
| A new path whose first name after the organization is one Intelligence serves (threads, memories, projects, learning-…) | Two servers answering one address | Pick another name; `api/intelligence-reserved.yaml` lists Intelligence's |
| A module-private `<entity>Request` helper | Superseded. Four of these existed and one had lost its `body.error` extraction | Call `client` |
| `client` on an endpoint whose refusal is an answer | Turns the boundary working into an exception the caller has to catch | `tryClient`, and read the status |
| `body: JSON.stringify(x)` at a call site | Double-encoded; the client serialises | Pass the object |
| A one-shot tool call written as a `mutationOptions` factory | Gets a `queryClient` and an invalidation it has no use for | A plain function beside the factories |
| A `fallback` sentence repeated on every write in a file | The reader cares which entity failed, and that does not change within a file | One `const FALLBACK` per file |
| `<PageEmpty>Loading …</PageEmpty>`, a spinner, or a `Skeleton` while a query is pending | OpenBot uses no loading placeholder; the flicker costs more than the reassurance buys | Return `null` from the pending branch |
| The pending branch deleted rather than returning `null` | The empty-state sentence shows for the length of the fetch, asserting something false | Keep the branch, first in the chain, returning `null` |
| `const queryClient = useQueryClient()` | A hook call and a local binding for an object that is one import away, and unavailable outside a component | `import { queryClient } from "@/query-client"` |
| `new QueryClient()` anywhere outside `app/src/query-client.ts` | A second cache; queries written by one client are invisible to the other | Import the singleton. A test needing isolation constructs its own and passes it explicitly |
| `useQuery({ queryKey: ["agents"], ... })` at a call site | An inline key drifts from the factory and silently stops matching invalidations | Call the factory: `useQuery(agentListQueryOptions())` |
| `queryClient.setQueryData(...)` after a mutation | Guesses at server-derived fields; wrong the moment the server adds a rule | `invalidateQueries({ queryKey: <entity>Keys.all })` |
| A component computing `user.role === "admin" && thing.ownerId === user.id` | Duplicates an authorization rule that the server already decided | Render the server's flag (`canManage`, `mine`) |
| A read type carrying a token, key, or `plaintext` | Secrets are write-only in OpenBot | Expose `hasAuth: boolean` or a `revokedAt` timestamp |
| A hand-written `body.error` extraction | `client` already does it, and did it more consistently than the four copies did | Pass `fallback` and let it raise |
| `queryFn` returning `{ agents: [...] }` | Leaks the transport envelope into every component | Unwrap in the `queryFn`; components see the array |
| A second `<entity>Keys` object, or keys defined in `mutations.ts` | Two sources of truth for one cache namespace | One factory per entity, in `queries.ts`; `mutations.ts` imports it |

## Error Handling

- **A 401 in a `queryFn`**: `client` sends the credentials, so a 401 means the session expired — the
  `_authed` guard handles the redirect on the next navigation. Do not add per-query redirect logic.
  The one place a 401 is expected is `currentUserQueryOptions`, which uses `tryClient` because not
  being signed in is an answer there rather than a failure.
- **The server returns no `error` field**: `client` falls back to the `fallback` option. Name the
  entity in it ("Could not load coworkers"). Do not print a status code to a person.
- **A refusal arrives as a thrown `Error` instead of a value**: the call site used `client` where it
  needed `tryClient`. The gateway declining is the product working, not a fault.
- **The server rejects a body it should accept, or reads it as a string**: something stringified
  before handing it over. `client` serialises; a caller passes the object.
- **An invalidation does not refresh the list**: the key at the call site does not match the key the
  mutation invalidated. Both must come from the same `<entity>Keys` factory. Check for an inline key
  array before anything else.
- **Two filters of the same list overwrite each other's cache**: the parameter is missing from the
  list key. Add it to the trailing object (`list: (hidden = false) => [..., { hidden }]`).
- **A mutation succeeds but the screen shows stale server-derived fields**: something patched the
  cache instead of invalidating it. Remove the patch.
- **TypeScript cannot infer the `queryFn` return**: the explicit `Promise<T>` annotation is missing
  from the `queryFn` signature. Add it rather than casting at the call site.
- **"No X are configured." flashes before the list appears**: the pending branch is missing, or it
  sits after the empty check. It goes first and returns `null`.
- **A query is slow enough that the blank feels broken**: the answer is not a placeholder, it is a
  slow endpoint. Fix the endpoint, or preload the data in the route (Procedure 4) so the screen is
  not entered until it is there.
- **A mutation factory is needed where no hook can run** — a bare event handler, a module with no
  component around it, a `bun test` file: import `queryClient` from `app/src/query-client.ts` and
  pass it in. This is the reason the singleton is the convention rather than the hook.
- **An invalidation appears to do nothing and the keys do match**: two clients exist. Search for
  `new QueryClient(` outside `app/src/query-client.ts`.
- **Unsure which entity directory a new endpoint belongs to**: name it after the noun the URL is
  about (`/api/agents/:id/plugins` is `plugins`, keyed by agent). If no existing directory fits,
  create one with the same three-file shape rather than adding the read to a neighbour.

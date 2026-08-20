---
name: openbot-data-access
description: Governs how the OpenBot browser app reads and writes server data — every read is a queryOptions factory in app/src/lib/<entity>/queries.ts, every write is a mutationOptions factory in app/src/lib/<entity>/mutations.ts, and components consume them through useQuery/useMutation. Use when adding or changing a screen that loads server data, calling a /api/... endpoint from the browser, adding a query key, writing a create/update/delete flow, deciding where a fetch belongs, or reviewing a diff that contains the word fetch under app/src. Don't use for server-side route handlers under server/ (that is not browser code), for form validation schemas (those live in lib/<entity>/form.ts), for page layout and Item rows, or for CopilotKit runtime traffic under lib/copilot/ which is streamed by the runtime rather than fetched.
---

# OpenBot Data Access

## When To Use

This skill applies to any change under `app/src` that moves data between the browser and the API
server. It fires on new screens, new endpoints, new query keys, and on any diff that introduces
`fetch` outside `app/src/lib/<entity>/`.

It does not cover server handlers under `server/`, zod form schemas (`lib/<entity>/form.ts`), page
layout, or the CopilotKit runtime surface under `lib/copilot/`, which streams over AG-UI rather
than fetching.

## The Shape

Every entity the browser knows about owns a directory under `app/src/lib/`:

```
app/src/lib/<entity>/
  queries.ts     # read types, key factory, queryOptions factories
  mutations.ts   # input type, request helper, mutationOptions factories
  form.ts        # zod schema (a different skill's territory)
```

There are twelve of these today — `agents`, `audit`, `auth`, `channels`, `components`,
`connectors`, `credentials`, `package`, `plugins`, `sandboxed`, and so on. They all look the same on
purpose. `lib/agents/queries.ts` and `lib/agents/mutations.ts` are the reference pair; read them
before writing a new one.

**The one rule that matters:** a React component never calls `fetch`. If a component file contains
`fetch`, the change is wrong regardless of whether it works.

## Procedures

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
7. Inside `queryFn`: `fetch` with `credentials: "include"`, check `response.ok`, throw an
   `Error` with a sentence a person could read, and **unwrap the envelope** so the caller receives
   the payload rather than the wrapper:

   ```ts
   if (!response.ok) throw new Error("Could not load coworkers");
   return ((await response.json()) as { agents: AgentProfile[] }).agents;
   ```

8. Annotate the `queryFn` return type explicitly (`async (): Promise<AgentProfile[]>`). It is what
   makes the unwrap type-safe.

### Procedure 2: Add a write

1. Create or open `app/src/lib/<entity>/mutations.ts`.
2. Declare the input type as `<Entity>Input` — the shape the API accepts, which is not the form's
   shape. Mapping between them is `form.ts`'s job (`agentInputFrom`).
3. If the file will hold more than one write, add a single module-private request helper that owns
   `credentials`, headers, and error extraction. `agentRequest` in `lib/agents/mutations.ts` is the
   model. Error extraction surfaces **the server's** message, because that is the one naming the
   field or the permission that failed:

   ```ts
   const message = await response
     .json()
     .then((body: { error?: string }) => body.error)
     .catch(() => undefined);
   throw new Error(message ?? "Coworker operation failed");
   ```

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

## Decision Tree

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
| `fetch(` in a file under `components/` or `routes/` | The read has no key, so nothing can invalidate it | Move it into `lib/<entity>/queries.ts` behind a `queryOptions` factory |
| `<PageEmpty>Loading …</PageEmpty>`, a spinner, or a `Skeleton` while a query is pending | OpenBot uses no loading placeholder; the flicker costs more than the reassurance buys | Return `null` from the pending branch |
| The pending branch deleted rather than returning `null` | The empty-state sentence shows for the length of the fetch, asserting something false | Keep the branch, first in the chain, returning `null` |
| `const queryClient = useQueryClient()` | A hook call and a local binding for an object that is one import away, and unavailable outside a component | `import { queryClient } from "@/query-client"` |
| `new QueryClient()` anywhere outside `app/src/query-client.ts` | A second cache; queries written by one client are invisible to the other | Import the singleton. A test needing isolation constructs its own and passes it explicitly |
| `useQuery({ queryKey: ["agents"], ... })` at a call site | An inline key drifts from the factory and silently stops matching invalidations | Call the factory: `useQuery(agentListQueryOptions())` |
| `queryClient.setQueryData(...)` after a mutation | Guesses at server-derived fields; wrong the moment the server adds a rule | `invalidateQueries({ queryKey: <entity>Keys.all })` |
| A component computing `user.role === "admin" && thing.ownerId === user.id` | Duplicates an authorization rule that the server already decided | Render the server's flag (`canManage`, `mine`) |
| A read type carrying a token, key, or `plaintext` | Secrets are write-only in OpenBot | Expose `hasAuth: boolean` or a `revokedAt` timestamp |
| `catch { throw new Error("Something went wrong") }` | Discards the server's message, which is the one naming the field that failed | Extract `body.error` and fall back to a specific sentence |
| A `fetch` without `credentials: "include"` | The session cookie is not sent; it fails as a 401 that reads like a bug | Add it; every request in this app is authenticated |
| `queryFn` returning `{ agents: [...] }` | Leaks the transport envelope into every component | Unwrap in the `queryFn`; components see the array |
| A second `<entity>Keys` object, or keys defined in `mutations.ts` | Two sources of truth for one cache namespace | One factory per entity, in `queries.ts`; `mutations.ts` imports it |

## Error Handling

- **A 401 in a `queryFn`**: check `credentials: "include"` first. If present, the session expired —
  the `_authed` guard handles the redirect on the next navigation. Do not add per-query redirect
  logic.
- **The server returns no `error` field**: keep the `?? "…"` fallback sentence and name the entity
  in it ("Could not load coworkers"). Do not print a status code to a person.
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

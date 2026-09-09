import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { Route as AgentsRoute } from "@/routes/_authed/_app/agents/index";
import { Route as HomeRoute } from "@/routes/_authed/_app/index";

/**
 * Both agent-facing screens read the same `agentListQueryOptions()` query, and both drew their
 * empty state on a FAILED query, not just an empty one: `isPending` (what each screen branches on)
 * goes false on failure exactly as it does on success, so a broken fetch fell through to "you have
 * nothing" and told somebody who may own twenty coworkers that they own none.
 *
 * THE HARNESS IS THIS REPOSITORY'S. `GlobalRegistrator` in `beforeAll`/`afterAll`, `cleanup` in
 * `afterEach`, and queries off `render()`'s own return, matching `proposed-bot-card.test.tsx` for
 * the reason recorded there: bun walks every file into one process, and a document another file
 * tore down mid-run fails invisibly.
 *
 * Each test builds its own `QueryClient` with `retry: false` — the app's own client (see
 * `query-client.ts`) retries once, which is correct for production and would just slow this test
 * down for no assertion it needs. Both screens are exercised through their real, exported `Route`,
 * not a stand-in; see `renderAgents` below for what that costs on `/agents`.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;

beforeEach(() => {
  // Every read in this app goes through `client()` in `lib/client.ts`, which throws once the
  // response is not `ok`. A 500 with no body is the shape a broken server actually sends, and is
  // exactly what `client()`'s fallback message path exists for.
  global.fetch = (async () =>
    new Response(null, { status: 500 })) as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

/** A client the failing query settles on in one attempt, so the test does not wait on a retry. */
function failingQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

/**
 * A client that already holds a successful `agents` list under the exact key
 * `agentListQueryOptions()` reads (`agentKeys.list(false)`, the default `hidden` param both
 * screens call it with), built on `failingQueryClient()` so the one refetch it triggers on mount
 * settles without a retry.
 *
 * Combined with the always-failing `global.fetch` this file's `beforeEach` installs, mounting a
 * screen against this client reproduces a failed BACKGROUND refetch: TanStack Query's default
 * `refetchOnMount` fires a fetch immediately because `staleTime` is unset (0), that fetch hits the
 * mocked 500, and `isError` becomes true while `data` — per query-core's error action, which
 * spreads `...state` and never touches `data` — stays exactly this seeded roster. No fake timers or
 * queryFn stand-in are needed: seeding the cache and letting the real, already-mocked fetch fail is
 * the whole scaffold.
 */
function staleQueryClient(agents: AgentProfile[]) {
  const queryClient = failingQueryClient();
  queryClient.setQueryData(agentKeys.list(false), agents);
  return queryClient;
}

/** A minimal but complete `AgentProfile`, overridable per test. */
function agent(
  overrides: Partial<AgentProfile> & { id: string },
): AgentProfile {
  return {
    name: "Agent",
    title: "Title",
    roleDescription: "Role",
    avatarSeed: "seed",
    visibility: "private",
    endpoint: null,
    builtIn: true,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    systemOwned: false,
    canManage: true,
    mine: true,
    ...overrides,
  };
}

/** Waits for the seeded query to have actually failed its background refetch, rather than trusting
 *  that the seeded data alone (which would render identically before any fetch ran) proves it. */
async function waitForFailedRefetch(queryClient: QueryClient) {
  await waitFor(() => {
    expect(queryClient.getQueryState(agentKeys.list(false))?.status).toBe(
      "error",
    );
  });
}

/**
 * `findByText`'s own default wait is 1000ms, and `/` additionally mounts the heavy rich-text
 * `Composer` on top of the roster query this file already exercises, so a render on `/` is
 * measurably slower than its `/agents` twin. Under load that gap crosses 1000ms and the default
 * times out around 1010ms — not a logic bug (data is never cleared or corrupted through the error
 * transition; this was checked with a `Profiler`), just too little headroom for a busy machine. Do
 * not remove this as a redundant-looking argument: every `findByText` in a test that renders `/`
 * needs it, and `/agents`-only tests do not, because they never mount `Composer`.
 */
const HOME_FIND_TIMEOUT = { timeout: 5000 };

/** `/`'s component makes no `Route.useSearch()` / `Route.useNavigate()` call of its own, so mounting
 *  it directly as a memory router's root is enough — no ancestor chain to reconstruct. */
function renderHome(queryClient: QueryClient) {
  const rootRoute = createRootRoute({ component: HomeRoute.options.component });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/**
 * `/agents`'s component calls `Route.useSearch()` and `Route.useNavigate()`, which read `this.id`
 * off the very `Route` singleton the source file exports — so, unlike `/`, a bare root standing in
 * for it is not enough; those hooks fail to resolve a match unless that exact object is present in
 * the router's tree with the id it expects.
 *
 * That id is not a free choice: `Route.useSearch()`/`useNavigate()` read it from `this.id`, which
 * TanStack Router computes by walking `getParentRoute()` up to the root and joining each ancestor's
 * own id, so it is fixed by the file's real position — `/_authed/_app/agents/` for a leaf declared
 * `createFileRoute("/_authed/_app/agents/")` under pathless `_authed`/`_app` parents. Reproducing
 * that with two throwaway pathless routes (`id`-only, no `path`, so they contribute nothing to the
 * URL — exactly what `_authed`/`_app` do) is enough for the join to land on the same id; it does not
 * require the real ancestors, whose `beforeLoad` checks a signed-in session and whose components
 * mount the sidebar shell and the Copilot provider — none of which this test is about.
 *
 * The real `Route` singleton is `.update()`d in place to attach to this decoy chain, because
 * `Route.useSearch()`/`useNavigate()` are bound to the one object the source module exports — there
 * is no way to hand the component a stand-in. `beforeEach`/`afterEach` capture and restore its
 * *entire own state* — not just `options`, and not by replaying it through `.update()` — around each
 * render, so a real router built elsewhere in this same bun process (there is exactly one:
 * `router.test.ts`, which never inspects this route) is never left pointed at the decoy.
 *
 * A restore that merely replayed the captured `options` through `.update()` would not work: the
 * installed `update()` (`@tanstack/router-core@1.171.27`'s `dist/esm/route.js`) is
 * `Object.assign(this.options, options); return this;` — a merge. `Object.assign` only overwrites
 * or adds keys, it never deletes one, so merging a snapshot that predates this file's `id`/`path`/
 * `getParentRoute` back on top leaves those decoy keys sitting in `options` untouched. Worse,
 * `update()` never touches the *derived* state `router.js`'s `buildRouteTree()` computes by calling
 * `route.init({ originalIndex })` once per route each time a router is built (`_id`, `_path`,
 * `_fullPath`, `_to`, `parentRoute`, `originalIndex`) — those stay pinned to whatever this file's own
 * `createRouter()` last resolved them to, decoy parent included, since nothing re-runs `init()` on
 * `.update()`. The only restore that actually undoes a render is a full replace: snapshot every own
 * property up front (with `options` itself shallow-cloned, since `update()` mutates that very object
 * in place rather than replacing it) and, afterward, delete whatever the render added and reassign
 * the rest verbatim.
 */
function captureRouteState(route: object): Record<string, unknown> {
  return { ...route, options: { ...(route as { options: object }).options } };
}

function restoreRouteState(
  route: object,
  snapshot: Record<string, unknown>,
): void {
  for (const key of Object.keys(route)) {
    if (!(key in snapshot)) {
      delete (route as Record<string, unknown>)[key];
    }
  }
  Object.assign(route, snapshot);
}

/**
 * Captured exactly once, at module scope, the instant this line of top-level code runs — which is
 * before any `test()` body in this file has had a chance to run. That timing, not any claim about
 * the route being untouched, is what makes this the right fixed point.
 *
 * It is deliberately NOT described as "pristine in the absolute". `AgentsRoute` gains its derived
 * keys (`_id`, `_fullPath`, `parentRoute`, ...) when `route.init()` runs, which `createRouter()`
 * triggers — and that is NOT confined to this file: `app/src/router.tsx` calls `createRouter()` at
 * module top level over the generated `routeTree`, which contains this very route, so merely
 * importing it initialises `AgentsRoute`. `app/tests/router.test.ts` imports it, and bun runs every
 * file in one process, so depending on file order this constant may capture a route that the real
 * router has already initialised.
 *
 * That is fine, and it is the point: what this has to restore is the state the route was in before
 * THIS file interfered with it, whatever that state was. Either way the rest of the process gets
 * back exactly what it had. A snapshot taken in `beforeEach` instead — as this used to do — would
 * be reading the *live*, already-rendered-on `AgentsRoute` from test two onward, which is exactly
 * how a broken `restoreRouteState` (one that merges but never deletes the stray keys a render adds)
 * went undetected: each test's "before" picture already had last test's leak baked in as normal.
 *
 * `captureRouteState` is called again on this constant, rather than using it directly, everywhere
 * below it is needed. `restoreRouteState`'s `Object.assign(route, snapshot)` step aliases
 * `route.options` to `snapshot.options` — not a clone — and `Route.update()` mutates `this.options`
 * in place. Handing the very same object out of every `beforeEach` would let the next render's
 * `.update()` mutate this "pristine" constant through that alias, corrupting the one fixed point
 * this whole scheme depends on. Re-running it through `captureRouteState` produces a fresh
 * `options` clone each time, so the constant itself is never written to after this line.
 */
const pristineAgentsRouteState = captureRouteState(AgentsRoute);

let agentsRouteSnapshot: Record<string, unknown>;

beforeEach(() => {
  agentsRouteSnapshot = captureRouteState(pristineAgentsRouteState);
});

afterEach(() => {
  restoreRouteState(AgentsRoute, agentsRouteSnapshot);
});

function renderAgents(queryClient: QueryClient) {
  const rootRoute = createRootRoute({ component: Outlet });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const appRoute = createRoute({
    id: "/_app",
    getParentRoute: () => authedRoute,
    component: Outlet,
  });
  const wired = (
    AgentsRoute as unknown as {
      update: (options: unknown) => typeof AgentsRoute;
    }
  ).update({
    id: "/agents/",
    path: "/agents/",
    getParentRoute: () => appRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([appRoute.addChildren([wired])]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: ["/agents"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("a failed roster on /agents reports the failure, not an empty roster", async () => {
  const view = renderAgents(failingQueryClient());

  expect(await view.findByText("Your agents couldn't be loaded.")).toBeTruthy();
  expect(
    await view.findByText("Agents shared with you couldn't be loaded."),
  ).toBeTruthy();

  // The whole point: a person with agents must never be told they have none because the request
  // that would have proven otherwise never came back.
  expect(view.queryByText("You don't have any agents created.")).toBeNull();
  expect(
    view.queryByText("Nobody has shared an agent with you yet."),
  ).toBeNull();
});

test("a failed roster on / reports the failure and explains the disabled composer", async () => {
  const view = renderHome(failingQueryClient());

  expect(
    await view.findByText(
      "Agents shared with you couldn't be loaded.",
      {},
      HOME_FIND_TIMEOUT,
    ),
  ).toBeTruthy();
  expect(
    view.queryByText("Nobody has shared an agent with you yet."),
  ).toBeNull();

  // The composer goes `disabled={!fallback}` on the very same failure, with nothing on screen
  // saying why unless this alert renders.
  expect(
    await view.findByText(
      "Your coworkers couldn't be loaded, so there's no one to send this to yet.",
      {},
      HOME_FIND_TIMEOUT,
    ),
  ).toBeTruthy();
});

test("both /agents sections hold a skeleton while the roster is pending, not an empty state", async () => {
  // A fetch that never settles is `isPending` forever — the state each section's loading arm
  // renders once the router has finished its own (also async) initial match, which is why this
  // still waits rather than reading `view.container` on the very next line.
  global.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;

  const view = renderAgents(failingQueryClient());

  const skeletons = await waitFor(() => {
    const found = view.container.querySelectorAll('[data-slot="skeleton"]');
    expect(found.length).toBe(2);
    return found;
  });
  expect(skeletons.length).toBe(2);

  // A skeleton sitting beside a premature empty or error sentence would be no fix at all: the
  // point is that loading reserves the section's height instead of claiming an answer it doesn't
  // have yet.
  expect(view.queryByText("You don't have any agents created.")).toBeNull();
  expect(
    view.queryByText("Nobody has shared an agent with you yet."),
  ).toBeNull();
  expect(view.queryByText("Your agents couldn't be loaded.")).toBeNull();
  expect(
    view.queryByText("Agents shared with you couldn't be loaded."),
  ).toBeNull();
});

/*
 * The three tests above all exercise a query that has NEVER succeeded: `isPending` and `isError`
 * both come from a first attempt. TanStack Query keeps a query's last good `data` across a failed
 * BACKGROUND refetch — the library's own comment on that code path reads "flag existing data as
 * invalidated if we get a background error" — so `isError === true` beside a perfectly good,
 * previously-loaded roster is an ordinary state, not the one the tests above cover. Both screens
 * used to let `failed` outrank the populated-list check regardless of which of these two `isError`
 * causes produced it, which replaced a working roster with an error card, and on `/` also showed an
 * alert claiming the composer had nothing to send to while it was, in fact, still enabled.
 */
test("a failed REFETCH on /agents keeps the roster it already had, not the error", async () => {
  const mine = agent({ id: "mine-1", name: "Mine Agent", mine: true });
  const shared = agent({
    id: "shared-1",
    name: "Shared Agent",
    mine: false,
    visibility: "public",
  });
  const queryClient = staleQueryClient([mine, shared]);

  const view = renderAgents(queryClient);
  await waitForFailedRefetch(queryClient);

  expect(await view.findByText("Mine Agent")).toBeTruthy();
  expect(await view.findByText("Shared Agent")).toBeTruthy();
  expect(view.queryByText("Your agents couldn't be loaded.")).toBeNull();
  expect(
    view.queryByText("Agents shared with you couldn't be loaded."),
  ).toBeNull();
});

test("a failed REFETCH on / keeps the roster and does not disclaim the composer", async () => {
  const shared = agent({
    id: "shared-1",
    name: "Shared Agent",
    mine: false,
    visibility: "public",
  });
  const queryClient = staleQueryClient([shared]);

  const view = renderHome(queryClient);
  await waitForFailedRefetch(queryClient);

  expect(
    await view.findByText("Shared Agent", {}, HOME_FIND_TIMEOUT),
  ).toBeTruthy();
  // Only renders while `fallback` is set, which the retained roster still supplies — the direct
  // evidence that the composer is not the disabled, nothing-to-send-to state its alert describes.
  expect(
    await view.findByText(
      "Sent to the coworker it is for.",
      { exact: false },
      HOME_FIND_TIMEOUT,
    ),
  ).toBeTruthy();
  expect(
    view.queryByText(
      "Your coworkers couldn't be loaded, so there's no one to send this to yet.",
    ),
  ).toBeNull();
  expect(
    view.queryByText("Agents shared with you couldn't be loaded."),
  ).toBeNull();
});

/*
 * A failed REFETCH can also land on cache that is ASYMMETRIC: one slice populated, its sibling
 * genuinely empty. `?.length` cannot tell "loaded, and this slice is empty" apart from "never
 * loaded" — both read as falsy — so gating the destructive arm on `failed` alone (once the
 * populated-list check above it doesn't fire) puts the "couldn't be loaded" card on the empty
 * sibling, right beside a section rendering real cards from that very same query. The real cards
 * are the proof: the response came back, and this slice of it is just empty.
 */
test("a failed REFETCH on /agents with one empty slice shows it as empty, not broken", async () => {
  const mine = agent({ id: "mine-1", name: "Mine Agent", mine: true });
  const queryClient = staleQueryClient([mine]);

  const view = renderAgents(queryClient);
  await waitForFailedRefetch(queryClient);

  expect(await view.findByText("Mine Agent")).toBeTruthy();
  expect(
    await view.findByText("Nobody has shared an agent with you yet."),
  ).toBeTruthy();
  expect(
    view.queryByText("Agents shared with you couldn't be loaded."),
  ).toBeNull();
});

test("a failed REFETCH on /agents with the other slice empty also shows it as empty", async () => {
  const shared = agent({
    id: "shared-1",
    name: "Shared Agent",
    mine: false,
    visibility: "public",
  });
  const queryClient = staleQueryClient([shared]);

  const view = renderAgents(queryClient);
  await waitForFailedRefetch(queryClient);

  expect(await view.findByText("Shared Agent")).toBeTruthy();
  expect(
    await view.findByText("You don't have any agents created."),
  ).toBeTruthy();
  expect(view.queryByText("Your agents couldn't be loaded.")).toBeNull();
});

test("a failed REFETCH on / with explore empty shows it as empty, not broken", async () => {
  const mine = agent({ id: "mine-1", name: "Mine Agent", mine: true });
  const queryClient = staleQueryClient([mine]);

  const view = renderHome(queryClient);
  await waitForFailedRefetch(queryClient);

  expect(
    await view.findByText(
      "Nobody has shared an agent with you yet.",
      {},
      HOME_FIND_TIMEOUT,
    ),
  ).toBeTruthy();
  expect(
    view.queryByText("Agents shared with you couldn't be loaded."),
  ).toBeNull();
  // `agents` loaded (it holds "Mine Agent"), so `fallback` falls back to it and the composer is
  // enabled — the alert claiming a load failure must not appear beside that working composer.
  expect(
    view.queryByText(
      "Your coworkers couldn't be loaded, so there's no one to send this to yet.",
    ),
  ).toBeNull();
});

/**
 * Proves the restore itself, rather than trusting the doc comment above it: it drives
 * `captureRouteState`/`restoreRouteState` directly, sandwiched around a corruption that reproduces
 * both halves of what `renderAgents` does to the singleton — the `.update()` merge that plants
 * `id`/`path`/`getParentRoute`, and the `route.init()` call `createRouter()` makes for every route in
 * a tree it builds, which is what actually derives `_id`/`_fullPath`/`_to`/`parentRoute` from those
 * options. Checking inside a test's own body can never observe what that test's own `afterEach` did
 * — the hook has not run yet at that point — so this calls `restoreRouteState` itself rather than
 * waiting on a hook, which observes the exact same restore path `afterEach` uses without depending on
 * bun's cross-test hook ordering.
 *
 * `before` is `pristineAgentsRouteState`, not a fresh `captureRouteState(AgentsRoute)` read here.
 * This test runs last, after every `renderAgents()`-driven test before it has already rendered on
 * (and had its `afterEach` "restore") the live singleton; reading `AgentsRoute` at this point trusts
 * that every prior restore actually worked, which is the very thing under test here. Comparing
 * against the one snapshot taken before any router ever touched the route is what turns a leaked key
 * into a visible diff instead of two contaminated pictures agreeing with each other.
 */
test("restoring after a decoy render leaves no trace on the exported Route singleton", () => {
  const before = captureRouteState(pristineAgentsRouteState);

  const decoyParentRoute = { id: "/_app", fullPath: "/" };
  const route = AgentsRoute as unknown as {
    update: (options: unknown) => unknown;
    init: (opts: { originalIndex: number }) => void;
  };
  route.update({
    id: "/agents/",
    path: "/agents/",
    getParentRoute: () => decoyParentRoute,
  });
  route.init({ originalIndex: 0 });

  // Sanity check: the corruption actually took, so the restore below proves something.
  expect((AgentsRoute as { parentRoute: unknown }).parentRoute).toBe(
    decoyParentRoute,
  );

  restoreRouteState(AgentsRoute, before);

  expect(captureRouteState(AgentsRoute)).toEqual(before);
});

/**
 * The test above compares one `captureRouteState` snapshot against another. That is only as
 * trustworthy as `captureRouteState`'s own `options` clone and `beforeEach`'s own re-clone off
 * `pristineAgentsRouteState` — and this file has now shipped three separate breakages that drop
 * one of those two clones. Each one aliases `pristineAgentsRouteState.options` to the live route's
 * `options` object, so `Route.update()`'s in-place mutation reaches the "pristine" constant too.
 * Once that happens, `before`'s own `options` in the test above is read off the very same corrupted
 * constant that `AgentsRoute` gets restored to, so the two sides of that `toEqual` are corrupted in
 * lockstep and agree with each other anyway — the assertion goes tautological and the suite stays
 * green with the pristine constant silently ruined for the rest of the process.
 *
 * The only way to catch that is to anchor to something the corruption itself cannot drag along: an
 * object-identity check against `pristineAgentsRouteState` itself, and a second identity check
 * against a decoy value created fresh inside THIS test — neither is derived from
 * `pristineAgentsRouteState` or `agentsRouteSnapshot` the way `before` is, so neither can be dragged
 * into the corruption alongside them.
 *
 * The second anchor is deliberately NOT "these key names must be absent from `options`" (`id`,
 * `path`, `getParentRoute`), even though those are the very keys this test's own decoy `.update()`
 * plants: `app/src/routeTree.gen.ts` calls the REAL `AgentsRoute.update({ id: '/agents/', path:
 * '/agents/', getParentRoute: () => AuthedAppRoute })` too, as part of wiring the real app router —
 * see `app/src/router.tsx`. Whenever this file shares a bun process with anything that imports that
 * real router (e.g. `router.test.ts`, or any component test that mounts the real app shell), those
 * exact key names are legitimately present in the pristine state this file must restore, so
 * asserting their bare absence goes red on correct code the moment file ordering changes — the very
 * "not pristine in the absolute" trap `pristineAgentsRouteState`'s own doc comment warns about.
 * Anchoring to a function reference this test just created sidesteps that: no real code, past or
 * future, can ever hold a reference to it.
 *
 * This test drives the exact same decoy-and-restore sequence as the one above, but reads
 * `agentsRouteSnapshot` — the real module-scope variable this test's own `beforeEach` already
 * populated, the same one the real `afterEach` restores through — rather than taking a fresh
 * snapshot of its own, so it is exercising the actual hook wiring rather than a stand-in for it.
 */
test("the pristine snapshot's options is never the live route's, and a restore leaves no decoy behind — checked by identity, not against another snapshot", () => {
  const decoyParentRoute = { id: "/_app", fullPath: "/" };
  const decoyGetParentRoute = () => decoyParentRoute;
  const route = AgentsRoute as unknown as {
    update: (options: unknown) => unknown;
    init: (opts: { originalIndex: number }) => void;
  };
  route.update({
    id: "/agents/",
    path: "/agents/",
    getParentRoute: decoyGetParentRoute,
  });
  route.init({ originalIndex: 0 });

  restoreRouteState(AgentsRoute, agentsRouteSnapshot);

  const liveOptions = (
    AgentsRoute as unknown as {
      options: { getParentRoute?: unknown };
    }
  ).options;

  // Anchor 1 — identity, not a snapshot: the constant this whole file's restore promise rests on
  // must never be the very object `Route.update()` writes into, restore or no restore.
  expect(pristineAgentsRouteState.options).not.toBe(liveOptions);

  // Anchor 2 — identity against a value created fresh in this test, not a snapshot and not a key
  // name: no real caller, past or future, can ever hold a reference to this closure, so its
  // survival past the restore is unambiguous corruption either way.
  expect(liveOptions.getParentRoute).not.toBe(decoyGetParentRoute);
});
